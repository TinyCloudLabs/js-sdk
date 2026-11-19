import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { ServiceContext } from "../../../sdk-services/src/context";
import { KVService } from "../../../sdk-services/src/kv/KVService";
import type { KVChangesResponse } from "../../../sdk-services/src/kv/types";
import { exportFeedRawSnapshot } from "./export";
import type { FeedRawExportOptions, FeedRawSidecar, FeedRawSnapshot } from "./export-types";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const sourceSpace = "tinycloud:pkh:eip155:1:0x1234567890123456789012345678901234567890:applications";
const prefix = "fixture/sitrep/";
const firstCursor = "opaque:page/A+==";
const endCursor = "opaque:end/B+==";
const marker = "SYNTHETIC-RAW-EXPORT-PRIVATE-CODE-19";
const source = { nodeDid: "did:key:raw-export-fixture", space: sourceSpace, prefix };
const authority = { notBefore: "2026-10-29T00:00:00Z", expiresAt: null, retainUntil: null };
const jsonKey = `${prefix}unknown/json`;
const binaryKey = `${prefix}unknown/binary`;
const malformedKey = `${prefix}unknown/malformed`;
const deletedKey = `${prefix}deleted/old-record`;
interface Value { bytes: Uint8Array; etag?: string; contentType: string }
interface HttpFailure { httpStatus: number; errorBody: string }
type PageReply = KVChangesResponse | HttpFailure;

