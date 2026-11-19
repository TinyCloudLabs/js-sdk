// Downloads the pinned `tinycloud` node tarball and places the executable.
//
// Order of operations, each step failing closed:
//   1. HTTPS only; redirects only to GitHub's release hosts (NODE_DOWNLOAD_HOSTS).
//   2. Stream to a private staging file next to the destination, hashing as it
//      arrives, never reading past the pinned size.
//   3. Compare size and SHA-256 with the pin. Nothing is decompressed before
//      this passes.
//   4. Read the archive with our own tar reader and write exactly one member,
//      `tinycloud-node-<target>/tinycloud`. Any entry that is a link, a device,
//      an absolute or `..` path, or outside the archive root rejects the whole
//      archive. The system `xz` (found only at fixed absolute paths, never via
//      PATH) only decompresses; it never writes files.
//   5. Re-hash the staged executable from disk and compare it with the pinned
//      executable hash, so the decompressor is not part of what is trusted.
//   6. chmod 0755 and rename onto the destination; a failed run leaves the
//      previous file untouched.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants, createReadStream, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rename, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createGunzip } from "node:zlib";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import {
  NODE_ARTIFACT_MAX_BYTES,
  NODE_BINARY_MAX_BYTES,
  nodeArchiveMember,
  nodeArchiveRoot,
  type NodeArchivePin,
  type NodeArtifact,
} from "./node-release.js";

/**
 * The only hosts a download, or a redirect of one, may touch. github.com answers
 * with a redirect to `release-assets.githubusercontent.com` today (observed for
 * v1.21.0); `objects.githubusercontent.com` is its earlier host. Integrity comes
 * from the pin, not from these hosts.
 */
export const NODE_DOWNLOAD_HOSTS: readonly string[] = [
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];

const MAX_REDIRECTS = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
/** Decompressed tar bytes allowed. The real archive unpacks to about 47 MB. */
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_BINARY_BYTES = NODE_BINARY_MAX_BYTES;
const MAX_METADATA_BYTES = 64 * 1024;
const TAR_BLOCK = 512;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Fixed places `xz` is looked up. Never `PATH`: an empty or relative entry, a
 * writable directory, or `node_modules/.bin` would let another program stand in
 * for the decompressor.
 */
export const XZ_LOCATIONS: readonly string[] = ["/usr/bin/xz", "/bin/xz", "/usr/local/bin/xz", "/opt/homebrew/bin/xz"];

interface TransferOptions {
  /** Transport. Defaults to the global `fetch`; the policy checks run on the URLs regardless. */
  fetchImpl?: FetchLike;
  /** Absolute path of the decompressor for `.tar.xz` archives. Defaults to the first of `xzCandidates` that exists. */
  xzBinary?: string;
  /** Where to look for `xz` when `xzBinary` is unset. Absolute paths only; others are ignored. */
  xzCandidates?: readonly string[];
  /** Abort if no bytes arrive for this long. */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface FetchNodeBinaryOptions extends TransferOptions {
  artifact: NodeArtifact;
  /** Final path of the executable. Its directory is created if missing. */
  destination: string;
}

export interface MeasureNodeBinaryOptions extends TransferOptions {
  artifact: NodeArchivePin;
}

export interface FetchedNodeBinary {
  destination: string;
  archiveSha256: string;
  archiveSize: number;
  binarySha256: string;
  binarySize: number;
}

const downloadError = (code: string, message: string) => new CLIError(code, message, ExitCode.NETWORK_ERROR);
const unsafeArchive = (message: string) => new CLIError("NODE_ARCHIVE_UNSAFE", `Refusing node archive: ${message}`, ExitCode.ERROR);
const invalidArchive = (message: string) => new CLIError("NODE_ARCHIVE_INVALID", `Invalid node archive: ${message}`, ExitCode.ERROR);

/** `FileHandle.write` can write fewer bytes than asked (disk full, quota, file-size limit); keep going until all are down. */
export async function writeFully(handle: Pick<FileHandle, "write">, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    if (bytesWritten <= 0) {
      throw new CLIError("NODE_WRITE_FAILED", "Could not write the node download to disk: no progress (disk full?)", ExitCode.ERROR);
    }
    offset += bytesWritten;
  }
}

async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), size };
}

