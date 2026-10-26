/**
 * TC-858 S6: real-Chromium acceptance for browser read-through replication
 * (plan §10). The fixture is `test/browser/acceptance`, a Vite app that drives
 * `TinyCloudWeb` through its own sign-in, grant and session flow. Each scenario
 * runs in a fresh browser context so IndexedDB never leaks between scenarios.
 *
 * Scenario numbers follow plan §10. Deny-failure variants are 8a-8c; 8d
 * probes the stale tab's pending store across deny, erase and fresh sign-in.
 *
 * Gating: `TC858_ACCEPTANCE_STRICT=1` (set by the CI step) runs every scenario; a missing node
 * binary, missing fixture build or any todo/skip is a failure in strict mode. Without it (a laptop
 * with no node binary) the scenarios are recorded as `test.todo` and nothing is asserted.
 * S1-S5 are on master: the fixture runs `TinyCloudWeb` with `@tinycloud/web-sdk/replica` and
 * the real IndexedDB adapter, using the `@tinycloud/replica/kv-storage/testing` seams.
 *
 * Needs TC_REPLICA_E2E_NODE_BIN (or TC_NODE_BIN): a tinycloud node binary
 * serving `kv-sync-v1`. Build the fixture with `bunx vite build` in
 * `test/browser/acceptance`. Install Chromium with `bunx playwright install chromium`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NODE_BIN = process.env.TC_REPLICA_E2E_NODE_BIN ?? process.env.TC_NODE_BIN;
const STRICT = process.env.TC858_ACCEPTANCE_STRICT === "1";
const FIXTURE_DIST = resolve(import.meta.dir, "browser/acceptance/dist");
/** Throwaway wallets. The owner and the fixture pages share WALLET_KEY, so one identity; ACCOUNT_B is a second one. */
const WALLET_KEY = `0x${randomBytes(32).toString("hex")}`;
const ACCOUNT_B_KEY = `0x${randomBytes(32).toString("hex")}`;
const nodeSecret = randomBytes(48).toString("base64url");

/** Runs the scenario in strict mode; otherwise records it as a todo so CI stays green. */
function scenario(name: string, body: () => Promise<void>): void {
  if (STRICT) test(name, body, 180_000);
  else test.todo(name, () => {});
}

/** One `replication.read` event, as emitted by the controller's `readEvent`. */
type ReadEvent = {
  source: "replica" | "network" | "none";
  reason: string;
  outcome: "found" | "not_found" | "error";
  syncError?: string;
};

/** Events the fixture recorded through `onEvent` since its last `boot`, filtered by `type`. */
async function replicationEventsOf(page: Page, type: string): Promise<Array<Record<string, unknown>>> {
  const events = (await page.evaluate(() => window.__tcw.replicationEvents())) as Array<Record<string, unknown>>;
  return events.filter((event) => event.type === type);
}

/** The first `tcw.replication.status()` entry (one configured prefix, so one entry). */
type StatusEntry = {
  state: string;
  gate?: string;
  prefix: string;
  grant?: { cid: string; expiresAt: number | null; effectiveExpiresAt?: number } | null;
  syncedThroughEpoch?: number;
  counts?: { keys: number };
};
async function statusOf(page: Page): Promise<StatusEntry> {
  const entries = (await page.evaluate(() => window.__tcw.replicationStatus())) as StatusEntry[];
  const entry = entries[0];
  if (entry === undefined) throw new Error("tcw.replication.status() returned no entries");
  return entry;
}

type SyncResult = { status: "ok" } | { status: "error"; code: string; message: string; gate?: string };

/**
 * Rows the replica holds for KV content (sealed entries and blobs; erase leaves a tombstone meta row and the partition index entry). Replica rows are
 * AES-GCM sealed, so a plaintext scan cannot prove the replica is populated; this count does.
 */
async function contentRows(page: Page): Promise<number> {
  const rows = await page.evaluate(() => window.__tcw.replicaRows());
  return (rows.entries ?? 0) + (rows.blobs ?? 0);
}

/** The most recent `replication.read` event. Throws when the read emitted none. */
async function lastRead(page: Page): Promise<ReadEvent> {
  const reads = await replicationEventsOf(page, "replication.read");
  const last = reads.at(-1);
  if (last === undefined) throw new Error("no replication.read event recorded");
  return last as ReadEvent;
}

async function freePort(): Promise<number> {
  const { promise, resolve: done, reject: fail } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", fail);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    server.close(() => done(port));
  });
  return promise;
}

if (STRICT) {
  test("strict mode has its prerequisites: a node binary and the built fixture page", () => {
    expect(NODE_BIN, "TC_REPLICA_E2E_NODE_BIN must point at the pinned tinycloud node binary").toBeDefined();
    expect(existsSync(join(FIXTURE_DIST, "index.html")), "run `bunx vite build` in test/browser/acceptance first").toBe(true);
    expect(existsSync(join(FIXTURE_DIST, "baseline.html"))).toBe(true);
  });
}