const bytes = (text: string) => new Uint8Array(Buffer.from(text));
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const base64 = (value: Uint8Array) => Buffer.from(value).toString("base64");
function page(changes: KVChangesResponse["changes"], cursor: string, more: boolean): KVChangesResponse {
  return { changes, cursor, more, source: { ...source }, authority: { ...authority } };
}
function changed(key: string, etag: string) {
  return { key, deleted: false as const, etag, metadata: { "content-type": "application/json", "fixture-metadata": "preserve exactly" } };
}
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function captureFailure(options: FeedRawExportOptions): Promise<unknown> {
  try { await exportFeedRawSnapshot(options); }
  catch (error) { return error; }
  throw new Error("Expected raw capture to refuse publication");
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tc2209-raw-export-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const values = new Map<string, Value>([
    [jsonKey, { bytes: bytes(` {"unknown":"${marker}","same":1,"same":2}\n`), etag: '"etag-json"', contentType: "application/json" }],
    [binaryKey, { bytes: new Uint8Array([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80]), etag: '"etag-binary"', contentType: "application/json" }],
    [malformedKey, { bytes: bytes(`\n{broken JSON, ${marker}\u0000`), etag: '"etag-malformed"', contentType: "application/json" }],
  ]);
  const first = page([changed(jsonKey, '"etag-json"'), { key: deletedKey, deleted: true }], firstCursor, true);
  const second = page([changed(binaryKey, '"etag-binary"'), changed(malformedKey, '"etag-malformed"')], endCursor, false);
  const tail = page([], endCursor, false);
  const pages = new Map<string | undefined, PageReply>([[undefined, first], [firstCursor, second], [endCursor, tail]]);
  const state: {
    failure?: HttpFailure;
    interruptKey?: string;
    tailGate?: { entered: () => void; released: Promise<void> };
  } = {};
  const requests: Array<{ action: string; path: string; cursor?: string }> = [];
  const releaseTail = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    request.resume();
    try {
      const action = String(request.headers["x-fixture-action"] ?? "");
      const path = decodeURIComponent(String(request.headers["x-fixture-path"] ?? ""));
      const space = String(request.headers["x-fixture-space"] ?? "");
      const cursorHeader = request.headers["x-tinycloud-cursor"];
      const cursor = cursorHeader === undefined ? undefined : String(cursorHeader);
      requests.push({ action, path, cursor });
      if (space !== sourceSpace) { response.writeHead(401); response.end("Wrong fixture space"); return; }
      if (action === "tinycloud.kv/sync" && path === prefix) {
        if (cursor === endCursor && state.tailGate) {
          state.tailGate.entered();
          await state.tailGate.released;
          if (response.destroyed) return;
        }
        const reply = pages.get(cursor);
        if (!reply) { response.writeHead(410); response.end('{"error":{"code":"CURSOR_GAP","reason":"fixture gap"}}'); return; }
        response.setHeader("Content-Type", "application/json");
        if ("httpStatus" in reply) { response.writeHead(reply.httpStatus); response.end(reply.errorBody); }
        else response.end(JSON.stringify(reply));
        return;
      }
      if (action === "tinycloud.kv/get") {
        if (state.failure) { response.writeHead(state.failure.httpStatus); response.end(state.failure.errorBody); return; }
        const value = values.get(path);
        if (!value) { response.writeHead(404); response.end("Not found"); return; }
        if (value.etag !== undefined) response.setHeader("ETag", value.etag);
        response.setHeader("Content-Type", value.contentType);
        if (state.interruptKey === path) {
          response.setHeader("Content-Length", value.bytes.byteLength + 100);
          response.write(value.bytes.subarray(0, 2));
          setImmediate(() => response.destroy());
        } else response.end(value.bytes);
        return;
      }
      // In particular, LIST is not an alternative to the coherent SYNC feed.
      response.writeHead(403); response.end("Fixture does not authorize this operation");
    } catch {
      if (!response.destroyed) { response.writeHead(500); response.end("Fixture request failed"); }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(async () => {
    const stopped = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    releaseTail.resolve();
    await stopped;
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
  const host = `http://127.0.0.1:${address.port}`;
  const session = {
    delegationHeader: { Authorization: "test-invocation" }, delegationCid: "test-cid", spaceId: sourceSpace,
    verificationMethod: "did:key:test", jwk: {},
  };
  const context = new ServiceContext({
    hosts: [host], session, retryPolicy: { maxAttempts: 1 },
    invoke: (active, _service, path, action) => ({
      Authorization: "test-invocation", "x-fixture-space": active.spaceId,
      "x-fixture-path": encodeURIComponent(path), "x-fixture-action": action,
    }),
  });
  // A full change-feed key must not be joined to this unrelated configured prefix.
  const kv = new KVService({ prefix: "configured/decoy" });
  kv.initialize(context);
  const options: FeedRawExportOptions = { kv, sourceSpace, prefix, outFile: join(directory, "raw-snapshot.json") };
  return {
    directory, host, session, values, pages, first, second, tail, state, requests, options,
    holdTail: () => {
      const entered = Promise.withResolvers<void>();
      state.tailGate = { entered: () => entered.resolve(), released: releaseTail.promise };
      return { entered: entered.promise, release: () => releaseTail.resolve() };
    },
  };
}

test("two-page capture preserves exact unknown, malformed and invalid-UTF8 bytes plus tombstones and explicit sidecars", async () => {
  const f = await fixture();
  const sidecarValues = [bytes(`{"hold-actions":["${marker}"]}\n`), new Uint8Array([0x80, 0x00, 0xff]), bytes("{not valid expiry JSON\n")];
  const sidecars: FeedRawSidecar[] = [
    { sourceKey: "owner/watch/hold-actions", sourceArea: "watch-state", path: join(f.directory, "hold-actions") },
    { sourceKey: "owner/watch/thread", sourceArea: "thread-watch-state", path: join(f.directory, "thread-state") },
    { sourceKey: "owner/expiry", sourceArea: "expiry-state", path: join(f.directory, "expiry-state") },
  ];
  for (const [index, sidecar] of sidecars.entries()) await writeFile(sidecar.path, sidecarValues[index], { mode: 0o600 });
  const sidecarsFile = join(f.directory, "sidecars.json");
  await writeFile(sidecarsFile, JSON.stringify(sidecars), { mode: 0o600 });
  const gate = f.holdTail();
  const capture = exportFeedRawSnapshot({ ...f.options, sidecarsFile })
    .then((receipt) => ({ ok: true as const, receipt }), (error: unknown) => ({ ok: false as const, error }));
  expect(await Promise.race([gate.entered.then(() => "tail"), capture.then(() => "finished")])).toBe("tail");
  expect(await exists(f.options.outFile)).toBe(false);
  gate.release();
  const result = await capture;
  if (!result.ok) throw result.error;
  const snapshot: FeedRawSnapshot = JSON.parse(await readFile(f.options.outFile, "utf8"));
  expect(snapshot.format).toBe("tinycloud.feed.raw-snapshot");
  expect(snapshot.formatVersion).toBe(1);
  expect(snapshot.source).toEqual({ spaceId: sourceSpace, namespace: prefix, snapshotId: result.receipt.snapshotId, completePrefixSnapshot: true, cursor: endCursor });
  const expectedKV = [...f.values].map(([sourceKey, value]) => ({
    sourceKey, sourceArea: "kv", encoding: "base64", rawBase64: base64(value.bytes), sha256: digest(value.bytes),
    etag: value.etag, metadata: { "content-type": "application/json", "fixture-metadata": "preserve exactly" },
  }));
  const expectedSidecars = sidecars.map((sidecar, index) => ({
    sourceKey: sidecar.sourceKey, sourceArea: sidecar.sourceArea, encoding: "base64",
    rawBase64: base64(sidecarValues[index]), sha256: digest(sidecarValues[index]),
  }));
  expect(snapshot.rows.slice().sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)))
    .toEqual([...expectedKV, ...expectedSidecars].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)));
  expect(snapshot.deletions).toEqual([{ sourceKey: deletedKey, sourceArea: "kv", deleted: true }]);
  expect(snapshot.proof).toEqual({
    pages: [
      { cursor: firstCursor, more: true, source, authority },
      { inputCursor: firstCursor, cursor: endCursor, more: false, source, authority },
    ],
    tail: { inputCursor: endCursor, cursor: endCursor, more: false, source, authority },
  });
  expect((await stat(f.options.outFile)).mode & 0o777).toBe(0o600);
  expect(result.receipt).toEqual({ snapshotId: snapshot.source.snapshotId, outFile: f.options.outFile, rowCount: 6, deletionCount: 1 });
  expect(inspect(result.receipt)).not.toContain(marker);
  for (const row of snapshot.rows) expect(inspect(result.receipt)).not.toContain(row.rawBase64);
});