/** Absolute path of a usable `xz`. An explicit path must be absolute; otherwise only the fixed candidates are tried. */
function resolveXz(explicit: string | undefined, candidates: readonly string[] = XZ_LOCATIONS): string {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) {
      throw new CLIError("NODE_UNPACK_TOOL_REJECTED", "The xz path must be absolute; PATH is never searched", ExitCode.ERROR);
    }
    return explicit;
  }
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const info = statSync(candidate);
      // A world-writable file is not a place to trust a decompressor from.
      if (!info.isFile() || (info.mode & 0o002) !== 0) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; try the next location.
    }
  }
  throw new CLIError(
    "NODE_UNPACK_TOOL_MISSING",
    `Unpacking the node archive needs xz at one of ${candidates.join(", ")} (install xz-utils or xz)`,
    ExitCode.ERROR,
  );
}

/** Parse and vet a download URL. Only the host is ever shown: redirect targets carry signed query strings. */
function checkDownloadUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CLIError("NODE_DOWNLOAD_URL_REJECTED", "Refusing node download: not a valid URL", ExitCode.ERROR);
  }
  if (
    url.protocol !== "https:" ||
    !NODE_DOWNLOAD_HOSTS.includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443")
  ) {
    throw new CLIError(
      "NODE_DOWNLOAD_URL_REJECTED",
      `Refusing node download from ${url.protocol}//${url.host}: only https://${NODE_DOWNLOAD_HOSTS.join(" and https://")} are allowed`,
      ExitCode.ERROR,
    );
  }
  return url;
}

function checkArtifact(artifact: NodeArchivePin): "xz" | "gz" {
  const { pathname } = checkDownloadUrl(artifact.url);
  if (!SHA256_RE.test(artifact.sha256)) {
    throw new CLIError("NODE_RELEASE_INVALID", "Node artifact sha256 must be 64 lowercase hex characters", ExitCode.ERROR);
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > NODE_ARTIFACT_MAX_BYTES) {
    throw new CLIError("NODE_RELEASE_INVALID", `Node artifact size must be between 1 and ${NODE_ARTIFACT_MAX_BYTES} bytes`, ExitCode.ERROR);
  }
  if (pathname.endsWith(".tar.xz")) return "xz";
  if (pathname.endsWith(".tar.gz")) return "gz";
  throw new CLIError("NODE_RELEASE_INVALID", "Node artifact must be a .tar.xz or .tar.gz archive", ExitCode.ERROR);
}

/**
 * Download `artifact` into `file` and verify size and SHA-256 against the pin.
 * The file is only trustworthy if this resolves.
 */
