/**
 * Artifact layout (TC-1428). An artifact is a set of write-once, numbered
 * versions kept as ordinary KV keys in the owner's space:
 *
 *   artifacts/<aid>/versions/<n>/<file>         stored bytes, created with If-None-Match:*
 *   artifacts/<aid>/versions/<n>/manifest.json  written LAST; its presence marks the version complete
 *
 * No node change is involved. Two properties of the node were confirmed on a
 * real local node (TC-1428 spike): `If-None-Match: *` is a write-once
 * primitive (8 racing creators: one wins, seven get 412), and blobs dedupe by
 * content hash within a space.
 *
 * Retention: the node never reclaims overwritten or deleted values (every
 * write stays in the write log and its blob counts against the owner's
 * storage). Versions are therefore kept by default; reclaiming bytes belongs
 * to history GC (TC-1277), not to this module.
 *
 * Delegation resources for a version are written WITHOUT a trailing slash
 * (`artifacts/<aid>/versions/<n>`): `kv/list` is authorised against the
 * slash-stripped resource, so a trailing slash cannot list. The slashless
 * form stays path-segment bounded (`versions/1` does not cover `versions/10`).
 */
import { sha256 } from "@noble/hashes/sha256";
import { canonicalize } from "@tinycloud/share-envelope";
import { canonicalShareFilename } from "./filename-policy.js";

export const ARTIFACT_ROOT = "artifacts";
export const ARTIFACT_MANIFEST_NAME = "manifest.json";
export const ARTIFACT_MANIFEST_VERSION = 1 as const;
/** A lost create race bumps `n`; this bounds how many times one publish retries. */
export const ARTIFACT_MAX_PUBLISH_ATTEMPTS = 16;

const ARTIFACT_ID = /^[a-z0-9][a-z0-9_-]{2,62}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type ArtifactErrorCode = "invalid-argument" | "conflict" | "storage" | "corrupt";

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;
  constructor(code: ArtifactErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ArtifactError";
    this.code = code;
  }
}

/**
 * The only storage operations the layout needs. `put` with `ifNoneMatch`
 * resolves `"exists"` on a 412 and `"created"` otherwise; every other failure
 * throws. `list` returns full keys and follows pagination to the end.
 */
export interface ArtifactStore {
  put(key: string, bytes: Uint8Array, options: { readonly ifNoneMatch: "*"; readonly contentType?: string }): Promise<"created" | "exists">;
  get(key: string): Promise<Uint8Array | undefined>;
  list(prefix: string): Promise<readonly string[]>;
}

export interface ArtifactManifestFile {
  /** One safe path segment, relative to the version directory. */
  readonly path: string;
  /** SHA-256 (lowercase hex) of the bytes stored at this key. */
  readonly sha256: string;
  readonly bytes: number;
  /**
   * SHA-256 of the plaintext when the stored bytes are ciphertext (addressed
   * shares). Lets an unchanged republish reuse the stored version instead of
   * minting an identical one.
   */
  readonly contentSha256?: string;
}

export interface ArtifactManifest {
  readonly v: typeof ARTIFACT_MANIFEST_VERSION;
  readonly files: readonly ArtifactManifestFile[];
  readonly createdAt: string;
  /** The version this one follows, or `null` for the first. */
  readonly parent: number | null;
  readonly note?: string;
}

export interface ArtifactVersionInput {
  readonly artifactId: string;
  readonly files: readonly {
    readonly filename: string;
    readonly bytes: Uint8Array;
    readonly contentSha256?: string;
    readonly contentType?: string;
  }[];
  readonly note?: string;
  readonly now?: () => number;
}

export interface ArtifactVersionResult {
  readonly artifactId: string;
  readonly version: number;
  readonly manifest: ArtifactManifest;
  /** SHA-256 of the exact stored `manifest.json` bytes. */
  readonly manifestSha256: string;
  /** `false` when an existing version already held the same content (idempotent re-run). */
  readonly created: boolean;
}