test("a partial or drifting capture never becomes a complete snapshot", async () => {
  for (const defect of ["different-etag", "missing-etag", "weak-etag"] as const) {
    const f = await fixture();
    const value = f.values.get(jsonKey)!;
    value.etag = defect === "different-etag" ? '"new-state"' : defect === "missing-etag" ? undefined : 'W/"etag-json"';
    if (defect === "weak-etag") f.first.changes[0] = changed(jsonKey, value.etag!);
    await captureFailure(f.options);
    expect(await exists(f.options.outFile)).toBe(false);
  }
});

test("the final tail refuses new live keys, tombstones, pending pages, or a moved opaque cursor", async () => {
  for (const defect of ["new-key", "new-deletion", "more", "cursor"] as const) {
    const f = await fixture();
    if (defect === "new-key") f.tail.changes = [changed(`${prefix}arrived-during-capture`, '"new"')];
    if (defect === "new-deletion") f.tail.changes = [{ key: jsonKey, deleted: true }];
    if (defect === "more") f.tail.more = true;
    if (defect === "cursor") f.tail.cursor = "different:opaque/cursor";
    await captureFailure(f.options);
    expect(await exists(f.options.outFile)).toBe(false);
  }
});

test("a cursor gap fails rather than restarting, polling, or publishing a partial scan", async () => {
  const f = await fixture();
  f.pages.set(firstCursor, { httpStatus: 410, errorBody: JSON.stringify({ error: { code: "CURSOR_GAP", reason: marker } }) });
  const error = await captureFailure(f.options);
  expect(inspect(error, { depth: 20 })).not.toContain(marker);
  expect(await exists(f.options.outFile)).toBe(false);
  expect(f.requests.filter((request) => request.action === "tinycloud.kv/sync").map((request) => request.cursor)).toEqual([undefined, firstCursor]);
});

