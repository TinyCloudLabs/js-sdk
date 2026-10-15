/**
 * `@tinycloud/replica/kv-storage` in real Chromium (TC-858 Phase 2 plan §3):
 * the production worker host, IndexedDB, Web Locks and BroadcastChannel,
 * driven through `window.__kv` on the Vite-built fixture page (`kv.html`).
 *
 * The fake-feed suite needs no node: the fixture's test worker speaks JSON
 * to this process, where a `FakeNode` per feed answers every page and
 * content request — so a test can hold a request open, fail it, or abort it
 * mid-page. The real-node suite (TC_REPLICA_E2E_NODE_BIN) runs the
 * published `kv-storage.worker.js` with WASM signing against a node.
 *
 * Build first: `bun run build` in packages/replica, then `bunx vite build`
 * in test/browser/fixture; `bunx playwright install chromium` once.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

import { FakeNode, SPACE, deviceGrant, keyPair, owner, signUcan } from "./fixtures.js";
import { ReplicaError, ReplicaErrorCode, isReplicaError } from "../src/errors.js";

const FIXTURE_DIST = resolve(import.meta.dir, "browser/fixture/dist");
const PRINCIPAL = "did:pkh:eip155:1:0x00000000000000000000000000000000000000c1";

type Outcome<T = unknown> = { ok: true; value: T } | { ok: false; code: string; message: string; gate?: string };

/** Fake feeds by name, plus a server-side page-size cap per feed. */
const feeds = new Map<string, { node: FakeNode; pageLimit: number }>();

function feed(name: string, pageLimit = 500): FakeNode {
  const node = new FakeNode("notes/");
  feeds.set(name, { node, pageLimit });
  return node;
}

/** A promise the test resolves to release a held request. */
function gate(): { opened: Promise<void>; open(): void; reached: Promise<void>; arrive(): void } {
  const opened = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  return { opened: opened.promise, open: () => opened.resolve(), reached: reached.promise, arrive: () => reached.resolve() };
}

let server: Bun.Server<undefined>;
let origin = "";
let browser: Browser;
let context: BrowserContext;

const hostOf = (name: string) => `${origin}/fake/${name}`;
const identityOf = (name: string) => ({ host: hostOf(name), space: SPACE, principal: PRINCIPAL });
const specOf = (name: string, extra: Record<string, unknown> = {}) => ({ identity: identityOf(name), space: SPACE, prefix: "notes/", allowSecrets: false, ...extra });

