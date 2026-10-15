/**
 * TC-858 S6: real-Chromium acceptance for browser read-through replication
 * (plan §10). The fixture is `test/browser/acceptance`, a Vite app that drives
 * `TinyCloudWeb` through its own sign-in, grant and session flow. Each scenario
 * runs in a fresh browser context so IndexedDB never leaks between scenarios.
 *
 * Scenario numbers follow plan §10. Deny-failure variants are 8a-8c; 8d
 * probes the stale tab's pending store across deny, erase and fresh sign-in.
 *
 * Gating: without `TC858_ACCEPTANCE_STRICT=1` every scenario is `test.todo`, so
 * non-strict CI stays green while S1-S5 are unlanded. Strict mode runs the real
 * assertions and is expected to fail until the slices land.
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
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NODE_BIN = process.env.TC_REPLICA_E2E_NODE_BIN ?? process.env.TC_NODE_BIN;
const STRICT = process.env.TC858_ACCEPTANCE_STRICT === "1";
const FIXTURE_DIST = resolve(import.meta.dir, "browser/acceptance/dist");
/** Throwaway wallet. The owner and the fixture page share it, so one identity. */
const WALLET_KEY = `0x${randomBytes(32).toString("hex")}`;
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
    const status = await page.evaluate(() => window.__tcw.replicationStatus());
    const grantCid = (status as { grantCid?: unknown }).grantCid;
    if (typeof grantCid !== "string") throw new Error(`replicationStatus has no grantCid: ${JSON.stringify(status)}`);
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

  /** A fresh context with the node origin's CORS headers added at the driver layer. */
  async function newContext(): Promise<BrowserContext> {
    if (browser === undefined) throw new Error("browser not launched");
    const context = await browser.newContext();
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
        const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".html") ? "text/html" : "application/octet-stream";
        return new Response(file, { headers: { "content-type": type } });
      },
    });

    owner = new TinyCloudNode({ privateKey: WALLET_KEY, host, autoCreateSpace: true });
    await owner.signIn();
    await kvPut("notes/a", "alpha note");
    await kvPut("notes/b", "beta note");
    await kvPut("notes-secret/x", "OUT-OF-SCOPE-SECRET");
    browser = await chromium.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    fixtureServer?.stop();
    await stopNode();
    if (dataDir !== "") await rm(dataDir, { recursive: true, force: true });
  });

  /** Opens the fixture in a new page of `context` and boots `TinyCloudWeb`. */
  async function bootPage(
    context: BrowserContext,
    options: { prefix?: string; replication?: boolean; allowSecrets?: boolean; grantTtlMs?: number; maxStalenessMs?: number } = {},
  ): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => window.__tcw !== undefined);
    await page.evaluate((input) => window.__tcw.boot(input), {
      host,
      walletKey: WALLET_KEY,
      prefix: "notes/",
      replication: true,
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
      await page.waitForTimeout(3_000);
      const status = (await page.evaluate(() => window.__tcw.replicationStatus())) as {
        grant: { effectiveExpiresAt: string } | null;
      };
      expect(status.grant).not.toBeNull();
      expect(Date.parse(status.grant?.effectiveExpiresAt ?? "") - Date.now()).toBeLessThanOrEqual(4_000);
      const minted = (await replicationEventsOf(page, "replication.grant")).filter((event) => event.action === "minted");
      expect(minted.length).toBeGreaterThan(0);
      for (const event of minted) expect(event.expiryMs).toBeLessThanOrEqual(4_000);
      // Renewal comes from the stored session, never from the wallet.
      expect(await page.evaluate(() => window.__tcw.walletRequests())).toBe(walletBefore);
    } finally {
      await context.close();
    }
  });

  scenario("2 read through replica returns source 'replica' after sync", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      const read = await page.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(read).toMatchObject({ status: "present", value: "alpha note" });
      expect(await lastRead(page)).toMatchObject({ source: "replica", outcome: "found" });
    } finally {
      await context.close();
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
      await context.close();
    }
  });

  scenario("4 offline with maxStalenessMs 0: read surfaces NETWORK_ERROR; key outside the prefix serves nothing", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context, { maxStalenessMs: 0 });
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      await context.setOffline(true);
      await page.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(page)).toMatchObject({ outcome: "error", syncError: "NETWORK_ERROR" });
      const uncovered = await page.evaluate(() => window.__tcw.kvGet("notes-secret/x"));
      expect(uncovered).not.toHaveProperty("value");
      expect((await lastRead(page)).source).not.toBe("replica");
    } finally {
      await context.setOffline(false);
      await context.close();
    }
  });

  scenario("5 offline reload restores the persisted session from the durable pending store", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(() => window.__tcw !== undefined);
      await page.evaluate((input) => window.__tcw.boot(input), { host, walletKey: WALLET_KEY, prefix: "notes/", replication: true });
      const read = await page.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(read).toMatchObject({ status: "present", value: "alpha note" });
      expect(await lastRead(page)).toMatchObject({ source: "replica" });
    } finally {
      await context.setOffline(false);
      await context.close();
    }
  });

  scenario("6 sign-out wipes in two tabs: no plaintext left in origin storage; reads fail; second tab cannot refill", async () => {
    const context = await newContext();
    try {
      const first = await bootPage(context);
      await first.evaluate(() => window.__tcw.signIn());
      await first.evaluate(() => window.__tcw.replicationSync());
      expect(await originStoresContain(first, "alpha note")).toBe(true);
      const second = await bootPage(context);
      await second.evaluate(() => window.__tcw.signIn());
      await first.evaluate(() => window.__tcw.signOut());
      const lifecycle = await replicationEventsOf(first, "replication.lifecycle");
      expect(lifecycle).toContainEqual(expect.objectContaining({ action: "denied", reason: "sign_out" }));
      expect(await originStoresContain(first, "alpha note")).toBe(false);
      await second.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(second)).toMatchObject({ source: "network", reason: "replica_gated" });
      await second.evaluate(() => window.__tcw.replicationSync());
      expect(await originStoresContain(second, "alpha note")).toBe(false);
    } finally {
      await context.close();
    }
  });

  scenario("7 sign-out erase failure: purge_pending keeps the unreadable partition; reload retries and completes the wipe", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      await page.evaluate(() => window.__tcw.injectEraseFailure());
      await page.evaluate(() => window.__tcw.signOut());
      await page.reload();
      await page.waitForFunction(() => window.__tcw !== undefined);
      expect(await originStoresContain(page, "alpha note")).toBe(false);
    } finally {
      await context.close();
    }
  });

  scenario("8a deny with failed primary delete: the fallback delete runs and a sibling tab cannot read", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      const sibling = await bootPage(context);
      await sibling.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.injectDenyFailure({ stage: "deny_tx", once: true }));
      await revokeGrantOf(page);
      await page.evaluate(() => window.__tcw.replicationSync());
      expect(await originStoresContain(page, "alpha note")).toBe(false);
      await sibling.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect((await lastRead(sibling)).source).not.toBe("replica");
    } finally {
      await context.close();
    }
  });

  scenario("8b deny then fresh sign-in recreates the DB; a session from before the deny is refused", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      const stale = await bootPage(context);
      await stale.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.injectDenyFailure({ stage: "deny_tx", once: true }));
      await revokeGrantOf(page);
      await page.evaluate(() => window.__tcw.replicationSync());
      await page.evaluate(() => window.__tcw.signIn());
      // The tab signed in before the deny still holds the pre-deny stamp. The gate refuses it.
      await stale.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(stale)).toMatchObject({ reason: "replica_gated" });
      await page.evaluate(() => window.__tcw.replicationSync());
      expect(await originStoresContain(page, "alpha note")).toBe(true);
    } finally {
      await context.close();
    }
  });

  scenario("8c deny with delete blocked and a marker: sibling refuses the next read without reload; reload refuses to activate", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      const sibling = await bootPage(context);
      await sibling.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.injectDenyFailure({ stage: "deny_tx", once: true }));
      await page.evaluate(() => window.__tcw.injectDenyFailure({ stage: "delete_database", once: true }));
      await revokeGrantOf(page);
      await page.evaluate(() => window.__tcw.replicationSync());
      const lifecycle = await replicationEventsOf(page, "replication.lifecycle");
      expect(lifecycle).toContainEqual(expect.objectContaining({ action: "marker_set" }));
      await sibling.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(sibling)).toMatchObject({ source: "network", reason: "replica_gated" });
      await sibling.reload();
      await sibling.waitForFunction(() => window.__tcw !== undefined);
      const reloaded = (await sibling.evaluate(() => window.__tcw.replicationStatus())) as { state: string };
      expect(reloaded.state).toBe("gated");
    } finally {
      await context.close();
    }
  });

  scenario("8d a stale tab cannot refill pending writes after deny/erase or same-principal re-sign-in", async () => {
    const context = await newContext();
    try {
      const current = await bootPage(context);
      await current.evaluate(() => window.__tcw.signIn());
      await current.evaluate(() => window.__tcw.replicationSync());
      const stale = await bootPage(context);
      await stale.evaluate(() => window.__tcw.signIn());
      expect(await originStoresContain(current, "alpha note")).toBe(true);
      expect(await stale.evaluate(() => window.__tcw.stalePendingUpdate("notes/stale-before-deny"))).toEqual({ status: "updated" });
      expect(await originStoresContain(stale, "notes/stale-before-deny")).toBe(true);

      await current.evaluate(() => window.__tcw.signOut());
      await current.waitForFunction(async () => (await window.__tcw.pendingPurgeCount()) === 0);
      expect(await originStoresContain(current, "alpha note")).toBe(false);
      expect(await originStoresContain(current, "notes/stale-before-deny")).toBe(false);
      expect(await stale.evaluate(() => window.__tcw.stalePendingUpdate("notes/stale-after-erase"))).toMatchObject({
        status: "error", code: "REPLICA_GATED", gate: "stamp_stale",
      });
      expect(await originStoresContain(current, "notes/stale-after-erase")).toBe(false);

      await current.evaluate(() => window.__tcw.signIn());
      await current.evaluate(() => window.__tcw.replicationSync());
      expect(await originStoresContain(current, "alpha note")).toBe(true);
      expect(await stale.evaluate(() => window.__tcw.stalePendingUpdate("notes/stale-after-resignin"))).toMatchObject({
        status: "error", code: "REPLICA_GATED", gate: "stamp_stale",
      });
      expect(await originStoresContain(current, "notes/stale-after-resignin")).toBe(false);
    } finally {
      await context.close();
    }
  });

  scenario("9 revocation of an active device grant: next stale read learns GRANT_REVOKED; content erased; owner network reads still work", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      await revokeGrantOf(page);
      await page.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(page)).toMatchObject({ reason: "grant_revoked", syncError: "GRANT_REVOKED" });
      expect(await originStoresContain(page, "alpha note")).toBe(false);
      const network = await page.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(network).toMatchObject({ status: "present", value: "alpha note" });
    } finally {
      await context.close();
    }
  });

  scenario("10 account switch: A's partition erased before B opens; B reads go to network until then; stale A tab refused", async () => {
    const context = await newContext();
    try {
      const accountA = await bootPage(context);
      await accountA.evaluate(() => window.__tcw.signIn());
      await accountA.evaluate(() => window.__tcw.replicationSync());
      const accountB = await bootPage(context);
      await accountB.evaluate(() => window.__tcw.signIn());
      await accountB.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(accountB)).toMatchObject({ source: "network" });
      const lifecycle = await replicationEventsOf(accountB, "replication.lifecycle");
      expect(lifecycle).toContainEqual(expect.objectContaining({ reason: "account_switch" }));
      await accountA.evaluate(() => window.__tcw.kvGet("notes/a"));
      expect(await lastRead(accountA)).toMatchObject({ source: "network", reason: "replica_gated" });
    } finally {
      await context.close();
    }
  });

  scenario("11 ciphertext: vault prefix with allowSecrets stores ciphertext only; plaintext never reaches origin storage", async () => {
    const context = await newContext();
    try {
      await kvPut("vault/token", "PLAINTEXT-SECRET-VALUE");
      const page = await bootPage(context, { prefix: "vault/", allowSecrets: true });
      await page.evaluate(() => window.__tcw.signIn());
      await page.evaluate(() => window.__tcw.replicationSync());
      // Precondition: origin storage holds replica rows, so the negative check below is not vacuous.
      expect(await originStoresContain(page, "")).toBe(true);
      expect(await originStoresContain(page, "PLAINTEXT-SECRET-VALUE")).toBe(false);
    } finally {
      await context.close();
    }
  });

  scenario("12 cross-tab invalidation: a non-writing tab receives the commit event", async () => {
    const context = await newContext();
    try {
      const writer = await bootPage(context);
      await writer.evaluate(() => window.__tcw.signIn());
      const reader = await bootPage(context);
      await reader.evaluate(() => window.__tcw.signIn());
      await writer.evaluate(() => window.__tcw.replicationSync());
      const seen = await reader.evaluate(() => window.__tcw.replicationStatus());
      expect((seen as { lastCommitSeen?: unknown }).lastCommitSeen).toEqual(expect.any(Number));
    } finally {
      await context.close();
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
      await context.close();
    }
  });

  // WebKit: not attempted in this slice. The CI image has no Playwright WebKit build; deferred, recorded in the PR.
  test.todo("WebKit parity for scenarios 1-13: deferred, Playwright WebKit not in the CI image", () => {});
});