async function downloadArchive(
  artifact: NodeArchivePin,
  file: string,
  fetchImpl: FetchLike,
  idleTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(downloadError("NODE_DOWNLOAD_TIMEOUT", `Node download stalled for ${idleTimeoutMs / 1000}s`)),
      idleTimeoutMs,
    );
  };
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  try {
    touch();
    let url = checkDownloadUrl(artifact.url);
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const current = await fetchImpl(url.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/octet-stream", "accept-encoding": "identity", "user-agent": "tinycloud-cli" },
      });
      if (![301, 302, 303, 307, 308].includes(current.status)) {
        response = current;
        break;
      }
      await current.body?.cancel();
      const location = current.headers.get("location");
      if (!location) throw downloadError("NODE_DOWNLOAD_FAILED", `Node download redirected from ${url.host} without a location`);
      url = checkDownloadUrl(new URL(location, url).href);
      touch();
    }
    if (!response) throw downloadError("NODE_DOWNLOAD_FAILED", `Node download redirected more than ${MAX_REDIRECTS} times`);
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw downloadError("NODE_DOWNLOAD_FAILED", `Node download from ${url.host} failed with HTTP ${response.status}`);
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      await response.body.cancel();
      throw downloadError("NODE_DOWNLOAD_FAILED", `Node download used unexpected content-encoding ${encoding}`);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) !== artifact.size) {
      await response.body.cancel();
      throw downloadError(
        Number(declared) > artifact.size ? "NODE_DOWNLOAD_TOO_LARGE" : "NODE_DOWNLOAD_FAILED",
        `Node download declares ${declared} bytes; the pin expects ${artifact.size}`,
      );
    }

    const hash = createHash("sha256");
    let received = 0;
    const out = await open(file, "wx", 0o600);
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        touch();
        received += value.byteLength;
        if (received > artifact.size) {
          await reader.cancel();
          throw downloadError("NODE_DOWNLOAD_TOO_LARGE", `Node download exceeds the pinned size of ${artifact.size} bytes`);
        }
        hash.update(value);
        await writeFully(out, value);
      }
      await out.sync();
      if ((await out.stat()).size !== received) {
        throw new CLIError("NODE_WRITE_FAILED", "The node download was not written to disk completely", ExitCode.ERROR);
      }
    } finally {
      await out.close();
    }
    if (received !== artifact.size) {
      throw downloadError("NODE_DOWNLOAD_FAILED", `Node download was truncated: received ${received} of ${artifact.size} bytes`);
    }
    const actual = hash.digest("hex");
    if (actual !== artifact.sha256) {
      throw new CLIError(
        "NODE_ARTIFACT_INTEGRITY",
        `Node archive SHA-256 does not match the pin in this CLI (expected ${artifact.sha256}, got ${actual}); nothing was installed`,
        ExitCode.ERROR,
      );
    }
  } catch (error) {
    if (error instanceof CLIError) throw error;
    // An abort surfaces as the reason we passed (a CLIError above) or the caller's own.
    // Transport errors can quote the request URL, and redirect URLs carry signed query strings.
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\S+:\/\/\S+/g, "<url>");
    throw downloadError("NODE_DOWNLOAD_FAILED", `Node download failed: ${reason}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Decompressed bytes of a `.tar.xz`, via `xz -dc` (at an absolute path) reading the verified file on stdin. */
async function* xzChunks(file: string, xzPath: string): AsyncGenerator<Buffer> {
  // Scrubbed environment, no PATH: XZ_OPT/XZ_DEFAULTS must not influence the decoder.
  const child = spawn(xzPath, ["-d", "-c"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { LC_ALL: "C" },
  });
  const closed = once(child, "close");
  closed.catch(() => {});
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    if (stderr.length < 512) stderr += data.toString("utf8", 0, 512);
  });
  createReadStream(file).on("error", () => child.kill("SIGKILL")).pipe(child.stdin);
  let streamError: unknown;
  let outputEnded = false;
  try {
    for await (const chunk of child.stdout) yield chunk as Buffer;
    outputEnded = true;
  } catch (error) {
    // A failed spawn also breaks the pipe; the exit status below says why.
    streamError = error;
  } finally {
    // Kill only if we are leaving early (the reader gave up, or the pipe broke). Once xz has
    // closed its output it is finishing on its own; killing it here can race its exit and turn
    // a valid archive into "exit null". The exit status is read from `closed` below.
    if (!outputEnded && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  let code: number | null;
  try {
    [code] = (await closed) as [number | null];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CLIError(
        "NODE_UNPACK_TOOL_MISSING",
        `Unpacking the node archive needs \`${xzPath}\` (install xz-utils or xz)`,
        ExitCode.ERROR,
      );
    }
    throw error;
  }
  if (code !== 0 || streamError) {
    throw invalidArchive(`xz could not decompress it (${stderr.trim() || `exit ${code}`})`);
  }
}