test("wrong first-page scope or later source drift is refused without exporting another namespace", async () => {
  for (const defect of ["first-space", "first-prefix", "second-node", "tail-space", "outside-key"] as const) {
    const f = await fixture();
    if (defect === "first-space") f.first.source.space = `${sourceSpace}-other`;
    if (defect === "first-prefix") f.first.source.prefix = "fixture/other/";
    if (defect === "second-node") f.second.source.nodeDid = "did:key:other-node";
    if (defect === "tail-space") f.tail.source.space = `${sourceSpace}-other`;
    if (defect === "outside-key") f.first.changes[0] = changed("another-app/private-value", '"etag-json"');
    await captureFailure(f.options);
    expect(await exists(f.options.outFile)).toBe(false);
  }
});

test("duplicate KV or sidecar identities fail instead of overwriting an earlier source row", async () => {
  for (const defect of ["same-live-key", "conflicting-key", "live-tombstone", "same-tombstone", "sidecar-key", "kv-sidecar-key"] as const) {
    const f = await fixture();
    if (defect === "same-live-key") f.second.changes.push(changed(jsonKey, '"etag-json"'));
    if (defect === "conflicting-key") f.second.changes.push(changed(jsonKey, '"different"'));
    if (defect === "live-tombstone") f.second.changes.push({ key: jsonKey, deleted: true });
    if (defect === "same-tombstone") f.second.changes.push({ key: deletedKey, deleted: true });
    let sidecarsFile: string | undefined;
    if (defect === "sidecar-key" || defect === "kv-sidecar-key") {
      const path = join(f.directory, "sidecar");
      await writeFile(path, marker, { mode: 0o600 });
      const entry: FeedRawSidecar = { sourceKey: defect === "sidecar-key" ? "owner/watch/state" : jsonKey, sourceArea: "watch-state", path };
      sidecarsFile = join(f.directory, "sidecars.json");
      await writeFile(sidecarsFile, JSON.stringify(defect === "sidecar-key" ? [entry, { ...entry, sourceArea: "expiry-state" }] : [entry]));
    }
    await captureFailure({ ...f.options, sidecarsFile });
    expect(await exists(f.options.outFile)).toBe(false);
  }
});

test("empty more-pages advance using the opaque cursor before one empty final tail", async () => {
  const f = await fixture();
  f.first.changes = [];
  const receipt = await exportFeedRawSnapshot(f.options);
  const snapshot: FeedRawSnapshot = JSON.parse(await readFile(f.options.outFile, "utf8"));
  expect(snapshot.rows.map((row) => row.sourceKey).sort()).toEqual([binaryKey, malformedKey].sort());
  expect(snapshot.deletions).toEqual([]);
  expect(snapshot.proof.pages.map((entry) => [entry.inputCursor, entry.cursor, entry.more])).toEqual([[undefined, firstCursor, true], [firstCursor, endCursor, false]]);
  expect(snapshot.source.completePrefixSnapshot).toBe(true);
  expect(receipt.rowCount).toBe(2);
});

test("an unchanging cursor with more pages fails instead of looping or asserting completeness", async () => {
  const f = await fixture();
  f.second.cursor = firstCursor;
  f.second.more = true;
  await captureFailure(f.options);
  expect(await exists(f.options.outFile)).toBe(false);
});

test("a sync denial cannot fall back to LIST/read authority or publish a snapshot", async () => {
  const f = await fixture();
  f.pages.set(undefined, { httpStatus: 401, errorBody: `SYNC denied: ${marker}` });
  const error = await captureFailure(f.options);
  expect(inspect(error, { depth: 20 })).not.toContain(marker);
  expect(await exists(f.options.outFile)).toBe(false);
  expect(f.requests.map((request) => request.action)).toEqual(["tinycloud.kv/sync"]);
});

test("an interrupted raw HTTP body leaves no published archive and does not echo raw values", async () => {
  const f = await fixture();
  f.state.interruptKey = jsonKey;
  const error = await captureFailure(f.options);
  expect(inspect(error, { depth: 20 })).not.toContain(marker);
  expect(await exists(f.options.outFile)).toBe(false);
});