async function kvPage(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${origin}/kv.html`);
  await page.waitForFunction(() => window.__kv !== undefined);
  return page;
}

/** A grant for `deviceDid` signed by the fixture owner: get + sync on notes/, unless `att` overrides. */
function grantFor(deviceDid: string, att?: Record<string, Record<string, unknown>>): string {
  if (att === undefined) return deviceGrant({ aud: deviceDid }).jwt;
  return signUcan(owner, { aud: deviceDid, exp: Math.floor(Date.now() / 1000) + 3600, att, prf: ["bafyparent"] });
}

/** Open `handle` on `page` against feed `name` and install a fresh grant for its device. */
async function openGranted(page: Page, storage: string, handle: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const opened = (await page.evaluate(([s, h, spec]) => window.__kv.open(s, h, spec as never), [storage, handle, specOf(name, extra)] as const)) as Outcome<{ deviceDid: string }>;
  if (!opened.ok) throw new Error(`open failed: ${opened.code} ${opened.message}`);
  const installed = (await page.evaluate(([h, jwt]) => window.__kv.installGrant(h, jwt), [handle, grantFor(opened.value.deviceDid)] as const)) as Outcome;
  if (!installed.ok) throw new Error(`install failed: ${installed.code} ${installed.message}`);
  return opened.value.deviceDid;
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const fake = /^\/fake\/([^/]+)\/(page|content)$/.exec(url.pathname);
      if (fake !== null) {
        const entry = feeds.get(fake[1]!);
        if (entry === undefined) return Response.json({ code: "NODE_ERROR", message: "no such feed" }, { status: 404 });
        const body = (await request.json()) as { prefix: string; cursor?: string; limit: number; keys: string[] };
        try {
          if (fake[2] === "page") {
            return Response.json(await entry.node.syncPage({ prefix: body.prefix, ...(body.cursor === undefined ? {} : { cursor: body.cursor }), limit: Math.min(body.limit, entry.pageLimit) }));
          }
          const contents = await entry.node.fetchContent(body.keys);
          return Response.json(
            Object.fromEntries(
              [...contents].map(([key, value]) => [key, "missing" in value ? { missing: true } : { b64: Buffer.from(value.bytes).toString("base64"), etag: value.etag }]),
            ),
          );
        } catch (error) {
          if (isReplicaError(error)) return Response.json({ code: error.code, message: error.message, detail: error.detail }, { status: 502 });
          throw error;
        }
      }
      const path = url.pathname === "/" ? "/kv.html" : url.pathname;
      const file = Bun.file(join(FIXTURE_DIST, path));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      const type = path.endsWith(".html") ? "text/html" : path.endsWith(".js") ? "text/javascript" : "application/octet-stream";
      return new Response(file, { headers: { "content-type": type } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

beforeEach(async () => {
  // A fresh context per test: its own IndexedDB, locks and channels.
  context = await browser.newContext();
});

afterEach(async () => {
  await context.close();
  feeds.clear();
});

describe("kv-storage over a fake feed (Chromium)", () => {
  test("reads carry LocalReadMeta: coverage, authority and the epoch the last sync persisted", async () => {
    const node = feed("meta");
    node.put("notes/a", "alpha");
    node.put("notes/b", "beta");
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    await openGranted(page, "s", "h", "meta");

    const before = (await page.evaluate(() => window.__kv.get("h", "notes/a"))) as Outcome<{ status: string; meta: Record<string, unknown> }>;
    expect(before).toMatchObject({ ok: true, value: { status: "coverage_incomplete", meta: { coverage: "empty", syncedThroughEpoch: 0, asOf: null } } });

    const synced = (await page.evaluate(() => window.__kv.sync("h", 7))) as Outcome;
    expect(synced).toMatchObject({ ok: true, value: { status: "synced", coverage: "complete", syncedThroughEpoch: 7, changes: 2 } });

    const got = (await page.evaluate(() => window.__kv.get("h", "notes/a"))) as Outcome<{ status: string; value: string; meta: Record<string, unknown> }>;
    expect(got).toMatchObject({ ok: true, value: { status: "present", value: "alpha", meta: { coverage: "complete", authority: "valid", syncedThroughEpoch: 7 } } });
    if (got.ok) expect(typeof got.value.meta.asOf).toBe("string");
    const listed = (await page.evaluate(() => window.__kv.list("h", "notes/"))) as Outcome;
    expect(listed).toMatchObject({ ok: true, value: { keys: ["notes/a", "notes/b"], meta: { coverage: "complete", authority: "valid", syncedThroughEpoch: 7 } } });
    expect(await page.evaluate(() => window.__kv.get("h", "notes/missing"))).toMatchObject({ ok: true, value: { status: "absent", meta: { syncedThroughEpoch: 7 } } });

    const status = (await page.evaluate(() => window.__kv.status("h"))) as Outcome;
    expect(status).toMatchObject({ ok: true, value: { syncedThroughEpoch: 7, coverage: "complete", purgePending: false, counts: { keys: 2 } } });
  }, 60_000);

  test("a sync aborted mid-page commits nothing past its last complete page and keeps the epoch", async () => {
    const node = feed("abort", 2);
    for (const n of [1, 2, 3, 4]) node.put(`notes/k${n}`, `value ${n}`);
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    await openGranted(page, "s", "h", "abort");
    expect(await page.evaluate(() => window.__kv.sync("h", 1))).toMatchObject({ ok: true, value: { syncedThroughEpoch: 1 } });

    for (const n of [5, 6, 7, 8]) node.put(`notes/k${n}`, `value ${n}`);
    const hold = gate();
    let fetches = 0;
    node.onFetch = async () => {
      fetches += 1;
      // Page 1 of this sync (k5, k6) completes; page 2's content request is held.
      if (fetches === 2) {
        hold.arrive();
        await hold.opened;
      }
    };
    await page.evaluate(() => window.__kv.startSync("h", "run", 2));
    await hold.reached;
    await page.evaluate(() => window.__kv.abortSync("run"));
    const aborted = (await page.evaluate(() => window.__kv.awaitSync("run"))) as Outcome;
    hold.open();
    expect(aborted.ok).toBe(false);

    expect(await page.evaluate(() => window.__kv.get("h", "notes/k6"))).toMatchObject({ ok: true, value: { status: "present", value: "value 6", meta: { syncedThroughEpoch: 1 } } });
    expect(await page.evaluate(() => window.__kv.get("h", "notes/k7"))).toMatchObject({ ok: true, value: { status: "absent" } });
    expect(await page.evaluate(() => window.__kv.status("h"))).toMatchObject({ ok: true, value: { syncedThroughEpoch: 1 } });

    // The next sync resumes from the last committed page.
    node.onFetch = undefined;
    expect(await page.evaluate(() => window.__kv.sync("h", 3))).toMatchObject({ ok: true, value: { status: "synced", changes: 2, syncedThroughEpoch: 3 } });
    expect(await page.evaluate(() => window.__kv.get("h", "notes/k8"))).toMatchObject({ ok: true, value: { status: "present", value: "value 8" } });
  }, 60_000);

  test("close() during a sync cancels it and resolves only after it settles", async () => {
    const node = feed("close", 1);
    node.put("notes/a", "one");
    node.put("notes/b", "two");
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    await openGranted(page, "s", "h", "close");
    const hold = gate();
    node.onFetch = async () => {
      hold.arrive();
      await hold.opened;
    };
    await page.evaluate(() => window.__kv.startSync("h", "run", 5));
    await hold.reached;
    // The node still holds the content request: close() must cancel the
    // sync in the worker (aborting that request) and settle only after it.
    await page.evaluate(() => window.__kv.startClose("h"));
    await page.evaluate(() => window.__kv.awaitClose("h"));
    expect(await page.evaluate(() => window.__kv.settled())).toEqual(["sync:run", "close:h"]);
    hold.open();
    const sync = (await page.evaluate(() => window.__kv.awaitSync("run"))) as Outcome;
    expect(sync.ok).toBe(false);
    expect(await page.evaluate(() => window.__kv.get("h", "notes/a"))).toMatchObject({ ok: false, code: "REPLICA_CLOSED" });

    // Reopened: nothing past the cancelled page committed and the epoch never moved.
    await page.evaluate((spec) => window.__kv.open("s", "again", spec as never), specOf("close"));
    expect(await page.evaluate(() => window.__kv.get("again", "notes/a"))).toMatchObject({ ok: true, value: { status: "coverage_incomplete", meta: { syncedThroughEpoch: 0 } } });
  }, 60_000);

  test("a failure after the last feed page leaves the previous epoch", async () => {
    const node = feed("late");
    node.put("notes/a", "one");
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    await openGranted(page, "s", "h", "late");
    expect(await page.evaluate(() => window.__kv.sync("h", 4))).toMatchObject({ ok: true, value: { syncedThroughEpoch: 4 } });

    // The page's own content fetch finds b missing (committed with content=false);
    // the repair fetch after the last page then fails.
    node.put("notes/b", "two");
    node.tamper.set("notes/b", { missing: true });
    let fetches = 0;
    node.onFetch = () => {
      fetches += 1;
      if (fetches === 2) node.failNextFetch = new ReplicaError(ReplicaErrorCode.NETWORK_ERROR, "offline during repair");
    };
    const failed = (await page.evaluate(() => window.__kv.sync("h", 9))) as Outcome;
    expect(failed).toMatchObject({ ok: false, code: "NETWORK_ERROR" });
    expect(fetches).toBe(2);
    // The last page committed (b is known, content pending) but the fence did not move.
    expect(await page.evaluate(() => window.__kv.get("h", "notes/b"))).toMatchObject({ ok: true, value: { status: "content_missing", meta: { coverage: "complete", syncedThroughEpoch: 4 } } });
    expect(await page.evaluate(() => window.__kv.status("h"))).toMatchObject({ ok: true, value: { syncedThroughEpoch: 4 } });
  }, 60_000);

  test("caveated get or sync grants are refused, as are grants for another device", async () => {
    feed("caveat");
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    const opened = (await page.evaluate((spec) => window.__kv.open("s", "h", spec as never), specOf("caveat"))) as Outcome<{ deviceDid: string }>;
    if (!opened.ok) throw new Error(opened.message);
    const device = opened.value.deviceDid;
    const notes = `${SPACE}/kv/notes/`;
    const caveated = grantFor(device, { [notes]: { "tinycloud.kv/get": [{ maxBytes: 10 }], "tinycloud.kv/sync": [{}] } });
    expect(await page.evaluate(([jwt]) => window.__kv.installGrant("h", jwt), [caveated] as const)).toMatchObject({ ok: false, code: "GRANT_NOT_COVERING" });
    const caveatedSync = grantFor(device, { [notes]: { "tinycloud.kv/get": [{}], "tinycloud.kv/sync": [{ until: 1 }] } });
    expect(await page.evaluate(([jwt]) => window.__kv.installGrant("h", jwt), [caveatedSync] as const)).toMatchObject({ ok: false, code: "GRANT_NOT_COVERING" });
    const getOnly = grantFor(device, { [notes]: { "tinycloud.kv/get": [{}] } });
    expect(await page.evaluate(([jwt]) => window.__kv.installGrant("h", jwt), [getOnly] as const)).toMatchObject({ ok: false, code: "GRANT_NOT_COVERING" });
    const otherDevice = grantFor(keyPair().did);
    expect(await page.evaluate(([jwt]) => window.__kv.installGrant("h", jwt), [otherDevice] as const)).toMatchObject({ ok: false, code: "GRANT_AUDIENCE_MISMATCH" });
    expect(await page.evaluate(() => window.__kv.grant("h"))).toMatchObject({ ok: true, value: null });

    const good = deviceGrant({ aud: device });
    const installed = (await page.evaluate(([jwt]) => window.__kv.installGrant("h", jwt), [good.jwt] as const)) as Outcome;
    expect(installed).toEqual({
      ok: true,
      value: { cid: good.cid, parentCid: "bafyparent", expiresAt: good.expiresAt! * 1000, state: "pending", unconstrained: true },
    });
  }, 60_000);

  test("an injected device and the stored device get separate partitions; purge covers both without opening", async () => {
    const node = feed("devices");
    node.put("notes/a", "one");
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    const session = keyPair();
    const stored = await openGranted(page, "s", "stored", "devices");
    const injected = await openGranted(page, "s", "injected", "devices", { device: { did: session.did, jwk: { kty: "OKP" } } });
    expect(injected).toBe(session.did);
    expect(stored).not.toBe(session.did);
    expect(await page.evaluate(() => window.__kv.sync("stored", 1))).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.__kv.sync("injected", 1))).toMatchObject({ ok: true });
    const meta = (await page.evaluate(() => window.__kv.dump())).meta!;
    expect(Object.keys(meta)).toHaveLength(2);

    // A second tab that never opened anything purges both devices' partitions.
    const other = await kvPage();
    await other.evaluate(() => window.__kv.createStorage("s", "fake"));
    const purged = (await other.evaluate(([identity, did]) => window.__kv.purge("s", { identity, space: identity.space, prefix: "notes/", sessionDeviceDid: did }), [identityOf("devices"), session.did] as const)) as Outcome;
    expect(purged).toEqual({ ok: true, value: undefined });
    const dump = await page.evaluate(() => window.__kv.dump());
    expect(dump.entries).toEqual({});
    expect(dump.blobs).toEqual({});
    expect(await page.evaluate(() => window.__kv.get("stored", "notes/a"))).toMatchObject({ ok: false, code: "RESET_REQUIRED" });
    expect(await page.evaluate(() => window.__kv.get("injected", "notes/a"))).toMatchObject({ ok: false, code: "RESET_REQUIRED" });
  }, 60_000);

  test("purge never creates the database, and inspectStatus never creates a replica", async () => {
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    expect(await page.evaluate((identity) => window.__kv.purge("s", { identity, space: identity.space, prefix: "notes/" }), identityOf("none"))).toEqual({ ok: true, value: undefined });
    expect(await page.evaluate((spec) => window.__kv.inspectStatus("s", spec as never), specOf("none"))).toEqual({ ok: true, value: undefined });
    expect(await page.evaluate(() => window.__kv.databases())).not.toContain("tinycloud-replica-kv");

    const node = feed("inspect");
    node.put("notes/a", "one");
    await openGranted(page, "s", "h", "inspect");
    expect(await page.evaluate(() => window.__kv.sync("h", 2))).toMatchObject({ ok: true });
    const other = await kvPage();
    await other.evaluate(() => window.__kv.createStorage("s", "fake"));
    expect(await other.evaluate((spec) => window.__kv.inspectStatus("s", spec as never), specOf("inspect"))).toMatchObject({
      ok: true,
      value: { syncedThroughEpoch: 2, coverage: "complete", counts: { keys: 1 }, grant: { state: "active" } },
    });
    // A partition that was never opened stays absent.
    expect(await other.evaluate((spec) => window.__kv.inspectStatus("s", spec as never), { ...specOf("inspect"), prefix: "other/" })).toEqual({ ok: true, value: undefined });
    expect(Object.keys((await page.evaluate(() => window.__kv.dump())).meta!)).toHaveLength(1);
  }, 60_000);

  test("two tabs writing pending records at once lose nothing", async () => {
    const [one, two] = [await kvPage(), await kvPage()];
    for (const page of [one, two]) await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    const identity = identityOf("pending");
    const [a, b] = await Promise.all([
      one.evaluate((id) => window.__kv.pendingWrites("s", id, "one", 25), identity),
      two.evaluate((id) => window.__kv.pendingWrites("s", id, "two", 25), identity),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const state = (await one.evaluate((id) => window.__kv.pendingRead("s", id), identity)) as Outcome<{ seq: number; records: Array<{ opId: string }> }>;
    if (!state.ok) throw new Error(state.message);
    expect(state.value.seq).toBe(50);
    expect(new Set(state.value.records.map((record) => record.opId)).size).toBe(50);
    // Durable: a reloaded tab reads the same state.
    await two.reload();
    await two.waitForFunction(() => window.__kv !== undefined);
    await two.evaluate(() => window.__kv.createStorage("s", "fake"));
    expect(await two.evaluate((id) => window.__kv.pendingRead("s", id), identity)).toMatchObject({ ok: true, value: { seq: 50 } });
  }, 60_000);

  test("QuotaExceededError in the middle of a page commits nothing from that page", async () => {
    const node = feed("quota", 1);
    node.put("notes/small", "small value");
    const page = await kvPage();
    // Before the worker's first connection: Chromium reads the quota when a connection opens.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 4 * 1024 * 1024 });
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    await openGranted(page, "s", "h", "quota");
    expect(await page.evaluate(() => window.__kv.sync("h", 1))).toMatchObject({ ok: true });

    node.put("notes/fits", "x".repeat(1024));
    // Incompressible: Chromium compresses IndexedDB values, so a filled buffer would fit.
    node.put("notes/huge", randomBytes(8 * 1024 * 1024));
    const failed = (await page.evaluate(() => window.__kv.sync("h", 2))) as Outcome;
    expect(failed).toMatchObject({ ok: false, code: "STORAGE_FULL" });
    // The page before the oversized one committed; the oversized page did not.
    expect(await page.evaluate(() => window.__kv.get("h", "notes/fits"))).toMatchObject({ ok: true, value: { status: "present", meta: { syncedThroughEpoch: 1 } } });
    expect(await page.evaluate(() => window.__kv.get("h", "notes/huge"))).toMatchObject({ ok: true, value: { status: "absent" } });
    expect(await page.evaluate(() => window.__kv.status("h"))).toMatchObject({ ok: true, value: { syncedThroughEpoch: 1, lastError: { code: "STORAGE_FULL" } } });
    await cdp.send("Storage.overrideQuotaForOrigin", { origin });
  }, 60_000);

  test("a sibling tab hears the commit as onPeerCommit; the committing handle does not", async () => {
    const node = feed("peer");
    node.put("notes/a", "one");
    const [writer, reader] = [await kvPage(), await kvPage()];
    for (const page of [writer, reader]) await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    await openGranted(writer, "s", "w", "peer");
    const opened = (await reader.evaluate((spec) => window.__kv.open("s", "r", spec as never), specOf("peer"))) as Outcome;
    expect(opened.ok).toBe(true);
    expect(await writer.evaluate(() => window.__kv.sync("w", 11))).toMatchObject({ ok: true });
    await reader.waitForFunction(() => window.__kv.peerCommits("r").length > 0);
    expect(await reader.evaluate(() => window.__kv.peerCommits("r"))).toEqual([{ at: expect.any(Number), syncedThroughEpoch: 11, changes: 1, coverage: "complete" }]);
    expect(await writer.evaluate(() => window.__kv.peerCommits("w"))).toEqual([]);
    // The reader serves the writer's commit from the shared partition.
    expect(await reader.evaluate(() => window.__kv.get("r", "notes/a"))).toMatchObject({ ok: true, value: { status: "present", value: "one" } });
  }, 60_000);

  test("a killed worker restarts cleanly: the next call reopens and serves current data", async () => {
    const node = feed("kill");
    node.put("notes/a", "one");
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    await openGranted(page, "s", "h", "kill");
    expect(await page.evaluate(() => window.__kv.sync("h", 1))).toMatchObject({ ok: true });
    await page.evaluate(() => window.__kv.killWorker("s"));
    node.put("notes/a", "two");
    expect(await page.evaluate(() => window.__kv.sync("h", 2))).toMatchObject({ ok: true, value: { syncedThroughEpoch: 2 } });
    expect(await page.evaluate(() => window.__kv.get("h", "notes/a"))).toMatchObject({ ok: true, value: { status: "present", value: "two" } });
  }, 60_000);
});
