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
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

import { FakeNode, SPACE, deviceGrant, keyPair, owner, signUcan } from "./fixtures.js";
import { ReplicaError, ReplicaErrorCode, isReplicaError } from "../src/errors.js";

async function freePort(): Promise<number> {
  const { promise, resolve: done, reject: fail } = Promise.withResolvers<number>();
  const listener = createServer();
  listener.once("error", fail);
  listener.listen(0, "127.0.0.1", () => {
    const { port } = listener.address() as { port: number };
    listener.close(() => done(port));
  });
  return promise;
}

const FIXTURE_DIST = resolve(import.meta.dir, "browser/fixture/dist");
/**
 * Runs where the fixture is built (the `browser-e2e` CI job and local runs);
 * TC_KV_STORAGE_E2E=1 makes a missing build an error instead of a skip.
 */
const RUN = existsSync(join(FIXTURE_DIST, "kv.html")) || process.env.TC_KV_STORAGE_E2E === "1";
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
const specOf = (name: string, extra: Record<string, unknown> = {}) => ({ identity: identityOf(name), space: SPACE, prefix: "notes/", allowSecrets: false, grantPolicy: { grantTtlMs: 60_000, consentAnchor: null }, ...extra });

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
  if (!RUN) return;
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

describe.skipIf(!RUN)("kv-storage over a fake feed (Chromium)", () => {
  test("grant policy keeps the first CID install time and expires reads inside the gated store", async () => {
    const node = feed("policy");
    node.put("notes/a", "private");
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    const anchor = Date.now() - 6 * 24 * 60 * 60 * 1000;
    const policy = { grantTtlMs: 5_000, consentAnchor: { at: anchor, source: "siwe" } };
    const spec = specOf("policy", { grantPolicy: policy });
    const opened = (await page.evaluate((s) => window.__kv.open("s", "h", s as never), spec)) as Outcome<{ deviceDid: string }>;
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const jwt = grantFor(opened.value.deviceDid);
    const installed = (await page.evaluate((grant) => window.__kv.installGrant("h", grant), jwt)) as Outcome<{
      installedAt: number; effectiveExpiresAt: number; consentDeadline: number; consentAnchor: { at: number; source: string };
    }>;
    expect(installed).toMatchObject({ ok: true, value: { consentDeadline: anchor + 7 * 24 * 60 * 60 * 1000, consentAnchor: { at: anchor, source: "siwe" } } });
    if (!installed.ok) return;
    expect(installed.value.effectiveExpiresAt).toBe(installed.value.installedAt + 5_000);
    expect(await page.evaluate((grant) => window.__kv.installGrant("h", grant), jwt)).toMatchObject({ ok: true, value: { installedAt: installed.value.installedAt } });
    expect(await page.evaluate(() => window.__kv.sync("h", 3))).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.__kv.get("h", "notes/a"))).toMatchObject({ ok: true, value: { status: "present", value: "private" } });
    await page.evaluate(() => window.__kv.close("h"));
    const shorter = specOf("policy", { grantPolicy: { ...policy, grantTtlMs: 1 } });
    expect(await page.evaluate((s) => window.__kv.open("s", "shorter", s as never), shorter)).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.__kv.grant("shorter"))).toMatchObject({
      ok: true, value: { installedAt: installed.value.installedAt, effectiveExpiresAt: installed.value.installedAt + 1 },
    });
    expect(await page.evaluate(() => window.__kv.get("shorter", "notes/a"))).toMatchObject({ ok: false, code: "GRANT_EXPIRED" });
    expect(await page.evaluate(() => window.__kv.list("shorter", "notes/"))).toMatchObject({ ok: false, code: "GRANT_EXPIRED" });
  }, 60_000);

  test("first-install consent and a CID install time survive partition purge and reinstall", async () => {
    feed("reinstall").put("notes/a", "one");
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    const spec = specOf("reinstall", { grantPolicy: { grantTtlMs: 60_000, consentAnchor: null } });
    const opened = (await page.evaluate((s) => window.__kv.open("s", "h", s as never), spec)) as Outcome<{ deviceDid: string }>;
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const jwt = grantFor(opened.value.deviceDid);
    const initial = (await page.evaluate((ucan) => window.__kv.installGrant("h", ucan), jwt)) as Outcome<{ installedAt: number; consentAnchor: { at: number; source: string } }>;
    expect(initial).toMatchObject({ ok: true, value: { consentAnchor: { source: "first_install" } } });
    if (!initial.ok) return;
    expect(initial.value.consentAnchor.at).toBe(initial.value.installedAt);
    await page.evaluate(() => window.__kv.close("h"));
    expect(await page.evaluate((identity) => window.__kv.purge("s", { identity, space: identity.space, prefix: "notes/" }), identityOf("reinstall"))).toMatchObject({ ok: true });
    const again = (await page.evaluate((s) => window.__kv.open("s", "again", s as never), spec)) as Outcome<{ deviceDid: string }>;
    expect(again).toMatchObject({ ok: true, value: { deviceDid: opened.value.deviceDid } });
    expect(await page.evaluate((ucan) => window.__kv.installGrant("again", ucan), jwt)).toMatchObject({
      ok: true, value: { installedAt: initial.value.installedAt, consentAnchor: initial.value.consentAnchor },
    });
  }, 60_000);

  test("open refuses a missing grant policy before any partition is created", async () => {
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    expect(await page.evaluate((spec) => window.__kv.open("s", "h", spec as never), { ...specOf("missing-policy"), grantPolicy: undefined })).toMatchObject({
      ok: false, code: "REPLICA_INVALID_ARGUMENT",
    });
  }, 60_000);

  test("rejects secrets and vault scopes even when allowSecrets is true", async () => {
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    for (const extra of [
      { allowSecrets: true },
      { space: "secrets" },
      { prefix: "vault/" },
      { prefix: "secrets/" },
      { prefix: "/" },
      { allowSecrets: true, space: "secrets", prefix: "vault/" },
    ]) {
      expect(await page.evaluate((spec) => window.__kv.open("s", "h", spec as never), specOf("excluded", extra)))
        .toMatchObject({ ok: false, code: "REPLICA_INVALID_ARGUMENT" });
    }
  }, 60_000);

  test("raw origin IndexedDB rows contain no recognizable replica content, key, metadata or pending key", async () => {
    const marker = "s1-ciphertext-only-unique-marker";
    const key = `notes/${marker}-key`;
    const metadata = `${marker}-metadata`;
    feed("sealed").put(key, marker, { title: metadata });
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    await openGranted(page, "s", "h", "sealed");
    expect(await page.evaluate(() => window.__kv.sync("h", 7))).toMatchObject({ ok: true, value: { status: "synced" } });
    expect(await page.evaluate((path) => window.__kv.get("h", path), key)).toMatchObject({ ok: true, value: { status: "present", value: marker } });
    expect(await page.evaluate((identity) => window.__kv.pendingWrites("s", identity, "s1-ciphertext-only-unique-marker", 1), identityOf("sealed"))).toMatchObject({ ok: true });
    const scan = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("tinycloud-replica-kv");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const out: Record<string, { rows: number; raw: string }> = {};
      for (const name of ["blobs", "entries", "meta", "pending", "device", "partitions", "gate", "purgeIntents", "quota"]) {
        const store = db.transaction(name).objectStore(name);
        const [rows, keys] = await Promise.all(
          [store.getAll(), store.getAllKeys()].map((request) => new Promise<unknown[]>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          })),
        ) as [unknown[], unknown[]];
        out[name] = { rows: rows.length, raw: JSON.stringify({ rows, keys }, (_key, value: unknown) =>
          value instanceof Uint8Array ? new TextDecoder().decode(value) : value) };
      }
      db.close();
      const markers = Object.keys(localStorage).filter((name) => name.startsWith("tinycloud-replica"));
      out.localStorage = { rows: markers.length, raw: JSON.stringify(markers.map((name) => [name, localStorage.getItem(name)])) };
      return out;
    });
    for (const name of ["blobs", "entries", "meta", "pending", "device", "partitions"]) {
      expect(scan[name]?.rows ?? 0).toBeGreaterThan(0);
    }
    for (const name of ["blobs", "entries", "meta", "pending", "device", "partitions", "gate", "purgeIntents", "quota", "localStorage"]) {
      const raw = scan[name]?.raw;
      expect(raw).not.toContain(marker);
      expect(raw).not.toContain("notes/");
      expect(raw).not.toContain(SPACE);
      expect(raw).not.toContain(PRINCIPAL);
    }
    const markers = JSON.parse(scan.localStorage?.raw ?? "[]") as Array<[string, string | null]>;
    for (const [name, value] of markers) {
      expect(name).toBe("tinycloud-replica:logout-pending");
      expect(value).toMatch(/^\d+$/);
    }
    expect(scan.device?.raw).not.toContain('"jwk"');
  }, 60_000);

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
    const replicaId = await page.evaluate(() => window.__kv.replicaId("h"));
    expect(replicaId).toMatch(/^[0-9a-f]{64}$/);
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

  test("close() while a sync reopens a killed worker waits and prevents that sync", async () => {
    feed("close-race").put("notes/a", "one");
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    await openGranted(page, "s", "h", "close-race");
    await page.evaluate(() => window.__kv.killWorker("s"));
    await page.evaluate(() => {
      window.__kv.startSync("h", "queued", 5);
      window.__kv.startClose("h");
    });
    await page.evaluate(() => window.__kv.awaitClose("h"));
    expect(await page.evaluate(() => window.__kv.settled())).toEqual(["sync:queued", "close:h"]);
    expect((await page.evaluate(() => window.__kv.awaitSync("queued")) as Outcome).ok).toBe(false);
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
    expect(installed).toMatchObject({
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
    expect(dump.partitions).toEqual({});
    expect(await page.evaluate(() => window.__kv.get("stored", "notes/a"))).toMatchObject({ ok: false, code: "RESET_REQUIRED" });
    expect(await page.evaluate(() => window.__kv.get("injected", "notes/a"))).toMatchObject({ ok: false, code: "RESET_REQUIRED" });
  }, 60_000);

  test("purge refuses an identity outside the active gate principal", async () => {
    const node = feed("foreign-purge");
    node.put("notes/a", "one");
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    await openGranted(page, "s", "h", "foreign-purge");
    expect(await page.evaluate(() => window.__kv.sync("h", 1))).toMatchObject({ ok: true });
    const foreign = { ...identityOf("foreign-purge"), principal: "did:pkh:eip155:1:0x00000000000000000000000000000000000000c2" };
    expect(await page.evaluate((identity) => window.__kv.purge("s", { identity, space: identity.space, prefix: "notes/" }), foreign))
      .toMatchObject({ ok: false, code: "REPLICA_GATED", gate: "principal_mismatch" });
    expect(await page.evaluate(() => window.__kv.get("h", "notes/a"))).toMatchObject({ ok: true, value: { status: "present", value: "one" } });
  }, 60_000);

  test("purge without a gate refuses and never creates the database; inspectStatus never creates a replica", async () => {
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    expect(await page.evaluate((spec) => window.__kv.inspectAborted("s", spec as never), specOf("none"))).toMatchObject({ ok: false });
    expect(await page.evaluate((identity) => window.__kv.purge("s", { identity, space: identity.space, prefix: "notes/" }), identityOf("none"))).toMatchObject({ ok: false, code: "REPLICA_GATED", gate: "not_established" });
    expect(await page.evaluate((spec) => window.__kv.inspectStatus("s", spec as never), specOf("none"))).toEqual({ ok: true, value: undefined });
    expect(await page.evaluate(() => window.__kv.databases())).not.toContain("tinycloud-replica-kv");

    const node = feed("inspect");
    node.put("notes/a", "one");
    await openGranted(page, "s", "h", "inspect");
    expect(await page.evaluate(() => window.__kv.sync("h", 2))).toMatchObject({ ok: true });
    const other = await kvPage();
    await other.evaluate(() => window.__kv.createStorage("s", "fake"));
    const inspected = await other.evaluate((spec) => window.__kv.inspectStatus("s", spec as never), specOf("inspect"));
    expect(inspected).toMatchObject({
      ok: true,
      value: { redacted: true, syncedThroughEpoch: 2, coverage: "complete", counts: { keys: 1 } },
    });
    if (inspected.ok) {
      expect(inspected.value).not.toHaveProperty("grant");
      expect(inspected.value).not.toHaveProperty("authority");
      expect(inspected.value).not.toHaveProperty("lastError");
    }
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
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
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
    await page.evaluate(() => window.__kv.createStorage("s", "fake", { minFreeBytes: 0 }));
    await openGranted(page, "s", "h", "quota", { quota: { minFreeBytes: 0 } });
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
    const readerStamp = await reader.evaluate((principal) => window.__kv.establish(principal), PRINCIPAL);
    await reader.evaluate((stamp) => window.__kv.revoke(stamp), readerStamp);
    node.put("notes/b", "two");
    expect(await writer.evaluate(() => window.__kv.sync("w", 12))).toMatchObject({ ok: true });
    // An already-open receiver must not deliver a peer event after its session is revoked.
    await reader.waitForTimeout(100);
    expect(await reader.evaluate(() => window.__kv.peerCommits("r"))).toHaveLength(1);
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

  test("without a stamp, open fails closed", async () => {
    feed("closed");
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    expect(await page.evaluate((spec) => window.__kv.open("s", "h", { ...spec, stamp: null } as never), specOf("closed"))).toMatchObject({ ok: false, code: "REPLICA_GATED", gate: "not_established" });
  }, 60_000);

  test("after the gate moves, the worker refuses reads, syncs and installs; a revoked view drops replies on the main thread", async () => {
    const node = feed("gated");
    node.put("notes/a", "one");
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "fake"));
    const deviceDid = await openGranted(page, "s", "h", "gated");
    expect(await page.evaluate(() => window.__kv.sync("h", 1))).toMatchObject({ ok: true });

    // The main-thread delivery check: this tab's view refuses the stamp; nothing is delivered.
    const stamp = await page.evaluate((principal) => window.__kv.establish(principal), PRINCIPAL);
    await page.evaluate((s) => window.__kv.revoke(s), stamp);
    expect(await page.evaluate(() => window.__kv.get("h", "notes/a"))).toMatchObject({ ok: false, code: "REPLICA_GATED", gate: "stamp_stale" });

    // Another tab signs out at the gate: a fresh tab's old handle is refused inside the worker's transactions.
    const other = await kvPage();
    await other.evaluate(() => window.__kv.createStorage("s", "fake"));
    await other.evaluate((spec) => window.__kv.open("s", "h", spec as never), specOf("gated"));
    expect(await other.evaluate(() => window.__kv.get("h", "notes/a"))).toMatchObject({ ok: true, value: { status: "present" } });
    await other.evaluate(() => window.__kv.deny());
    expect(await other.evaluate(() => window.__kv.get("h", "notes/a"))).toMatchObject({ ok: false, code: "REPLICA_GATED", gate: "stamp_stale" });
    expect(await other.evaluate(() => window.__kv.sync("h", 2))).toMatchObject({ ok: false, code: "REPLICA_GATED" });
    expect(await other.evaluate(([jwt]) => window.__kv.installGrant("h", jwt), [grantFor(deviceDid)] as const)).toMatchObject({ ok: false, code: "REPLICA_GATED" });
  }, 60_000);
});