test("existing output and output appearing during capture are never silently replaced", async () => {
  for (const appearsDuringCapture of [false, true]) {
    const f = await fixture();
    const original = bytes("owner archive already exists\n");
    if (!appearsDuringCapture) {
      await writeFile(f.options.outFile, original, { mode: 0o600, flag: "wx" });
      await captureFailure(f.options);
    } else {
      const gate = f.holdTail();
      const captured = exportFeedRawSnapshot(f.options).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      expect(await Promise.race([gate.entered.then(() => "tail"), captured.then(() => "finished")])).toBe("tail");
      await writeFile(f.options.outFile, original, { mode: 0o600, flag: "wx" });
      gate.release();
      expect((await captured).ok).toBe(false);
    }
    expect(new Uint8Array(await readFile(f.options.outFile))).toEqual(original);
  }
});

test("missing or malformed explicit sidecar configuration never produces a partial archive or leaks parser snippets", async () => {
  for (const malformed of [false, true]) {
    const f = await fixture();
    const sidecarsFile = join(f.directory, "sidecars.json");
    await writeFile(sidecarsFile, malformed ? `{${marker}` : JSON.stringify([{ sourceKey: "owner/watch/missing", sourceArea: "watch-state", path: join(f.directory, "absent") }]));
    const error = await captureFailure({ ...f.options, sidecarsFile });
    expect(inspect(error, { depth: 20 })).not.toContain(marker);
    expect(await exists(f.options.outFile)).toBe(false);
  }
});

test("only explicit full source scope and slash prefix inputs are accepted", async () => {
  for (const overrides of [{ sourceSpace: "applications" }, { prefix: "" }, { prefix: "fixture/sitrep" }]) {
    const f = await fixture();
    await captureFailure({ ...f.options, ...overrides });
    expect(await exists(f.options.outFile)).toBe(false);
  }
});

test("the actual CLI error renderer cannot print raw export HTTP error values or nested causes", async () => {
  const f = await fixture();
  f.state.failure = { httpStatus: 500, errorBody: JSON.stringify({ error: marker, cause: { code: marker }, meta: { bytes: base64(bytes(marker)) } }) };
  const exportPath = new URL("./export.ts", import.meta.url).pathname;
  const kvPath = new URL("../../../sdk-services/src/kv/KVService.ts", import.meta.url).pathname;
  const contextPath = new URL("../../../sdk-services/src/context.ts", import.meta.url).pathname;
  const errorsPath = new URL("../output/errors.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "--eval", `
    import { exportFeedRawSnapshot } from ${JSON.stringify(exportPath)};
    import { KVService } from ${JSON.stringify(kvPath)};
    import { ServiceContext } from ${JSON.stringify(contextPath)};
    import { handleError } from ${JSON.stringify(errorsPath)};
    const context = new ServiceContext({hosts:[${JSON.stringify(f.host)}],session:${JSON.stringify(f.session)},retryPolicy:{maxAttempts:1},
      invoke:(active,service,path,action)=>({Authorization:'test-invocation','x-fixture-space':active.spaceId,'x-fixture-path':encodeURIComponent(path),'x-fixture-action':action})});
    const kv = new KVService({prefix:'configured/decoy'}); kv.initialize(context);
    try { const receipt=await exportFeedRawSnapshot({kv,sourceSpace:${JSON.stringify(sourceSpace)},prefix:${JSON.stringify(prefix)},outFile:${JSON.stringify(f.options.outFile)}}); process.stdout.write(JSON.stringify(receipt)); }
    catch(error) { await handleError(error); }
  `], { stdout: "pipe", stderr: "pipe" });
  cleanup.push(() => { if (child.exitCode === null) child.kill(); });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBeGreaterThan(0);
  expect(stdout + stderr).not.toContain(marker);
  expect(stdout + stderr).not.toContain(base64(bytes(marker)));
  expect(await exists(f.options.outFile)).toBe(false);
});
