import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CLIError } from "../output/errors.js";
import { NODE_DOWNLOAD_HOSTS, fetchNodeBinary, writeFully, type FetchLike } from "./node-fetch.js";
import { nodeArchiveMember, nodeArchiveRoot, nodeArchiveUrl, type NodeArtifact, type NodeTarget } from "./node-release.js";

const TARGET: NodeTarget = "x86_64-unknown-linux-gnu";
const ROOT = nodeArchiveRoot(TARGET);
const MEMBER = nodeArchiveMember(TARGET);
const BINARY = Buffer.concat([Buffer.from("\x7fELF fixture "), Buffer.alloc(150_000, 0x61)]);

// ---- tar fixtures -----------------------------------------------------------

interface TarEntry {
  name: string;
  data?: Buffer;
  /** Tar typeflag; defaults to a regular file. */
  type?: string;
  linkname?: string;
  /** GNU tar header ("ustar  \0", what cargo-dist emits) instead of POSIX ustar. */
  gnu?: boolean;
  /** Seconds since epoch written where GNU headers keep atime and ctime (bytes 345-368). */
  atime?: number;
  /** POSIX ustar path prefix (bytes 345-500). */
  prefix?: string;
}

function field(value: string, length: number): Buffer {
  const buf = Buffer.alloc(length);
  buf.write(value, "utf8");
  return buf;
}

function header(entry: TarEntry): Buffer {
  const block = Buffer.alloc(512);
  block.write(entry.name, 0, 100, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${(entry.data?.length ?? 0).toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(entry.type ?? "0", 156);
  field(entry.linkname ?? "", 100).copy(block, 157);
  if (entry.gnu) {
    block.write("ustar  \0", 257);
    const stamp = `${(entry.atime ?? 0).toString(8).padStart(11, "0")}\0`;
    block.write(stamp, 345);
    block.write(stamp, 357);
  } else {
    block.write("ustar\0", 257);
    block.write("00", 263);
    if (entry.prefix) block.write(entry.prefix, 345, 155, "utf8");
  }
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function buildTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry));
    if (entry.data && entry.data.length > 0) {
      parts.push(entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return Buffer.from(`${length}${body}`);
}

const goodEntries = (): TarEntry[] => [
  { name: `${ROOT}/`, type: "5" },
  { name: MEMBER, data: BINARY },
  { name: `${ROOT}/README.md`, data: Buffer.from("readme") },
];

const xz = (tar: Buffer) => execFileSync("xz", ["-c"], { input: tar, maxBuffer: 64 * 1024 * 1024 });

const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function artifactFor(archive: Buffer, extension: "tar.xz" | "tar.gz" = "tar.xz", binary: Buffer = BINARY): NodeArtifact {
  return {
    target: TARGET,
    url: nodeArchiveUrl("1.21.0", TARGET).replace(/tar\.xz$/, extension),
    sha256: sha256Of(archive),
    size: archive.length,
    binary: { sha256: sha256Of(binary), size: binary.length },
  };
}

// ---- fixture server ---------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let routes: Map<string, Handler>;
let hits: string[];
let work: string;
let destination: string;

/** Transport that sends every request, whatever its host, to the fixture server under `/<host>/<path>`. */
const fixtureFetch: FetchLike = (url, init) => {
  const parsed = new URL(url);
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}/${parsed.host}${parsed.pathname}${parsed.search}`, init);
};

function route(host: string, path: string, handler: Handler) {
  routes.set(`/${host}${path}`, handler);
}

function sendBytes(bytes: Buffer): Handler {
  return (_req, res) => {
    res.writeHead(200, { "content-length": bytes.length, "content-type": "application/octet-stream" });
    res.end(bytes);
  };
}

function redirect(location: string): Handler {
  return (_req, res) => {
    res.writeHead(302, { location });
    res.end();
  };
}

/** github.com → release-assets.githubusercontent.com, the shape of a real release download. */
function serveRelease(artifact: NodeArtifact, handler: Handler, assetHost = "release-assets.githubusercontent.com") {
  const { pathname } = new URL(artifact.url);
  route("github.com", pathname, redirect(`https://${assetHost}/blob/abc?sig=SECRETSIGNATURE`));
  route(assetHost, "/blob/abc", handler);
}

async function expectCode(promise: Promise<unknown>, code: string, messageHas?: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CLIError);
  expect((error as CLIError).code).toBe(code);
  if (messageHas) expect((error as CLIError).message).toContain(messageHas);
  expect((error as CLIError).message).not.toContain("SECRETSIGNATURE");
}

