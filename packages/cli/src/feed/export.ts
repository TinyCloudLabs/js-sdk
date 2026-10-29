import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { KVChangesResponse } from "@tinycloud/sdk-services";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import type {
  FeedRawChangePage, FeedRawExportOptions, FeedRawExportReceipt, FeedRawSidecar,
  FeedRawSnapshot, FeedRawSourceRow,
} from "./export-types.js";

// Only this module can construct a refusal with a known, static safe message.
class RawExportRefusal extends Error {}
function refuse(message: string): never { throw new RawExportRefusal(message); }
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) refuse("Raw snapshot export was cancelled.");
}
function strongETag(etag: string | undefined): etag is string {
  return typeof etag === "string" && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag);
}
function rawRow(sourceKey: string, sourceArea: FeedRawSourceRow["sourceArea"], value: Uint8Array): FeedRawSourceRow {
  return {
    sourceKey, sourceArea, encoding: "base64",
    rawBase64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}
function pageProof(page: KVChangesResponse, inputCursor?: string): FeedRawChangePage {
  return {
    ...(inputCursor === undefined ? {} : { inputCursor }), cursor: page.cursor, more: page.more,
    source: { ...page.source }, authority: { ...page.authority },
  };
}
function validateScope(page: KVChangesResponse, options: FeedRawExportOptions, nodeDid?: string): void {
  if (!page.source.nodeDid || page.source.space !== options.sourceSpace || page.source.prefix !== options.prefix ||
    (nodeDid !== undefined && page.source.nodeDid !== nodeDid)) {
    refuse("The raw source scope changed or did not match the requested space and prefix.");
  }
}
function claimSourceKey(keys: Set<string>, key: string): void {
  if (!key || keys.has(key)) refuse("Raw capture contains duplicate or conflicting source identities.");
  keys.add(key);
}
async function assertUnusedOutput(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  refuse("Raw export output already exists; choose an unused output path.");
}
async function sidecarRows(options: FeedRawExportOptions, keys: Set<string>): Promise<FeedRawSourceRow[]> {
  if (options.sidecarsFile === undefined) return [];
  const config: unknown = JSON.parse(await readFile(options.sidecarsFile, { encoding: "utf8", signal: options.signal }));
  if (!Array.isArray(config)) refuse("Raw export sidecar configuration must be an array of explicit source records.");
  const rows: FeedRawSourceRow[] = [];
  for (const value of config) {
    checkAbort(options.signal);
    if (value === null || typeof value !== "object" || typeof value.sourceKey !== "string" ||
      typeof value.path !== "string" || !value.path ||
      !["watch-state", "thread-watch-state", "expiry-state"].includes(value.sourceArea)) {
      refuse("Raw export sidecar configuration contains an invalid explicit source record.");
    }
    const sidecar: FeedRawSidecar = value;
    claimSourceKey(keys, sidecar.sourceKey);
    // Relative paths are relative to the operator's config file, never a discovered watcher location.
    const path = resolve(dirname(options.sidecarsFile), sidecar.path);
    const data = await readFile(path, { signal: options.signal });
    rows.push(rawRow(sidecar.sourceKey, sidecar.sourceArea, data));
  }
  return rows;
}

async function publishSnapshot(outFile: string, snapshot: FeedRawSnapshot, signal?: AbortSignal): Promise<void> {
  const parentPath = dirname(outFile);
  const parent = await open(parentPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  const temporary = join(parentPath, `.${basename(outFile)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const identity = await parent.stat();
    const assertStableParent = async (): Promise<void> => {
      const current = await lstat(parentPath);
      if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
        refuse("The raw export output directory changed during publication.");
      }
    };
    await assertStableParent();
    const file = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await file.chmod(0o600);
      await file.writeFile(`${JSON.stringify(snapshot)}\n`);
      await file.sync();
    } finally { await file.close(); }
    checkAbort(signal);
    await assertStableParent();
    // Exclusive link publishes only the complete fsynced file, never replaces an existing path.
    await link(temporary, outFile);
    await unlink(temporary);
    await assertStableParent();
    await parent.sync();
  } finally {
    if (created) await rm(temporary, { force: true }).catch(() => undefined);
    await parent.close();
  }
}

/** Capture owner-only bytes; Home separately classifies and resolves any migration records. */
export async function exportFeedRawSnapshot(options: FeedRawExportOptions): Promise<FeedRawExportReceipt> {
  try {
    if (!/^tinycloud:[^\s:]+(?::[^\s:]+)+$/.test(options.sourceSpace) || !options.prefix ||
      options.prefix.startsWith("/") || !options.prefix.endsWith("/") || !options.outFile || options.outFile === "-") {
      refuse("Raw export requires an explicit full source-space URI, relative slash prefix and output file.");
    }
    checkAbort(options.signal);
    const outFile = resolve(options.outFile);
    await assertUnusedOutput(outFile);
    const parent = await lstat(dirname(outFile));
    if (!parent.isDirectory()) refuse("Raw export requires an existing output directory.");
    const rows: FeedRawSourceRow[] = [];
    const deletions: FeedRawSnapshot["deletions"] = [];
    const pages: FeedRawChangePage[] = [];
    const keys = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let nodeDid: string | undefined;
    for (;;) {
      checkAbort(options.signal);
      const result = await options.kv.changes({ prefix: options.prefix, cursor, limit: 500, signal: options.signal });
      checkAbort(options.signal);
      if (!result.ok) refuse("Could not read the raw change feed; explicit source read and sync authority are required.");
      const page = result.data;
      validateScope(page, options, nodeDid);
      nodeDid = page.source.nodeDid;
      pages.push(pageProof(page, cursor));
      for (const change of page.changes) {
        checkAbort(options.signal);
        if (!change.key.startsWith(options.prefix)) refuse("A raw change key falls outside the requested namespace.");
        claimSourceKey(keys, change.key);
        if (change.deleted) {
          deletions.push({ sourceKey: change.key, sourceArea: "kv", deleted: true });
          continue;
        }
        if (!strongETag(change.etag)) refuse("Raw capture requires strong source ETags.");
        const value = await options.kv.get<Uint8Array>(change.key, {
          prefix: "", binary: true, source: "network", signal: options.signal,
        });
        checkAbort(options.signal);
        if (!value.ok) refuse("Could not read a raw source value at its change-feed revision.");
        if (!(value.data.data instanceof Uint8Array) || !strongETag(value.data.headers.etag) || value.data.headers.etag !== change.etag) {
          refuse("A raw source value changed during capture or did not provide matching strong ETags.");
        }
        rows.push({ ...rawRow(change.key, "kv", value.data.data), etag: change.etag, metadata: { ...change.metadata } });
      }
      if (page.more && (page.cursor === cursor || cursors.has(page.cursor))) {
        refuse("Raw change-feed pagination did not advance its opaque cursor.");
      }
      cursor = page.cursor;
      if (!page.more) break;
      cursors.add(cursor);
    }
    rows.push(...await sidecarRows(options, keys));
    checkAbort(options.signal);
    // A single empty tail proves no prefix changes arrived during byte/sidecar capture.
    // Any new state refuses this export; there is no retry, polling, or write fence.
    const tailResult = await options.kv.changes({ prefix: options.prefix, cursor, limit: 500, signal: options.signal });
    checkAbort(options.signal);
    if (!tailResult.ok) refuse("Could not verify the final raw source cursor.");
    const tail = tailResult.data;
    validateScope(tail, options, nodeDid);
    if (tail.more || tail.changes.length !== 0 || tail.cursor !== cursor) {
      refuse("The raw source changed during capture; no complete snapshot was published.");
    }
    const snapshot: FeedRawSnapshot = {
      format: "tinycloud.feed.raw-snapshot", formatVersion: 1,
      source: { spaceId: options.sourceSpace, namespace: options.prefix, snapshotId: randomUUID(), completePrefixSnapshot: true, cursor },
      frozenAt: new Date().toISOString(), rows, deletions, proof: { pages, tail: pageProof(tail, cursor) },
    };
    await publishSnapshot(outFile, snapshot, options.signal);
    return { snapshotId: snapshot.source.snapshotId, outFile, rowCount: rows.length, deletionCount: deletions.length };
  } catch (error) {
    // Do not retain SDK HTTP bodies, parser snippets, paths, raw values, causes, or metadata.
    const message = error instanceof RawExportRefusal ? error.message : "Could not capture and durably publish the raw snapshot.";
    throw new CLIError("ERROR", message, ExitCode.ERROR);
  }
}