async function* gzipChunks(file: string): AsyncGenerator<Buffer> {
  const gunzip = createGunzip();
  createReadStream(file).on("error", (error) => gunzip.destroy(error)).pipe(gunzip);
  try {
    for await (const chunk of gunzip) yield chunk as Buffer;
  } catch (error) {
    throw invalidArchive(`gzip could not decompress it (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Pull-based reader over decompressed chunks with a hard cap on total bytes. */
class ByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private total = 0;

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<boolean> {
    while (this.buffered < n) {
      const { done, value } = await this.iterator.next();
      if (done) return false;
      this.total += value.length;
      if (this.total > MAX_UNPACKED_BYTES) throw unsafeArchive(`it expands beyond ${MAX_UNPACKED_BYTES} bytes`);
      this.chunks.push(value);
      this.buffered += value.length;
    }
    return true;
  }

  private shift(max: number): Buffer {
    const first = this.chunks[0];
    let piece = first;
    if (first.length > max) {
      piece = first.subarray(0, max);
      this.chunks[0] = first.subarray(max);
    } else {
      this.chunks.shift();
    }
    this.buffered -= piece.length;
    return piece;
  }

  /** Exactly `n` bytes, or `null` if the stream ended before any byte of them. */
  async read(n: number): Promise<Buffer | null> {
    if (!(await this.fill(n))) {
      if (this.buffered === 0) return null;
      throw invalidArchive("it ends in the middle of an entry");
    }
    const parts: Buffer[] = [];
    for (let left = n; left > 0; ) {
      const piece = this.shift(left);
      parts.push(piece);
      left -= piece.length;
    }
    return Buffer.concat(parts);
  }

  /** The next `n` bytes in pieces, without holding them all. */
  async *stream(n: number): AsyncGenerator<Buffer> {
    for (let left = n; left > 0; ) {
      if (!(await this.fill(1))) throw invalidArchive("it ends in the middle of an entry");
      const piece = this.shift(left);
      left -= piece.length;
      yield piece;
    }
  }

  async skip(n: number): Promise<void> {
    for await (const _ of this.stream(n)) void _;
  }

  /** Consume the rest so the decompressor can finish (and the size cap applies). */
  async drain(): Promise<void> {
    while (await this.fill(this.buffered + 1)) {
      this.chunks = [];
      this.buffered = 0;
    }
  }
}

function cString(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf.toString("utf8", 0, end === -1 ? buf.length : end);
}

function octal(buf: Buffer, field: string): number {
  if (buf[0] & 0x80) throw invalidArchive(`${field} uses an unsupported binary encoding`);
  const text = cString(buf).trim();
  if (!/^[0-7]+$/.test(text)) throw invalidArchive(`${field} is not an octal number`);
  return Number.parseInt(text, 8);
}

/** Pax extended header records: `<len> <key>=<value>\n`. */
function parsePax(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const length = Number(data.toString("ascii", pos, space));
    if (space === -1 || !Number.isInteger(length) || length <= space - pos + 1 || pos + length > data.length) {
      throw invalidArchive("malformed pax header");
    }
    const record = data.toString("utf8", space + 1, pos + length - 1);
    const eq = record.indexOf("=");
    if (eq === -1) throw invalidArchive("malformed pax header");
    records[record.slice(0, eq)] = record.slice(eq + 1);
    pos += length;
  }
  return records;
}

/** Normalise an entry name and require it to lie inside `root`. */
function entryPath(name: string, root: string): string {
  if (name === "" || name.includes("\0") || name.includes("\\")) throw unsafeArchive("an entry has an invalid name");
  if (name.startsWith("/")) throw unsafeArchive("an entry has an absolute path");
  const parts = name.split("/");
  if (parts.includes("..")) throw unsafeArchive("an entry path contains '..'");
  const clean = parts.filter((part) => part !== "" && part !== ".");
  if (clean[0] !== root) throw unsafeArchive(`an entry lies outside ${root}/`);
  return clean.join("/");
}

/** Read the tar stream, vet every entry, and write the one member to `outPath`. */
async function extractMember(
  source: AsyncIterable<Buffer>,
  root: string,
  member: string,
  outPath: string,
): Promise<{ sha256: string; size: number }> {
  const reader = new ByteReader(source);
  let found: { sha256: string; size: number } | undefined;
  let pax: Record<string, string> = {};
  let longName: string | undefined;

  for (;;) {
    const header = await reader.read(TAR_BLOCK);
    if (header === null || header.every((byte) => byte === 0)) break;

    let sum = 0;
    for (let i = 0; i < TAR_BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (octal(header.subarray(148, 156), "checksum") !== sum) throw invalidArchive("a header checksum is wrong");

    const type = String.fromCharCode(header[156]);
    let size = octal(header.subarray(124, 136), "size");
    let name = cString(header.subarray(0, 100));
    // POSIX ustar ("ustar\0" "00") keeps a path prefix at 345-500. GNU tar ("ustar  \0",
    // what cargo-dist emits) uses those bytes for atime/ctime/offsets, not a path.
    if (header.toString("latin1", 257, 265) === "ustar\u000000") {
      const prefix = cString(header.subarray(345, 500));
      if (prefix !== "") name = `${prefix}/${name}`;
    }

    if (type === "x" || type === "g" || type === "L") {
      if (size > MAX_METADATA_BYTES) throw invalidArchive("a metadata entry is too large");
      const data = (await reader.read(size)) ?? Buffer.alloc(0);
      await reader.skip((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);
      if (type === "L") {
        longName = cString(data);
      } else {
        const records = parsePax(data);
        if (type === "g") {
          // A global header would silently rename or resize every later entry.
          if ("path" in records || "size" in records) throw unsafeArchive("a global pax header overrides entry paths");
        } else {
          pax = records;
        }
      }
      continue;
    }

    name = pax.path ?? longName ?? name;
    if (pax.size !== undefined) {
      size = Number(pax.size);
      if (!Number.isSafeInteger(size) || size < 0) throw invalidArchive("a pax size is not a valid number");
    }
    pax = {};
    longName = undefined;

    if (type !== "0" && type !== "\0" && type !== "5") {
      throw unsafeArchive(`entry ${JSON.stringify(name)} has type ${JSON.stringify(type)}; only files and directories are allowed`);
    }
    const path = entryPath(name, root);
    if (type === "5") {
      if (size !== 0) throw invalidArchive("a directory entry has content");
      if (path === member) throw unsafeArchive(`${member} is a directory`);
      continue;
    }

    if (path === member) {
      if (found) throw unsafeArchive(`${member} appears twice`);
      if (size < 1 || size > MAX_BINARY_BYTES) throw unsafeArchive(`${member} has an unreasonable size (${size})`);
      const hash = createHash("sha256");
      const out = await open(outPath, "wx", 0o600);
      try {
        for await (const piece of reader.stream(size)) {
          hash.update(piece);
          await writeFully(out, piece);
        }
        await out.sync();
      } finally {
        await out.close();
      }
      found = { sha256: hash.digest("hex"), size };
    } else {
      await reader.skip(size);
    }
    await reader.skip((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);
  }

  await reader.drain();
  if (!found) throw invalidArchive(`it does not contain ${member}`);
  return found;
}

interface UnpackedBinary {
  staged: string;
  sha256: string;
  size: number;
}

/** Download the archive into `staging`, verify it against its pin, and unpack the executable next to it. */
async function downloadAndUnpack(artifact: NodeArchivePin, staging: string, options: TransferOptions): Promise<UnpackedBinary> {
  const format = checkArtifact(artifact);
  const xzPath = format === "xz" ? resolveXz(options.xzBinary, options.xzCandidates) : undefined;
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));

  const archive = join(staging, "archive");
  await downloadArchive(artifact, archive, fetchImpl, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, options.signal);

  const staged = join(staging, "tinycloud");
  const chunks = xzPath ? xzChunks(archive, xzPath) : gzipChunks(archive);
  let extracted: { sha256: string; size: number };
  try {
    extracted = await extractMember(chunks, nodeArchiveRoot(artifact.target), nodeArchiveMember(artifact.target), staged);
  } finally {
    // Stops the xz child if extraction gave up before reading everything.
    await chunks.return(undefined);
  }
  // Measure what is on disk, not what was handed to write().
  const onDisk = await sha256File(staged);
  if (onDisk.sha256 !== extracted.sha256 || onDisk.size !== extracted.size) {
    throw new CLIError("NODE_WRITE_FAILED", "The unpacked node executable on disk differs from what was extracted", ExitCode.ERROR);
  }
  return { staged, ...onDisk };
}

/**
 * Download an archive (verified against its pin), unpack it, and return the
 * hash and size of the executable inside. For pin generation; nothing is installed.
 */
export async function measureNodeBinary(options: MeasureNodeBinaryOptions): Promise<{ sha256: string; size: number }> {
  const staging = await mkdtemp(join(tmpdir(), "tc-node-measure-"));
  try {
    const { sha256, size } = await downloadAndUnpack(options.artifact, staging, options);
    return { sha256, size };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Download, verify, unpack and place the node executable at `destination`.
 * On any failure `destination` is untouched and nothing is left behind.
 */
export async function fetchNodeBinary(options: FetchNodeBinaryOptions): Promise<FetchedNodeBinary> {
  const { artifact, destination } = options;
  if (!SHA256_RE.test(artifact.binary.sha256) || !Number.isSafeInteger(artifact.binary.size) || artifact.binary.size < 1 || artifact.binary.size > MAX_BINARY_BYTES) {
    throw new CLIError("NODE_RELEASE_INVALID", "Node artifact has no valid pin for its executable", ExitCode.ERROR);
  }

  const dir = dirname(destination);
  await mkdir(dir, { recursive: true });
  // Same directory as the destination so the final rename cannot cross a filesystem.
  const staging = await mkdtemp(join(dir, ".tinycloud-fetch-"));
  try {
    const { staged, sha256, size } = await downloadAndUnpack(artifact, staging, options);
    if (sha256 !== artifact.binary.sha256 || size !== artifact.binary.size) {
      throw new CLIError(
        "NODE_ARTIFACT_INTEGRITY",
        `The unpacked node executable does not match the pin in this CLI (expected ${artifact.binary.sha256}, got ${sha256}); nothing was installed`,
        ExitCode.ERROR,
      );
    }
    await chmod(staged, 0o755);
    await rename(staged, destination);
    return { destination, archiveSha256: artifact.sha256, archiveSize: artifact.size, binarySha256: sha256, binarySize: size };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