const NODE_BIN = process.env.TC_REPLICA_E2E_NODE_BIN ?? process.env.TC_NODE_BIN;

describe.skipIf(!RUN || NODE_BIN === undefined)("kv-storage against a real node (Chromium, published worker)", () => {
  let dataDir = "";
  let node: ChildProcess | undefined;
  let host = "";
  let nodeOwner: TinyCloudNode;
  let space = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join("/var/tmp", "tc-kv-storage-node-"));
    const port = await freePort();
    host = `http://127.0.0.1:${port}`;
    const child = spawn(NODE_BIN!, [], {
      cwd: dataDir,
      env: {
        ...process.env,
        TINYCLOUD_STORAGE__DATADIR: join(dataDir, "data"),
        TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
        TINYCLOUD_ADDRESS: "127.0.0.1",
        TINYCLOUD_PORT: String(port),
        ROCKET_PORT: String(port),
        ROCKET_ADDRESS: "127.0.0.1",
        TINYCLOUD_KEYS__TYPE: "Static",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    node = child;
    const launched = Promise.withResolvers<void>();
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Rocket has launched")) launched.resolve();
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("exit", (code) => launched.reject(new Error(`node exited (${code}) before launching:\n${output.slice(-2000)}`)));
    await launched.promise;
    nodeOwner = new TinyCloudNode({ privateKey: `0x${randomBytes(32).toString("hex")}`, host, autoCreateSpace: true });
    await nodeOwner.signIn();
    space = nodeOwner.session!.spaceId;
    const put = await nodeOwner.kv.put("notes/a", new TextEncoder().encode("from the node"));
    if (!put.ok) throw new Error(`kv put failed: ${JSON.stringify(put.error)}`);
  }, 120_000);

  afterAll(async () => {
    const child = node;
    if (child !== undefined && child.exitCode === null) {
      const exited = Promise.withResolvers<void>();
      child.once("exit", () => exited.resolve());
      child.kill("SIGTERM");
      await exited.promise;
    }
    if (dataDir !== "") await rm(dataDir, { recursive: true, force: true });
  });

  /** The node ships no CORS headers; add them at the driver layer, as browser.e2e does. */
  async function corsToNode(): Promise<void> {
    await context.route(`${host}/**`, async (route) => {
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, tinycloud-trace-id, x-tinycloud-*",
      };
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    });
  }

  test("with the WASM signing path, the worker mints its device, installs a delegated grant, signs a real sync and serves reads", async () => {
    await corsToNode();
    const page = await kvPage();
    await page.evaluate(() => window.__kv.createStorage("s", "real"));
    const spec = { identity: { host, space, principal: nodeOwner.did }, space, prefix: "notes/", allowSecrets: false, grantPolicy: { grantTtlMs: 60_000, consentAnchor: null } };
    const opened = (await page.evaluate((s) => window.__kv.open("s", "h", s as never), spec)) as Outcome<{ deviceDid: string }>;
    if (!opened.ok) throw new Error(`open failed: ${opened.code} ${opened.message}`);
    const requested = [{ service: "tinycloud.kv", space, path: "notes/", actions: ["get", "list", "metadata", "sync"] }];
    // `tinycloud.kv/sync` is explicit-only (TC-732): the owner grants itself the runtime permission first.
    await nodeOwner.grantRuntimePermissions(requested as never, { expiry: "1d" });
    const minted = await nodeOwner.delegateTo(opened.value.deviceDid, requested as never, {});
    const jwt = minted.delegation.delegationHeader.Authorization;
    expect(await page.evaluate((ucan) => window.__kv.installGrant("h", ucan), jwt)).toMatchObject({ ok: true, value: { state: "pending", unconstrained: true } });
    expect(await page.evaluate(() => window.__kv.sync("h", 3))).toMatchObject({ ok: true, value: { status: "synced", coverage: "complete", syncedThroughEpoch: 3 } });
    expect(await page.evaluate(() => window.__kv.get("h", "notes/a"))).toMatchObject({
      ok: true,
      value: { status: "present", value: "from the node", meta: { coverage: "complete", authority: "valid", syncedThroughEpoch: 3 } },
    });
    expect(await page.evaluate(() => window.__kv.grant("h"))).toMatchObject({ ok: true, value: { state: "active" } });
  }, 120_000);

  // Parked until the runtime sets session stamps (CONTRACT rev 2: the gate is mandatory and the
  // node-sdk runtime does not pass `deps.stamp` yet); the acceptance suite runs this scenario
  // against the real lifecycle gate.
  test.skip("TinyCloudNode with replication on indexedDbReplicaStorage serves reads from the replica", async () => {
    await corsToNode();
    const page = await context.newPage();
    await page.goto(`${origin}/node.html`);
    await page.waitForFunction(() => window.__node !== undefined);
    const result = await page.evaluate((input) => window.__node.run(input), { host, privateKey: `0x${randomBytes(32).toString("hex")}` });
    expect(result.value).toBe("served locally");
    expect(result.syncs).toContain("ok");
    // After the sync, a covered get is answered by the replica.
    expect(result.reads.at(-1)).toEqual({ op: "get", source: "replica", reason: "hit", key: expect.stringContaining("notes/a") });
  }, 180_000);
});