export interface ArtifactVersionSummary {
  readonly version: number;
  /** `false` while `manifest.json` is missing: an interrupted or lost-race attempt. */
  readonly complete: boolean;
  readonly manifest?: ArtifactManifest;
  readonly manifestSha256?: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newArtifactId(random: (length: number) => Uint8Array = (length) => crypto.getRandomValues(new Uint8Array(length))): string {
  return `art_${Array.from(random(8), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function assertArtifactId(value: string): string {
  if (!ARTIFACT_ID.test(value)) {
    throw new ArtifactError("invalid-argument", "artifact id must be 3-63 characters of a-z, 0-9, '_' or '-', starting with a letter or digit");
  }
  return value;
}

function assertVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new ArtifactError("invalid-argument", "artifact version must be a positive integer");
  return value;
}

export function artifactVersionsPrefix(artifactId: string): string {
  return `${ARTIFACT_ROOT}/${assertArtifactId(artifactId)}/versions/`;
}

/** Delegation resource for one version: a prefix, NO trailing slash. */
export function artifactVersionResource(artifactId: string, version: number): string {
  return `${ARTIFACT_ROOT}/${assertArtifactId(artifactId)}/versions/${assertVersion(version)}`;
}

export function artifactVersionFilePath(artifactId: string, version: number, filename: string): string {
  return `${artifactVersionResource(artifactId, version)}/${filename}`;
}

/** The artifact and version a stored KV path belongs to, if it is under a version directory. */
export function parseArtifactVersionPath(path: string): { readonly artifactId: string; readonly version: number; readonly file: string } | undefined {
  const match = /^artifacts\/([a-z0-9][a-z0-9_-]{2,62})\/versions\/([1-9][0-9]{0,14})\/([^/]+)$/.exec(path);
  if (match === null) return undefined;
  return { artifactId: match[1]!, version: Number(match[2]), file: match[3]! };
}

export function manifestBytes(manifest: ArtifactManifest): Uint8Array {
  return new TextEncoder().encode(canonicalize(manifest));
}

/**
 * Strict manifest parser. Unknown fields, duplicate paths and malformed
 * digests are refused: the bytes a viewer verifies against are exactly the
 * ones this accepts.
 */
export function parseArtifactManifest(bytes: Uint8Array): ArtifactManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ArtifactError("corrupt", "artifact manifest is not valid JSON");
  }
  const fail = (): never => { throw new ArtifactError("corrupt", "artifact manifest is malformed"); };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  const allowed = ["v", "files", "createdAt", "parent", "note"];
  if (Object.keys(record).some((key) => !allowed.includes(key)) || record.v !== ARTIFACT_MANIFEST_VERSION) return fail();
  if (!Array.isArray(record.files) || record.files.length === 0) return fail();
  if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) return fail();
  if (record.parent !== null && (typeof record.parent !== "number" || !Number.isSafeInteger(record.parent) || record.parent < 1)) return fail();
  if (record.note !== undefined && (typeof record.note !== "string" || record.note.length > 1024)) return fail();
  const seen = new Set<string>();
  const files = record.files.map((entry): ArtifactManifestFile => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return fail();
    const file = entry as Record<string, unknown>;
    if (Object.keys(file).some((key) => !["path", "sha256", "bytes", "contentSha256"].includes(key))) return fail();
    if (typeof file.path !== "string" || file.path === ARTIFACT_MANIFEST_NAME || seen.has(file.path)) return fail();
    try { canonicalShareFilename(file.path); } catch { return fail(); }
    seen.add(file.path);
    if (typeof file.sha256 !== "string" || !SHA256_HEX.test(file.sha256)) return fail();
    if (typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0) return fail();
    if (file.contentSha256 !== undefined && (typeof file.contentSha256 !== "string" || !SHA256_HEX.test(file.contentSha256))) return fail();
    return {
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      ...(file.contentSha256 === undefined ? {} : { contentSha256: file.contentSha256 }),
    };
  });
  return {
    v: ARTIFACT_MANIFEST_VERSION,
    files,
    createdAt: record.createdAt,
    parent: record.parent as number | null,
    ...(record.note === undefined ? {} : { note: record.note }),
  };
}

/** Versions present under `artifacts/<aid>/versions/`, ascending, with their manifests when complete. */
export async function listArtifactVersions(store: ArtifactStore, artifactId: string): Promise<ArtifactVersionSummary[]> {
  const prefix = artifactVersionsPrefix(artifactId);
  const numbers = new Map<number, boolean>();
  for (const key of await store.list(prefix)) {
    if (!key.startsWith(prefix)) continue;
    const [segment, ...rest] = key.slice(prefix.length).split("/");
    if (!/^[1-9][0-9]{0,14}$/.test(segment ?? "") || rest.length === 0) continue;
    const version = Number(segment);
    numbers.set(version, (numbers.get(version) ?? false) || rest.join("/") === ARTIFACT_MANIFEST_NAME);
  }
  const summaries: ArtifactVersionSummary[] = [];
  for (const version of [...numbers.keys()].sort((a, b) => a - b)) {
    if (numbers.get(version) !== true) { summaries.push({ version, complete: false }); continue; }
    const stored = await store.get(artifactVersionFilePath(artifactId, version, ARTIFACT_MANIFEST_NAME));
    if (stored === undefined) { summaries.push({ version, complete: false }); continue; }
    summaries.push({ version, complete: true, manifest: parseArtifactManifest(stored), manifestSha256: sha256Hex(stored) });
  }
  return summaries;
}

function sameContent(manifest: ArtifactManifest, files: readonly ArtifactManifestFile[]): boolean {
  if (manifest.files.length !== files.length) return false;
  return files.every((file) => {
    const existing = manifest.files.find((candidate) => candidate.path === file.path);
    if (existing === undefined) return false;
    // Ciphertext differs on every encryption, so compare plaintext digests when both sides have one.
    if (existing.contentSha256 !== undefined && file.contentSha256 !== undefined) return existing.contentSha256 === file.contentSha256;
    return existing.sha256 === file.sha256 && existing.contentSha256 === undefined && file.contentSha256 === undefined;
  });
}

/**
 * Publish `files` as the next version.
 *
 * - Content identical to the latest complete version: no new version, that
 *   one is returned (`created: false`). Safe to re-run after a crash.
 * - Files are created with `If-None-Match: *`. A 412 is success only when the
 *   stored bytes hash to the same sha256 as ours; otherwise another publisher
 *   owns that `n` and the next number is tried.
 * - `manifest.json` is written last. A version without one is incomplete and
 *   is never reused, and a manifest lists the only files it vouches for.
 */
export async function publishArtifactVersion(store: ArtifactStore, input: ArtifactVersionInput): Promise<ArtifactVersionResult> {
  const artifactId = assertArtifactId(input.artifactId);
  if (input.files.length === 0) throw new ArtifactError("invalid-argument", "an artifact version needs at least one file");
  const entries: ArtifactManifestFile[] = [];
  const seen = new Set<string>();
  for (const file of input.files) {
    let path: string;
    try { path = canonicalShareFilename(file.filename); }
    catch { throw new ArtifactError("invalid-argument", "artifact filename must be one safe path segment"); }
    if (path === ARTIFACT_MANIFEST_NAME) throw new ArtifactError("invalid-argument", `${ARTIFACT_MANIFEST_NAME} is reserved`);
    if (seen.has(path)) throw new ArtifactError("invalid-argument", "artifact filenames must be unique");
    seen.add(path);
    if (file.contentSha256 !== undefined && !SHA256_HEX.test(file.contentSha256)) throw new ArtifactError("invalid-argument", "contentSha256 must be lowercase hex SHA-256");
    entries.push({ path, sha256: sha256Hex(file.bytes), bytes: file.bytes.byteLength, ...(file.contentSha256 === undefined ? {} : { contentSha256: file.contentSha256 }) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const bytesByPath = new Map(input.files.map((file, index) => [canonicalShareFilename(file.filename), index]));
  const now = input.now ?? Date.now;

  for (let attempt = 0; attempt < ARTIFACT_MAX_PUBLISH_ATTEMPTS; attempt += 1) {
    const versions = await listArtifactVersions(store, artifactId);
    const latestComplete = [...versions].reverse().find((version) => version.complete);
    if (latestComplete?.manifest !== undefined && sameContent(latestComplete.manifest, entries)) {
      return { artifactId, version: latestComplete.version, manifest: latestComplete.manifest, manifestSha256: latestComplete.manifestSha256!, created: false };
    }
    const version = (versions.at(-1)?.version ?? 0) + 1;
    let lost = false;
    for (const entry of entries) {
      const source = input.files[bytesByPath.get(entry.path)!]!;
      const key = artifactVersionFilePath(artifactId, version, entry.path);
      const written = await store.put(key, source.bytes, { ifNoneMatch: "*", ...(source.contentType === undefined ? {} : { contentType: source.contentType }) });
      if (written === "exists") {
        const stored = await store.get(key);
        if (stored === undefined || sha256Hex(stored) !== entry.sha256) { lost = true; break; }
      }
    }
    if (lost) continue;
    const manifest: ArtifactManifest = {
      v: ARTIFACT_MANIFEST_VERSION,
      files: entries,
      createdAt: new Date(now()).toISOString(),
      parent: latestComplete?.version ?? null,
      ...(input.note === undefined ? {} : { note: input.note }),
    };
    const manifestKey = artifactVersionFilePath(artifactId, version, ARTIFACT_MANIFEST_NAME);
    const encoded = manifestBytes(manifest);
    const written = await store.put(manifestKey, encoded, { ifNoneMatch: "*", contentType: "application/json" });
    if (written === "created") return { artifactId, version, manifest, manifestSha256: sha256Hex(encoded), created: true };
    // Someone else completed this number first. Theirs is ours only if it vouches for the same stored bytes.
    const existing = await store.get(manifestKey);
    if (existing === undefined) continue;
    const theirs = parseArtifactManifest(existing);
    const identical = theirs.files.length === entries.length
      && entries.every((entry) => theirs.files.some((file) => file.path === entry.path && file.sha256 === entry.sha256));
    if (identical) return { artifactId, version, manifest: theirs, manifestSha256: sha256Hex(existing), created: false };
  }
  throw new ArtifactError("conflict", "could not claim an artifact version number after repeated races; retry");
}