const install = (artifact: NodeArtifact, extra: { xzBinary?: string; xzCandidates?: readonly string[]; idleTimeoutMs?: number } = {}) =>
  fetchNodeBinary({ artifact, destination, fetchImpl: fixtureFetch, ...extra });

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "tc-node-fetch-"));
  destination = join(work, "bin", "tinycloud");
  routes = new Map();
  hits = [];
  server = createServer((req, res) => {
    const key = (req.url ?? "").split("?")[0];
    hits.push(key.slice(1));
    const handler = routes.get(key);
    if (!handler) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(work, { recursive: true, force: true });
});

async function expectUntouched(previous: string | undefined) {
  const binDir = join(work, "bin");
  const entries = await readdir(binDir).catch(() => []);
  // No staging directory, and the old executable (if any) is byte-for-byte intact.
  expect(entries.filter((name) => name !== "tinycloud")).toEqual([]);
  if (previous === undefined) expect(entries).toEqual([]);
  else expect(await readFile(destination, "utf8")).toBe(previous);
}

async function withPrevious(): Promise<string> {
  const previous = "previous executable";
  await mkdir(join(work, "bin"), { recursive: true });
  await writeFile(destination, previous);
  return previous;
}

// ---- tests ------------------------------------------------------------------

describe("fetchNodeBinary", () => {
  test("downloads through the GitHub redirect, verifies, and atomically replaces the executable", async () => {
    const archive = xz(buildTar(goodEntries()));
    const artifact = artifactFor(archive);
    serveRelease(artifact, sendBytes(archive));
    await withPrevious();

    const result = await install(artifact);

    expect(await readFile(destination)).toEqual(BINARY);
    expect((await stat(destination)).mode & 0o777).toBe(0o755);
    expect(result).toEqual({
      destination,
      archiveSha256: artifact.sha256,
      archiveSize: archive.length,
      binarySha256: createHash("sha256").update(BINARY).digest("hex"),
      binarySize: BINARY.length,
    });
    expect(await readdir(join(work, "bin"))).toEqual(["tinycloud"]);
    expect(hits).toEqual([
      `github.com${new URL(artifact.url).pathname}`,
      "release-assets.githubusercontent.com/blob/abc",
    ]);
  });

  test("also follows the older objects.githubusercontent.com asset host", async () => {
    const archive = xz(buildTar(goodEntries()));
    const artifact = artifactFor(archive);
    serveRelease(artifact, sendBytes(archive), "objects.githubusercontent.com");

    await install(artifact);

    expect(await readFile(destination)).toEqual(BINARY);
  });

  test("reads a .tar.gz archive the same way", async () => {
    const archive = gzipSync(buildTar(goodEntries()));
    const artifact = artifactFor(archive, "tar.gz");
    serveRelease(artifact, sendBytes(archive));

    await install(artifact);

    expect(await readFile(destination)).toEqual(BINARY);
  });

  describe("unpacking", () => {
    test("accepts GNU-format headers with atime and ctime set, which is what cargo-dist's tar writes", async () => {
      const archive = xz(buildTar(goodEntries().map((entry) => ({ ...entry, gnu: true, atime: 1_700_000_000 }))));
      const artifact = artifactFor(archive);
      serveRelease(artifact, sendBytes(archive));

      await install(artifact);

      expect(await readFile(destination)).toEqual(BINARY);
    });

    test("still honours the path prefix of POSIX ustar headers", async () => {
      const archive = xz(buildTar([{ name: "tinycloud", prefix: ROOT, data: BINARY }]));
      const artifact = artifactFor(archive);
      serveRelease(artifact, sendBytes(archive));

      await install(artifact);

      expect(await readFile(destination)).toEqual(BINARY);
    });

    test("an executable that differs from its pin is refused even though the archive hash matches", async () => {
      const archive = xz(buildTar([{ name: MEMBER, data: Buffer.from("not the pinned executable") }]));
      const artifact = artifactFor(archive); // archive pin matches; executable pin is BINARY
      serveRelease(artifact, sendBytes(archive));
      const previous = await withPrevious();

      await expectCode(install(artifact), "NODE_ARTIFACT_INTEGRITY", "executable");
      await expectUntouched(previous);
    });

    describe("the decompressor", () => {
      async function plantTrojan(dir: string, marker: string) {
        await mkdir(dir, { recursive: true });
        const file = join(dir, "xz");
        await writeFile(file, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
        await chmod(file, 0o755);
      }

      // Needs a real xz at one of the fixed locations (/usr/bin/xz on CI runners).
      test("is never found through PATH, an empty or relative PATH entry, or the working directory", async () => {
        const archive = xz(buildTar(goodEntries()));
        const artifact = artifactFor(archive);
        serveRelease(artifact, sendBytes(archive));
        const marker = join(work, "trojan-ran");
        const hostile = join(work, "hostile-cwd");
        await plantTrojan(hostile, marker);
        await plantTrojan(join(hostile, "node_modules", ".bin"), marker);
        const originalCwd = process.cwd();
        const originalPath = process.env.PATH;
        process.chdir(hostile);
        process.env.PATH = ["", ".", "node_modules/.bin", join(hostile, "node_modules", ".bin"), hostile, originalPath].join(":");
        try {
          await install(artifact);
        } finally {
          process.chdir(originalCwd);
          process.env.PATH = originalPath;
        }

        expect(await stat(marker).catch(() => null)).toBeNull();
        expect(await readFile(destination)).toEqual(BINARY);
      });

      test("is not searched for on PATH when none exists at a fixed location", async () => {
        const marker = join(work, "trojan-ran");
        const hostile = join(work, "hostile-bin");
        await plantTrojan(hostile, marker);
        const archive = xz(buildTar(goodEntries()));
        const artifact = artifactFor(archive);
        const originalPath = process.env.PATH;
        process.env.PATH = `${hostile}:${originalPath}`;
        try {
          await expectCode(install(artifact, { xzCandidates: [] }), "NODE_UNPACK_TOOL_MISSING");
        } finally {
          process.env.PATH = originalPath;
        }

        expect(await stat(marker).catch(() => null)).toBeNull();
        await expectUntouched(undefined);
      });

      test("must be given as an absolute path", async () => {
        const archive = xz(buildTar(goodEntries()));
        await expectCode(install(artifactFor(archive), { xzBinary: "xz" }), "NODE_UNPACK_TOOL_REJECTED");
        await expectCode(install(artifactFor(archive), { xzBinary: "./xz" }), "NODE_UNPACK_TOOL_REJECTED");
        await expectUntouched(undefined);
      });

      test("cannot change what is installed: a stand-in decompressor's output fails the executable pin", async () => {
        const archive = xz(buildTar(goodEntries()));
        const artifact = artifactFor(archive);
        serveRelease(artifact, sendBytes(archive));
        const evilTar = join(work, "evil.tar");
        await writeFile(evilTar, buildTar([{ name: `${ROOT}/`, type: "5" }, { name: MEMBER, data: Buffer.from("#!/bin/sh\necho TROJAN\n") }]));
        const standIn = join(work, "xz-standin.sh");
        await writeFile(standIn, `#!/bin/sh\ncat '${evilTar}'\n`);
        await chmod(standIn, 0o755);
        const previous = await withPrevious();

        await expectCode(install(artifact, { xzBinary: standIn }), "NODE_ARTIFACT_INTEGRITY", "executable");
        await expectUntouched(previous);
      });

      // The decompressor closes its output and only then exits, as a real xz can under load.
      // The delay lives in the fixture script, so the order of events is fixed, not raced.
      test("a decompressor that finished its output but has not exited yet is waited for, not killed", async () => {
        const archive = xz(buildTar(goodEntries()));
        const artifact = artifactFor(archive);
        serveRelease(artifact, sendBytes(archive));
        const tarFile = join(work, "good.tar");
        await writeFile(tarFile, buildTar(goodEntries()));
        const slowExit = join(work, "xz-slow-exit.sh");
        await writeFile(slowExit, `#!/bin/sh\ncat '${tarFile}'\nexec 1>&-\nsleep 0.3\nexit 0\n`);
        await chmod(slowExit, 0o755);

        await install(artifact, { xzBinary: slowExit });

        expect(await readFile(destination)).toEqual(BINARY);
      });
    });
  });

  describe("download integrity", () => {
    test("a connection cut mid-body fails and leaves the old executable", async () => {
      const archive = xz(buildTar(goodEntries()));
      const artifact = artifactFor(archive);
      const previous = await withPrevious();
      serveRelease(artifact, (_req, res) => {
        res.writeHead(200, { "content-length": archive.length });
        res.write(archive.subarray(0, Math.floor(archive.length / 2)), () => res.destroy());
      });

      await expectCode(install(artifact), "NODE_DOWNLOAD_FAILED");
      await expectUntouched(previous);
    });

    test("a body that ends early without a declared length is caught by the pinned size", async () => {
      const archive = xz(buildTar(goodEntries()));
      const artifact = artifactFor(archive);
      serveRelease(artifact, (_req, res) => {
        res.writeHead(200);
        res.end(archive.subarray(0, archive.length - 10));
      });

      await expectCode(install(artifact), "NODE_DOWNLOAD_FAILED", "truncated");
      await expectUntouched(undefined);
    });

    test("a body longer than the pin stops at the pinned size", async () => {
      const archive = xz(buildTar(goodEntries()));
      const artifact = artifactFor(archive);
      serveRelease(artifact, (_req, res) => {
        res.writeHead(200);
        res.end(Buffer.concat([archive, Buffer.alloc(4096)]));
      });

      await expectCode(install(artifact), "NODE_DOWNLOAD_TOO_LARGE");
      await expectUntouched(undefined);
    });

    test("a declared length that differs from the pin is refused before reading", async () => {
      const archive = xz(buildTar(goodEntries()));
      const artifact = artifactFor(archive);
      serveRelease(artifact, sendBytes(Buffer.concat([archive, Buffer.alloc(10)])));

      await expectCode(install(artifact), "NODE_DOWNLOAD_TOO_LARGE");
      await expectUntouched(undefined);
    });

    // Real idle timer: the behaviour under test is the platform clock firing on a silent socket.
    test("a stalled connection times out", async () => {
      const archive = xz(buildTar(goodEntries()));
      const artifact = artifactFor(archive);
      serveRelease(artifact, (_req, res) => {
        res.writeHead(200, { "content-length": archive.length });
        res.write(archive.subarray(0, 100));
      });

      await expectCode(install(artifact, { idleTimeoutMs: 200 }), "NODE_DOWNLOAD_TIMEOUT");
      await expectUntouched(undefined);
    });

    test("a transport-level content-encoding is refused", async () => {
      const archive = xz(buildTar(goodEntries()));
      const artifact = artifactFor(archive);
      serveRelease(artifact, (_req, res) => {
        res.writeHead(200, { "content-length": archive.length, "content-encoding": "gzip" });
        res.end(archive);
      });

      // Node refuses on the header; other runtimes fail while decoding. Neither installs anything.
      await expectCode(install(artifact), "NODE_DOWNLOAD_FAILED");
      await expectUntouched(undefined);
    });

    test("an HTTP error is not installed", async () => {
      const archive = xz(buildTar(goodEntries()));
      const artifact = artifactFor(archive);
      serveRelease(artifact, (_req, res) => {
        res.writeHead(503);
        res.end("busy");
      });

      await expectCode(install(artifact), "NODE_DOWNLOAD_FAILED", "HTTP 503");
    });

    test("a wrong hash is refused before anything is decompressed", async () => {
      const archive = xz(buildTar(goodEntries()));
      const artifact = artifactFor(archive);
      const wrong = { ...artifact, sha256: `${artifact.sha256.slice(0, 63)}${artifact.sha256.endsWith("0") ? "1" : "0"}` };
      serveRelease(wrong, sendBytes(archive));
      const previous = await withPrevious();
      const marker = join(work, "xz-was-run");
      const spy = join(work, "xz-spy.sh");
      await writeFile(spy, `#!/bin/sh\ntouch '${marker}'\nexec xz "$@"\n`);
      await chmod(spy, 0o755);

      await expectCode(install(wrong, { xzBinary: spy }), "NODE_ARTIFACT_INTEGRITY");

      expect(await stat(marker).catch(() => null)).toBeNull();
      await expectUntouched(previous);
    });

    test("a swapped archive whose bytes differ at the same size is refused", async () => {
      const archive = xz(buildTar(goodEntries()));
      const artifact = artifactFor(archive);
      const tampered = Buffer.from(archive);
      tampered[tampered.length - 20] ^= 0xff;
      serveRelease(artifact, sendBytes(tampered));

      await expectCode(install(artifact), "NODE_ARTIFACT_INTEGRITY");
      await expectUntouched(undefined);
    });
  });

  describe("redirects and URLs", () => {
    const archive = xz(buildTar(goodEntries()));
    const artifact = artifactFor(archive);
    const start = new URL(artifact.url).pathname;

    for (const target of [
      "https://evil.example/payload?sig=SECRETSIGNATURE",
      "http://objects.githubusercontent.com/blob/abc?sig=SECRETSIGNATURE",
      "https://github.com.evil.example/blob/abc",
      "https://objects.githubusercontent.com.evil.example/blob/abc",
      "https://release-assets.githubusercontent.com.evil.example/blob/abc",
      "https://raw.githubusercontent.com/blob/abc",
      "https://user:pass@github.com/blob/abc",
      "https://github.com:8443/blob/abc",
      "ftp://github.com/blob/abc",
    ]) {
      test(`refuses a redirect to ${target.split("?")[0]}`, async () => {
        route("github.com", start, redirect(target));
        route("evil.example", "/payload", sendBytes(archive));

        await expectCode(install(artifact), "NODE_DOWNLOAD_URL_REJECTED");

        // Only allow-listed hosts were ever contacted.
        expect(hits.map((hit) => hit.split("/")[0]).filter((host) => !NODE_DOWNLOAD_HOSTS.includes(host))).toEqual([]);
        await expectUntouched(undefined);
      });
    }

    test("refuses a redirect loop", async () => {
      route("github.com", start, redirect(`https://github.com${start}`));

      await expectCode(install(artifact), "NODE_DOWNLOAD_FAILED", "redirected more than");
    });

    test("refuses a redirect with no location", async () => {
      route("github.com", start, (_req, res) => {
        res.writeHead(302);
        res.end();
      });

      await expectCode(install(artifact), "NODE_DOWNLOAD_FAILED", "without a location");
    });

    for (const url of [
      "http://github.com/TinyCloudLabs/tinycloud-node/releases/download/v1.21.0/tinycloud-node-x.tar.xz",
      "https://example.com/tinycloud-node-x.tar.xz",
      "https://github.com.evil.example/tinycloud-node-x.tar.xz",
      "not a url",
    ]) {
      test(`refuses to start from ${url}`, async () => {
        let called = false;
        const fetchImpl: FetchLike = () => {
          called = true;
          return Promise.reject(new Error("unreachable"));
        };

        await expectCode(fetchNodeBinary({ artifact: { ...artifact, url }, destination, fetchImpl }), "NODE_DOWNLOAD_URL_REJECTED");

        expect(called).toBe(false);
        await expectUntouched(undefined);
      });
    }

    test("refuses a pin whose size is beyond the cap", async () => {
      await expectCode(
        fetchNodeBinary({ artifact: { ...artifact, size: 65 * 1024 * 1024 }, destination, fetchImpl: fixtureFetch }),
        "NODE_RELEASE_INVALID",
      );
    });
  });

  describe("hostile archives (hash matches the pin, contents do not)", () => {
    async function expectRefused(entries: TarEntry[], code: string, messageHas?: string) {
      const archive = xz(buildTar(entries));
      const artifact = artifactFor(archive);
      serveRelease(artifact, sendBytes(archive));
      const previous = await withPrevious();

      await expectCode(install(artifact), code, messageHas);

      await expectUntouched(previous);
      expect(await stat(join(work, "evil")).catch(() => null)).toBeNull();
    }

    const cases: Array<[string, TarEntry[], string]> = [
      ["a symlink entry", [...goodEntries(), { name: `${ROOT}/link`, type: "2", linkname: "/etc/passwd" }], "type"],
      ["a hardlink entry", [...goodEntries(), { name: `${ROOT}/hard`, type: "1", linkname: MEMBER }], "type"],
      ["the member replaced by a symlink", [{ name: MEMBER, type: "2", linkname: "/bin/sh" }], "type"],
      ["a device entry", [...goodEntries(), { name: `${ROOT}/dev`, type: "3" }], "type"],
      ["a fifo entry", [...goodEntries(), { name: `${ROOT}/pipe`, type: "6" }], "type"],
      ["a '..' traversal", [...goodEntries(), { name: `${ROOT}/../../evil`, data: Buffer.from("x") }], "'..'"],
      ["an absolute path", [...goodEntries(), { name: "/tmp/evil", data: Buffer.from("x") }], "absolute"],
      ["a backslash path", [...goodEntries(), { name: `${ROOT}\\..\\evil`, data: Buffer.from("x") }], "invalid name"],
      ["an entry outside the archive root", [...goodEntries(), { name: "other-root/tinycloud", data: Buffer.from("x") }], "outside"],
      ["the member twice", [...goodEntries(), { name: MEMBER, data: Buffer.from("second") }], "twice"],
      ["the member as a directory", [{ name: MEMBER, type: "5" }], "directory"],
      ["an empty member", [{ name: MEMBER }], "size"],
    ];
    for (const [label, entries, messageHas] of cases) {
      test(`rejects ${label}`, async () => {
        await expectRefused(entries, "NODE_ARCHIVE_UNSAFE", messageHas);
      });
    }

    test("rejects a GNU long name that escapes the root", async () => {
      await expectRefused(
        [
          { name: "././@LongLink", type: "L", data: Buffer.from(`${ROOT}/../../evil\0`) },
          { name: `${ROOT}/short`, data: Buffer.from("x") },
          ...goodEntries(),
        ],
        "NODE_ARCHIVE_UNSAFE",
        "'..'",
      );
    });

    test("rejects a global pax header that would rewrite later entries", async () => {
      await expectRefused(
        [{ name: "pax_global_header", type: "g", data: paxRecord("path", "elsewhere") }, ...goodEntries()],
        "NODE_ARCHIVE_UNSAFE",
        "global pax",
      );
    });
    test("rejects a pax header that rewrites a path to escape the root", async () => {
      const archive = xz(
        Buffer.concat([
          header({ name: "pax", type: "x", data: paxRecord("path", "../../evil") }),
          Buffer.concat([paxRecord("path", "../../evil"), Buffer.alloc(512 - paxRecord("path", "../../evil").length)]),
          buildTar([...goodEntries(), { name: `${ROOT}/innocent`, data: Buffer.from("x") }]),
        ]),
      );
      const artifact = artifactFor(archive);
      serveRelease(artifact, sendBytes(archive));

      await expectCode(install(artifact), "NODE_ARCHIVE_UNSAFE", "'..'");
      expect(await stat(join(work, "evil")).catch(() => null)).toBeNull();
    });

    test("rejects an archive that never contains the member", async () => {
      await expectRefused([{ name: `${ROOT}/README.md`, data: Buffer.from("readme") }], "NODE_ARCHIVE_INVALID", "does not contain");
    });

    test("rejects a corrupted tar header", async () => {
      const tar = buildTar(goodEntries());
      tar[10] ^= 0xff;
      const archive = xz(tar);
      const artifact = artifactFor(archive);
      serveRelease(artifact, sendBytes(archive));

      await expectCode(install(artifact), "NODE_ARCHIVE_INVALID", "checksum");
    });

    test("rejects an archive truncated inside the member", async () => {
      const archive = xz(buildTar(goodEntries()).subarray(0, 4096));
      const artifact = artifactFor(archive);
      serveRelease(artifact, sendBytes(archive));

      await expectCode(install(artifact), "NODE_ARCHIVE_INVALID");
      await expectUntouched(undefined);
    });

    test("rejects bytes that are not xz data", async () => {
      const archive = Buffer.from("definitely not an xz stream");
      const artifact = artifactFor(archive);
      serveRelease(artifact, sendBytes(archive));

      await expectCode(install(artifact), "NODE_ARCHIVE_INVALID", "xz");
      await expectUntouched(undefined);
    });

    test("reports a missing xz clearly", async () => {
      const archive = xz(buildTar(goodEntries()));
      const artifact = artifactFor(archive);
      serveRelease(artifact, sendBytes(archive));

      await expectCode(install(artifact, { xzBinary: join(work, "no-such-xz") }), "NODE_UNPACK_TOOL_MISSING");
      await expectUntouched(undefined);
    });
  });
});

describe("writeFully", () => {
  /** A file handle that accepts at most `limit` bytes per call, like a nearly full disk. */
  function shortHandle(limit: number, sink: Buffer[]): Pick<FileHandle, "write"> {
    const write = async (data: Uint8Array, offset: number, length: number) => {
      const bytesWritten = Math.min(limit, length);
      sink.push(Buffer.from(data.subarray(offset, offset + bytesWritten)));
      return { bytesWritten, buffer: data };
    };
    return { write } as unknown as Pick<FileHandle, "write">;
  }

  test("keeps writing until every byte is down after short writes", async () => {
    const sink: Buffer[] = [];
    const data = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));

    await writeFully(shortHandle(7, sink), data);

    expect(Buffer.concat(sink)).toEqual(data);
    expect(sink.length).toBe(Math.ceil(1000 / 7));
  });

  test("fails instead of reporting success when the disk accepts nothing", async () => {
    const error = await writeFully(shortHandle(0, []), Buffer.alloc(10)).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CLIError);
    expect((error as CLIError).code).toBe("NODE_WRITE_FAILED");
  });
});