describe.skipIf(NODE_BIN === undefined)("TC-858 browser replication acceptance (Chromium)", () => {
  let dataDir = "";
  let host = "";
  let node: ChildProcess | undefined;
  let fixtureServer: Bun.Server<undefined> | undefined;
  let origin = "";
  let browser: Browser | undefined;
  let owner: TinyCloudNode | undefined;

  async function startNode(port: number): Promise<void> {
    const child = spawn(NODE_BIN!, [], {
      cwd: dataDir,
      env: {
        ...process.env,
        TINYCLOUD_STORAGE__DATADIR: join(dataDir, "data"),
        TINYCLOUD_KEYS__SECRET: nodeSecret,
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
  }

  async function stopNode(): Promise<void> {
    const child = node;
    node = undefined;
    if (child === undefined || child.exitCode !== null) return;
    const exited = Promise.withResolvers<void>();
    child.once("exit", () => exited.resolve());
    child.kill("SIGTERM");
    await exited.promise;
  }

  /** The owner's KV writes seed what the fixture reads. */
  async function kvPut(key: string, value: string): Promise<void> {
    if (owner === undefined) throw new Error("owner not signed in");
    const result = await owner.kv.put(key, new TextEncoder().encode(value));
    if (!result.ok) throw new Error(`kv put ${key} failed: ${JSON.stringify(result.error)}`);
  }

  /** Revokes the device grant a replica is running under (the deny trigger in 8 and 9). */
  async function revokeGrantOf(page: Page): Promise<void> {
    if (owner === undefined) throw new Error("owner not signed in");
    const grantCid = (await statusOf(page)).grant?.cid;
    if (typeof grantCid !== "string") throw new Error("the replica status entry has no installed grant to revoke");
    const revoked = await owner.revokeDelegation(grantCid);
    if (!revoked.ok) throw new Error(`revoke failed: ${JSON.stringify(revoked.error)}`);
  }

  /**
   * True if any IndexedDB value in the page's origin contains `needle`.
   * Walks every object store recursively, decoding byte arrays, so binary
   * blobs are checked too. `""` answers "does the origin hold any stored text".
   */
  async function originStoresContain(page: Page, needle: string): Promise<boolean> {
    return page.evaluate(async (target) => {
      const decoder = new TextDecoder();
      const texts = (value: unknown): string[] => {
        if (typeof value === "string") return [value];
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return [decoder.decode(value)];
        if (Array.isArray(value)) return value.flatMap(texts);
        if (value !== null && typeof value === "object") return Object.values(value).flatMap(texts);
        return [];
      };
      const request = <T>(req: IDBRequest<T>): Promise<T> =>
        new Promise((ok, fail) => {
          req.onsuccess = () => ok(req.result);
          req.onerror = () => fail(req.error);
        });
      for (const info of await indexedDB.databases()) {
        if (info.name === undefined) continue;
        const db = await request(indexedDB.open(info.name));
        try {
          for (const storeName of Array.from(db.objectStoreNames)) {
            const values = await request(db.transaction(storeName).objectStore(storeName).getAll());
            for (const value of values) {
              if (texts(value).some((text) => text.includes(target))) return true;
            }
          }
        } finally {
          db.close();
        }
      }
      return false;
    }, needle);
  }

  /**
   * Contexts whose node requests are refused. Playwright's `setOffline` cannot be used: the node
   * is reached through a driver-side `route.fetch`, which it does not affect, and it would also
   * block the fixture reload. The fixture itself stays reachable, like a cached app shell.
   */
  const offline = new Set<BrowserContext>();

  /** Closes a context without failing on node requests still in flight through the CORS route. */
  async function closeContext(context: BrowserContext): Promise<void> {
    await context.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  }

  /** A fresh context with the node origin's CORS headers added at the driver layer. */
  async function newContext(): Promise<BrowserContext> {
    if (browser === undefined) throw new Error("browser not launched");
    const context = await browser.newContext();
    await context.route(`${host}/**`, async (route) => {
      if (offline.has(context)) {
        await route.abort("internetdisconnected");
        return;
      }
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
    return context;
  }

  beforeAll(async () => {
    if (!STRICT) return;
    dataDir = await mkdtemp(join(tmpdir(), "tc858-acceptance-node-"));
    const nodePort = await freePort();
    host = `http://127.0.0.1:${nodePort}`;
    await startNode(nodePort);

    const fixturePort = await freePort();
    origin = `http://127.0.0.1:${fixturePort}`;
    fixtureServer = Bun.serve({
      port: fixturePort,
      async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = Bun.file(join(FIXTURE_DIST, path));
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".html") ? "text/html" : path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
        return new Response(file, { headers: { "content-type": type } });
      },
    });

    owner = new TinyCloudNode({ privateKey: WALLET_KEY, host, autoCreateSpace: true });
    await owner.signIn();
    await kvPut("notes/a", "alpha note");
    await kvPut("notes/b", "beta note");
    await kvPut("notes-secret/x", "OUT-OF-SCOPE-SECRET");
    const ownerB = new TinyCloudNode({ privateKey: ACCOUNT_B_KEY, host, autoCreateSpace: true });
    await ownerB.signIn();
    const putB = await ownerB.kv.put("notes/b-only", new TextEncoder().encode("belongs to B"));
    if (!putB.ok) throw new Error(`account B seed failed: ${JSON.stringify(putB.error)}`);
    browser = await chromium.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    fixtureServer?.stop();
    await stopNode();
    if (dataDir !== "") await rm(dataDir, { recursive: true, force: true });
  });

  /** Node requests issued by each page, counted from the page's own `request` events. */
  const nodeRequestCounts = new WeakMap<Page, { count: number }>();
  const nodeRequests = (page: Page): number => nodeRequestCounts.get(page)?.count ?? 0;

  /**
   * Waits until a page's own sign-in work (grant install, start-trigger sync) is over: the page has
   * sent the node nothing for a quiet period.
   */
  async function quiesce(page: Page): Promise<void> {
    for (let stable = 0; stable < 5;) {
      const before = nodeRequests(page);
      await page.waitForTimeout(300);
      stable = nodeRequests(page) === before ? stable + 1 : 0;
    }
  }

  /** Opens the fixture in a new page of `context` and boots `TinyCloudWeb`. */
  async function bootPage(
    context: BrowserContext,
    options: {
      prefix?: string;
      replication?: "on" | "unset" | "disabled" | "registered-disabled";
      walletKey?: string;
      allowSecrets?: boolean;
      grantTtlMs?: number;
      maxStalenessMs?: number;
    } = {},
  ): Promise<Page> {
    const page = await context.newPage();
    const counter = { count: 0 };
    nodeRequestCounts.set(page, counter);
    page.on("request", (request) => {
      if (request.url().startsWith(host) && request.method() !== "OPTIONS") counter.count += 1;
    });
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => window.__tcw !== undefined);
    await page.evaluate((input) => window.__tcw.boot(input), {
      host,
      walletKey: WALLET_KEY,
      prefix: "notes/",
      replication: "on" as const,
      ...options,
    });
    return page;
  }

  // -- Scenarios: each number is the plan §10 item. --------------------------

  scenario("1 sign-in: grant lifetime bounded by grantTtlMs; silent renewal makes no wallet request", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context, { grantTtlMs: 4_000 });
      await page.evaluate(() => window.__tcw.signIn());
      const walletBefore = await page.evaluate(() => window.__tcw.walletRequests());
      await page.evaluate(() => window.__tcw.replicationSync());
      // A 4 s grant renews itself well inside the test: wait for the renewal rather than a fixed sleep.
      await page.waitForFunction(() => window.__tcw.replicationEvents().some((event) => {
        const entry = event as { type?: string; action?: string };
        return entry.type === "replication.grant" && entry.action === "renewed";
      }), undefined, { timeout: 20_000 });
      const { grant } = await statusOf(page);
      expect(grant).not.toBeNull();
      expect(typeof grant?.effectiveExpiresAt).toBe("number");
      expect((grant?.effectiveExpiresAt ?? Infinity) - Date.now()).toBeLessThanOrEqual(4_000);
      const minted = (await replicationEventsOf(page, "replication.grant")).filter((event) => event.action === "minted");
      expect(minted.length).toBeGreaterThan(0);
      for (const event of minted) expect(event.expiryMs).toBeLessThanOrEqual(4_000);
      const renewed = (await replicationEventsOf(page, "replication.grant")).filter((event) => event.action === "renewed");
      expect(renewed.length).toBeGreaterThan(0);
      for (const event of renewed) expect(event.expiryMs).toBeLessThanOrEqual(4_000);
      // Renewal (a real `renewed` event above) comes from the stored session: zero wallet signatures.
      expect(await page.evaluate(() => window.__tcw.walletRequests())).toBe(walletBefore);
    } finally {
      await closeContext(context);
    }
  });

  scenario("2 read through replica returns source 'replica' after sync", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      const requestsBefore = nodeRequests(page);
      const read = await page.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(read).toMatchObject({ status: "present", value: "alpha note" });
      expect(await lastRead(page)).toMatchObject({ source: "replica", outcome: "found", syncedBeforeRead: false });
      // Independent of the SDK's own event: the page sent the node no request for this read.
      expect(nodeRequests(page)).toBe(requestsBefore);
    } finally {
      await closeContext(context);
    }
  });

  scenario("3 network bypass: { source: 'network' } reads the node even when the replica holds the key", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      const read = await page.evaluate(() => window.__tcw.kvGet("notes/a", { source: "network" }));
      expect(read).toMatchObject({ status: "present", value: "alpha note" });
      expect(await lastRead(page)).toMatchObject({ source: "network" });
    } finally {
      await closeContext(context);
    }
  });

  scenario("4 offline with maxStalenessMs 0: read surfaces NETWORK_ERROR; key outside the prefix serves nothing", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context, { maxStalenessMs: 0 });
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      offline.add(context);
      // maxStalenessMs 0 makes every read stale, so it tries to sync first; offline that fails with
      // NETWORK_ERROR and the read falls back to the replica, reporting the sync error.
      const covered = await page.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(covered).toMatchObject({ status: "present", value: "alpha note" });
      expect(await lastRead(page)).toMatchObject({
        source: "replica", outcome: "found", syncError: "NETWORK_ERROR", syncedBeforeRead: false,
      });
      // A key outside the prefix is never served by the replica: offline it simply fails.
      const uncovered = await page.evaluate(() => window.__tcw.kvGet("notes-secret/x"));
      expect(uncovered).not.toHaveProperty("value");
      expect(await lastRead(page)).toMatchObject({ source: "network", reason: "not_covered", outcome: "error" });
    } finally {
      offline.delete(context);
      await closeContext(context);
    }
  });

  scenario("5 offline reload restores the persisted session from the durable pending store", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      offline.add(context);
      await page.reload();
      await page.waitForFunction(() => window.__tcw !== undefined);
      await page.evaluate((input) => window.__tcw.boot(input), { host, walletKey: WALLET_KEY, prefix: "notes/", replication: "on" as const });
      expect(await page.evaluate(() => window.__tcw.restoreSession())).toEqual({ status: "restored" });
      const read = await page.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(read).toMatchObject({ status: "present", value: "alpha note" });
      expect(await lastRead(page)).toMatchObject({ source: "replica" });
    } finally {
      offline.delete(context);
      await closeContext(context);
    }
  });

  scenario("6 sign-out in one of two tabs: keys shredded, the other tab is gated and cannot refill, recovery erases the rows", async () => {
    const context = await newContext();
    try {
      const first = await bootPage(context);
      await first.evaluate(() => window.__tcw.signIn());
      await first.evaluate(() => window.__tcw.replicationSync());
      expect(await contentRows(first)).toBeGreaterThan(0);
      expect(await first.evaluate(() => window.__tcw.keyPresence())).toEqual({ gateHmac: true, accountKey: true });
      // Rows are sealed at rest: the plaintext is never in origin storage, before or after.
      expect(await originStoresContain(first, "alpha note")).toBe(false);
      const second = await bootPage(context);
      await second.evaluate(() => window.__tcw.signIn());
      await first.evaluate(() => window.__tcw.signOut());
      expect(await replicationEventsOf(first, "replication.lifecycle")).toContainEqual(
        expect.objectContaining({ action: "denied", reason: "sign_out" }),
      );
      // The deny transaction deleted the account keys: whatever rows remain are undecryptable.
      expect(await second.evaluate(() => window.__tcw.keyPresence())).toEqual({ gateHmac: false, accountKey: false });
      await second.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(second)).toMatchObject({ source: "network", reason: "replica_gated" });
      const before = await contentRows(second);
      await kvPut("notes/after-signout", "written after sign-out");
      await second.evaluate(() => window.__tcw.replicationSync());
      expect(await contentRows(second)).toBeLessThanOrEqual(before);
      await second.evaluate(() => window.__tcw.kvGet("notes/after-signout"));
      expect(await lastRead(second)).toMatchObject({ source: "network", reason: "replica_gated" });
      // The next startup's recovery completes the erase.
      await first.reload();
      await first.waitForFunction(() => window.__tcw !== undefined);
      await first.evaluate((input) => window.__tcw.boot(input), { host, walletKey: WALLET_KEY, prefix: "notes/", replication: "on" as const });
      await first.waitForFunction(async () => (await window.__tcw.pendingPurgeCount()) === 0);
      expect(await contentRows(first)).toBe(0);
    } finally {
      await closeContext(context);
    }
  });

  scenario("7 sign-out erase failure: purge_pending keeps the unreadable partition; reload retries and completes the wipe", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      await page.evaluate(() => window.__tcw.injectEraseFailure());
      await page.evaluate(() => window.__tcw.injectDenyFailure({ stage: "delete_database", once: false }));
      await page.evaluate(() => window.__tcw.signOut());
      // The erase failed, so the partition is condemned but not yet erased: a purge intent remains.
      expect(await page.evaluate(() => window.__tcw.pendingPurgeCount())).toBeGreaterThan(0);
      await page.reload();
      await page.waitForFunction(() => window.__tcw !== undefined);
      // A fresh page load runs lifecycle recovery with the production eraser.
      await page.evaluate((input) => window.__tcw.boot(input), { host, walletKey: WALLET_KEY, prefix: "notes/", replication: "on" as const });
      await page.waitForFunction(async () => (await window.__tcw.pendingPurgeCount()) === 0);
      expect(await contentRows(page)).toBe(0);
    } finally {
      await closeContext(context);
    }
  });

  scenario("8a sign-out deny with a failed deny transaction: the fallback database delete runs and a sibling tab cannot read", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      expect(await contentRows(page)).toBeGreaterThan(0);
      const sibling = await bootPage(context);
      await sibling.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.injectDenyFailure({ stage: "deny_tx", once: true }));
      await page.evaluate(() => window.__tcw.signOut());
      // The fallback `deleteDatabase` races the sibling tab's open connections. It either completes
      // (`database_deleted`) or is blocked by a sibling that has not yet released its connection, in
      // which case the safe path is the marker (`marker_set`, `DELETE_BLOCKED`), the 8c outcome.
      // Which one happens is timing in the product; either way the fallback ran and nothing is served.
      const lifecycle = await replicationEventsOf(page, "replication.lifecycle");
      const deleted = lifecycle.some((event) => event.action === "database_deleted" && event.reason === "sign_out");
      const blocked = lifecycle.some((event) => event.action === "marker_set" && event.code === "DELETE_BLOCKED");
      expect(deleted || blocked, JSON.stringify(lifecycle)).toBe(true);
      if (deleted) {
        // The whole replica database is gone, so no sealed row survives for any key.
        expect(await page.evaluate(() => indexedDB.databases().then((all) => all.map((db) => db.name)))).not.toContain("tinycloud-replica-kv");
        expect(await contentRows(page)).toBe(0);
      }
      expect(await page.evaluate(() => window.__tcw.replicationEvents())).not.toContainEqual(expect.objectContaining({ action: "deny_failed" }));
      await sibling.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(sibling)).toMatchObject({ source: "network", reason: "replica_gated" });
    } finally {
      await closeContext(context);
    }
  });

  scenario("8b deny then fresh sign-in recreates the DB; a tab from before the deny is refused; Details: TC-1621", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      const stale = await bootPage(context);
      await stale.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.injectDenyFailure({ stage: "deny_tx", once: true }));
      await page.evaluate(() => window.__tcw.signOut());
      expect(await contentRows(page)).toBe(0);
      await stale.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(stale)).toMatchObject({ source: "network", reason: "replica_gated" });
      await page.evaluate(() => window.__tcw.signIn());
      let sync = (await page.evaluate(() => window.__tcw.replicationSync())) as SyncResult;
      if (sync.status === "error" && "gate" in sync && sync.gate === "logout_pending") {
        // The fixture records the delete-blocked marker for this outcome. Startup recovery clears
        // that marker; signing out of the restored session and signing in again establishes a fresh stamp.
        // This path requires a successful sync, and any other gate reason fails the scenario. Details: TC-1621
        expect(await replicationEventsOf(page, "replication.lifecycle")).toContainEqual(
          expect.objectContaining({ action: "marker_set", code: "DELETE_BLOCKED" }),
        );
        await page.reload();
        await page.waitForFunction(() => window.__tcw !== undefined);
        await page.evaluate((input) => window.__tcw.boot(input), { host, walletKey: WALLET_KEY, prefix: "notes/", replication: "on" as const });
        await page.evaluate(() => window.__tcw.signOut());
        await page.evaluate(() => window.__tcw.signIn());
        sync = (await page.evaluate(() => window.__tcw.replicationSync())) as SyncResult;
      }
      expect(sync).toEqual({ status: "ok" });
      expect(await contentRows(page)).toBeGreaterThan(0);
      // The tab signed in before the deny still holds the pre-deny stamp. The gate refuses it.
      await stale.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(stale)).toMatchObject({ source: "network", reason: "replica_gated" });
      await page.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(page)).toMatchObject({ source: "replica", outcome: "found" });
    } finally {
      await closeContext(context);
    }
  });

  scenario("8c deny with the delete blocked and a marker: sibling refuses the next read without reload; reload refuses to activate", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      const sibling = await bootPage(context);
      await sibling.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.injectDenyFailure({ stage: "deny_tx", once: true }));
      await page.evaluate(() => window.__tcw.injectDenyFailure({ stage: "delete_database", once: false }));
      await page.evaluate(() => window.__tcw.signOut());
      expect(await replicationEventsOf(page, "replication.lifecycle")).toContainEqual(expect.objectContaining({ action: "marker_set" }));
      await sibling.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(sibling)).toMatchObject({ source: "network", reason: "replica_gated" });
      // Neither the deny transaction nor the delete ran, so the rows and keys survive. The marker alone
      // is what refuses them: the read above was gated without a reload.
      expect(await contentRows(sibling)).toBeGreaterThan(0);
      // The next startup's recovery removes the database the marker stood in for.
      await sibling.reload();
      await sibling.waitForFunction(() => window.__tcw !== undefined);
      await sibling.evaluate((input) => window.__tcw.boot(input), { host, walletKey: WALLET_KEY, prefix: "notes/", replication: "on" as const });
      await sibling.waitForFunction(async () => {
        const rows = await window.__tcw.replicaRows();
        return (rows.entries ?? 0) + (rows.blobs ?? 0) === 0;
      });
      expect(await contentRows(sibling)).toBe(0);
    } finally {
      await closeContext(context);
    }
  });

  scenario("8d a stale tab cannot refill pending writes after deny, erase or same-principal re-sign-in", async () => {
    const context = await newContext();
    try {
      const pendingRows = async (page: Page) => (await page.evaluate(() => window.__tcw.replicaRows())).pending ?? 0;
      const current = await bootPage(context);
      await current.evaluate(() => window.__tcw.signIn());
      await current.evaluate(() => window.__tcw.replicationSync());
      const stale = await bootPage(context);
      await stale.evaluate(() => window.__tcw.signIn());
      expect(await contentRows(current)).toBeGreaterThan(0);
      expect(await stale.evaluate(() => window.__tcw.stalePendingUpdate("notes/stale-before-deny"))).toEqual({ status: "updated" });
      expect(await pendingRows(stale)).toBeGreaterThan(0);

      await current.evaluate(() => window.__tcw.signOut());
      const afterDeny = await pendingRows(current);
      expect(await stale.evaluate(() => window.__tcw.stalePendingUpdate("notes/stale-after-deny"))).toMatchObject({
        status: "error", code: "REPLICA_GATED", gate: "not_established",
      });
      // No principal holds the gate after the deny, so the stale stamp is refused as not established.
      expect(await pendingRows(current)).toBe(afterDeny);

      // Startup recovery erases the denied partition's pending rows.
      await current.reload();
      await current.waitForFunction(() => window.__tcw !== undefined);
      await current.evaluate((input) => window.__tcw.boot(input), { host, walletKey: WALLET_KEY, prefix: "notes/", replication: "on" as const });
      await current.waitForFunction(async () => (await window.__tcw.pendingPurgeCount()) === 0);
      expect(await pendingRows(current)).toBe(0);
      expect(await stale.evaluate(() => window.__tcw.stalePendingUpdate("notes/stale-after-erase"))).toMatchObject({
        status: "error", code: "REPLICA_GATED", gate: "not_established",
      });
      expect(await pendingRows(current)).toBe(0);

      // A same-principal re-sign-in establishes a new incarnation; the old stamp is now stale, not merely unestablished.
      await current.evaluate(() => window.__tcw.signIn());
      await current.evaluate(() => window.__tcw.replicationSync());
      expect(await contentRows(current)).toBeGreaterThan(0);
      expect(await stale.evaluate(() => window.__tcw.stalePendingUpdate("notes/stale-after-resignin"))).toMatchObject({
        status: "error", code: "REPLICA_GATED", gate: "stamp_stale",
      });
      expect(await pendingRows(current)).toBe(0);
    } finally {
      await closeContext(context);
    }
  });

  scenario("9 revocation of an active device grant: next stale read learns GRANT_REVOKED; content erased; owner network reads still work", async () => {
    const context = await newContext();
    try {
      // maxStalenessMs 0: the next read syncs first, which is where a revocation is learned.
      const page = await bootPage(context, { maxStalenessMs: 0 });
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      await revokeGrantOf(page);
      await page.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(page)).toMatchObject({ source: "network", reason: "grant_revoked", code: "GRANT_REVOKED", outcome: "found" });
      expect(await contentRows(page)).toBe(0);
      const network = await page.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(network).toMatchObject({ status: "present", value: "alpha note" });
    } finally {
      await closeContext(context);
    }
  });

  scenario("10 account switch: B is refused while A holds the origin; after A signs out B opens a fresh partition with none of A's data; A's other tab stays refused", async () => {
    const context = await newContext();
    try {
      const accountA = await bootPage(context);
      await accountA.evaluate(() => window.__tcw.signIn());
      await accountA.evaluate(() => window.__tcw.replicationSync());
      const staleA = await bootPage(context);
      await staleA.evaluate(() => window.__tcw.signIn());
      expect(await contentRows(accountA)).toBeGreaterThan(0);

      // A second wallet is a second principal. While A holds the origin's gate B is refused, and its reads go to the network.
      const accountB = await bootPage(context, { walletKey: ACCOUNT_B_KEY });
      await accountB.evaluate(() => window.__tcw.signIn());
      await accountB.evaluate(() => window.__tcw.kvGet("notes/b-only"));
      expect(await lastRead(accountB)).toMatchObject({ source: "network", reason: "replica_gated" });

      await accountA.evaluate(() => window.__tcw.signOut());
      // B ends its refused session so its next sign-in is fresh rather than a restore under a pre-switch stamp.
      await accountB.evaluate(() => window.__tcw.signOut());
      // B's next load runs startup recovery, which erases A's condemned partition before B can open.
      await accountB.reload();
      await accountB.waitForFunction(() => window.__tcw !== undefined);
      await accountB.evaluate((input) => window.__tcw.boot(input), { host, walletKey: ACCOUNT_B_KEY, prefix: "notes/", replication: "on" as const });
      await accountB.evaluate(() => window.__tcw.signIn());
      expect(await accountB.evaluate(() => window.__tcw.replicationSync())).toEqual({ status: "ok" });
      // A's partition was erased before B's opened: only B's one key (an entry and a blob) is present.
      expect(await contentRows(accountB)).toBe(2);
      const own = await accountB.evaluate(() => window.__tcw.kvGet("notes/b-only"));
      expect(own).toMatchObject({ status: "present", value: "belongs to B" });
      expect(await lastRead(accountB)).toMatchObject({ source: "replica", outcome: "found" });
      const foreign = await accountB.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(foreign).not.toHaveProperty("value");

      // A's other tab holds a pre-switch stamp: refused.
      await staleA.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(staleA)).toMatchObject({ source: "network", reason: "replica_gated" });
    } finally {
      await closeContext(context);
    }
  });

  scenario("11 sealed at rest: a synced prefix leaves no plaintext in origin storage; a vault prefix is refused outright", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      // Precondition: the replica holds both notes, so the negative scans below are not vacuous.
      expect(await contentRows(page)).toBeGreaterThanOrEqual(4);
      expect(await page.evaluate(() => window.__tcw.kvGet("notes/a"))).toMatchObject({ status: "present", value: "alpha note" });
      for (const plaintext of ["alpha note", "beta note", "OUT-OF-SCOPE-SECRET", "notes/a", "notes/b"]) {
        expect(await originStoresContain(page, plaintext), plaintext).toBe(false);
      }
    } finally {
      await closeContext(context);
    }
    // The browser never holds secrets or vault content, even when the app opts in.
    const vaultContext = await newContext();
    try {
      await kvPut("vault/token", "PLAINTEXT-SECRET-VALUE");
      const page = await bootPage(vaultContext, { prefix: "vault/", allowSecrets: true });
      await page.evaluate(() => window.__tcw.signIn());
      const sync = (await page.evaluate(() => window.__tcw.replicationSync())) as SyncResult;
      expect(sync).toMatchObject({ status: "error", code: "REPLICA_INVALID_ARGUMENT" });
      expect(await contentRows(page)).toBe(0);
      expect(await originStoresContain(page, "PLAINTEXT-SECRET-VALUE")).toBe(false);
    } finally {
      await closeContext(vaultContext);
    }
  });

  scenario("12 two tabs, one context: a commit synced by one tab reaches the other, which serves it from its replica without a node request", async () => {
    const context = await newContext();
    try {
      const writer = await bootPage(context);
      await writer.evaluate(() => window.__tcw.signIn());
      await writer.evaluate(() => window.__tcw.replicationSync());
      const reader = await bootPage(context);
      await reader.evaluate(() => window.__tcw.signIn());
      // Both tabs hold the same identity and partition. Only the writer ever syncs from here on,
      // so first let each tab bind its replica (the first kv call opens it and installs its grant)
      // and finish its own start work.
      for (const tab of [writer, reader]) {
        await tab.evaluate(() => window.__tcw.kvGet("notes/a"));
        await quiesce(tab);
      }
      const peerSyncs = async () =>
        (await replicationEventsOf(reader, "replication.sync")).filter((event) => event.trigger === "peer").length;
      const peerBefore = await peerSyncs();

      await kvPut("notes/peer", "committed by a peer tab");
      // Negative control: the commit is on the node but no tab has synced it. The reader's replica
      // does not have it and the reader must not reach the node to find out.
      const requestsBeforeControl = nodeRequests(reader);
      const control = await reader.evaluate(() => window.__tcw.kvGet("notes/peer"));
      expect(control).not.toHaveProperty("value");
      expect(await lastRead(reader)).toMatchObject({ source: "replica", outcome: "not_found", syncedBeforeRead: false });
      expect(nodeRequests(reader)).toBe(requestsBeforeControl);

      await writer.evaluate(() => window.__tcw.replicationSync());
      // The writer's commit is announced to the reader as a peer commit; no work runs in the reader.
      await reader.waitForFunction(() => window.__tcw.replicationEvents().some((event) => {
        const entry = event as { type?: string; trigger?: string; origin?: string };
        return entry.type === "replication.sync" && entry.trigger === "peer" && entry.origin === "peer";
      }), undefined, { timeout: 15_000 });
      expect(await peerSyncs()).toBeGreaterThan(peerBefore);

      const requestsBefore = nodeRequests(reader);
      const read = await reader.evaluate(() => window.__tcw.kvGet("notes/peer"));
      expect(read).toMatchObject({ status: "present", value: "committed by a peer tab" });
      expect(await lastRead(reader)).toMatchObject({ source: "replica", outcome: "found", syncedBeforeRead: false });
      // The reader sent the node nothing (no kv-sync, no kv get) to serve the peer's commit.
      expect(nodeRequests(reader)).toBe(requestsBefore);
    } finally {
      await closeContext(context);
    }
  });

  scenario("14 flag off is byte-identical to a build without replica code: same requests, no replica chunk or worker", async () => {
    type Seen = { method: string; url: string; headers: string };
    // Ignored headers, and why: `authorization` is a per-request signed invocation; `tinycloud-*` and
    // `x-tinycloud-*` carry per-request trace/session ids; `*nonce*`/`*trace*` are random per request;
    // `date` and `content-length` follow the signed body. Every other header (accept, content-type,
    // origin, referer, user-agent, sec-ch-ua*, ...) must be identical. The request bodies are signed
    // per call and are not compared; the method/URL sequence and header set are.
    const volatile = /^(authorization|tinycloud-.*|x-tinycloud-.*|.*nonce.*|.*trace.*|date|content-length)$/i;
    async function observe(variant: "baseline" | "unset" | "disabled" | "registered-disabled"): Promise<{ signIn: string[]; kv: Seen[]; assets: string[]; workers: number }> {
      const context = await newContext();
      try {
        const page = await context.newPage();
        const assets: string[] = [];
        let workers = 0;
        page.on("worker", () => (workers += 1));
        page.on("request", (request) => {
          if (request.url().startsWith(origin)) assets.push(new URL(request.url()).pathname);
        });
        await page.goto(`${origin}/${variant === "baseline" ? "baseline.html" : "index.html"}`);
        if (variant === "baseline") {
          await page.waitForFunction(() => window.__baseline !== undefined);
          await page.evaluate((input) => window.__baseline.boot(input), { host, walletKey: WALLET_KEY });
        } else {
          await page.waitForFunction(() => window.__tcw !== undefined);
          await page.evaluate((input) => window.__tcw.boot(input), { host, walletKey: WALLET_KEY, prefix: "notes/", replication: variant });
        }
        const captured: Array<Promise<Seen>> = [];
        let phase: "signIn" | "kv" = "signIn";
        const signIn: string[] = [];
        page.on("request", (request) => {
          if (!request.url().startsWith(host) || request.method() === "OPTIONS") return;
          if (phase === "signIn") {
            signIn.push(`${request.method()} ${new URL(request.url()).pathname}`);
            return;
          }
          // `headers()` is a partial, timing-dependent view; `allHeaders()` is the wire set.
          captured.push(
            request.allHeaders().then((all) => ({
              method: request.method(),
              url: request.url(),
              headers: Object.entries(all)
                .filter(([name]) => !volatile.test(name))
                .map(([name, value]) => `${name}: ${value}`)
                .sort()
                .join("\n"),
            })),
          );
        });
        const apiName = variant === "baseline" ? "__baseline" : "__tcw";
        const run = (method: "signIn" | "kvGet" | "kvList", arg?: string) =>
          page.evaluate(
            ([name, call, argument]) =>
              (window as unknown as Record<string, Record<string, (value?: string) => Promise<unknown>>>)[name]![call]!(argument),
            [apiName, method, arg] as const,
          );
        await run("signIn");
        // Trailing sign-in requests can land after `signIn` resolves; let them finish so the sign-in
        // and kv phases are split the same way in every variant.
        for (let quiet = 0, last = -1; quiet < 4; ) {
          const seen = signIn.length;
          await page.waitForTimeout(300);
          quiet = seen === signIn.length && seen === last ? quiet + 1 : 0;
          last = signIn.length;
        }
        phase = "kv";
        await run("kvGet", "notes/a");
        await run("kvGet", "notes/does-not-exist");
        await run("kvList", "notes/");
        await run("kvGet", "notes/b");
        await page.waitForTimeout(500);
        return { signIn: signIn.sort(), kv: await Promise.all(captured), assets, workers };
      } finally {
        await closeContext(context);
      }
    }
    await observe("baseline"); // warm-up: the first sign-in of a wallet creates its space
    const baseline = await observe("baseline");
    expect(baseline.kv.length).toBeGreaterThan(0);
    for (const variant of ["unset", "disabled", "registered-disabled"] as const) {
      const flagOff = await observe(variant);
      expect(flagOff.kv).toEqual(baseline.kv);
      expect(flagOff.signIn).toEqual(baseline.signIn);
      expect(flagOff.workers).toBe(0);
      // With the plugin registered its chunk is present, so only the storage and worker are excluded:
      // flag off must never open the replica database or start a worker.
      const forbidden = variant === "registered-disabled" ? /kv-storage|\.worker|sqlite/i : /replica|kv-storage|\.worker|sqlite/i;
      expect(flagOff.assets.filter((path) => forbidden.test(path))).toEqual([]);
    }
  });

  scenario("13 worker death: terminating the worker restarts cleanly; the next read is not served stale", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      await page.evaluate(() => window.__tcw.killReplicaWorker());
      await page.evaluate(() => window.__tcw.replicationSync());
      const read = await page.evaluate(() => window.__tcw.kvGet("notes/b"));
      expect(read).toMatchObject({ status: "present", value: "beta note" });
      expect(await lastRead(page)).toMatchObject({ source: "replica" });
    } finally {
      await closeContext(context);
    }
  });

  // WebKit is out of scope: the harness is Chromium-only and records no placeholder for it.
});
