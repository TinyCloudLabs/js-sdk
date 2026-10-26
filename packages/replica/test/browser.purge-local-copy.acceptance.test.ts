/**
 * TC-1888: real-Chromium acceptance for erasing the browser replica at sign-out and account switch,
 * `replication.purgeLocalCopy()`, and the restore gate's typed reason. The fixture is
 * `test/browser/purge`, a Vite app that drives `TinyCloudWeb` through its own sign-in flow. Each
 * scenario runs in a fresh browser context so IndexedDB and localStorage never leak between scenarios.
 *
 * Gating: `TC1888_ACCEPTANCE_STRICT=1` (set by the CI step) runs every scenario and turns a missing
 * node binary or fixture build into a failure. Without it the scenarios are recorded as `test.todo`.
 * Every browser wait carries a timeout so a regression FAILS instead of hanging.
 *
 * Needs TC_REPLICA_E2E_NODE_BIN (or TC_NODE_BIN) and the fixture built with `bunx vite build` in
 * `test/browser/purge`. Install Chromium with `bunx playwright install chromium`.
 */
import { mkdtempSync } from "node:fs";

// Never touch a real home: every tool home is a temp dir, asserted before any write.
const TEST_HOME = mkdtempSync("/var/tmp/tc1888.");
process.env.HOME = TEST_HOME;
process.env.BUN_INSTALL_CACHE_DIR = TEST_HOME;
if (!process.env.HOME.startsWith("/var/tmp/tc1888.")) throw new Error("test home is not a temp dir");

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const NODE_BIN = process.env.TC_REPLICA_E2E_NODE_BIN ?? process.env.TC_NODE_BIN;
const STRICT = process.env.TC1888_ACCEPTANCE_STRICT === "1";
const FIXTURE_DIST = resolve(import.meta.dir, "browser/purge/dist");
const KV_DATABASE = "tinycloud-replica-kv";
/** Throwaway wallets, never real identities. */
const WALLET_KEY = `0x${randomBytes(32).toString("hex")}`;
const ACCOUNT_B_KEY = `0x${randomBytes(32).toString("hex")}`;
const nodeSecret = randomBytes(48).toString("base64url");
/** Bound for every in-page wait: a regression fails inside this, it never hangs. */
const WAIT_MS = 20_000;

/** Runs the scenario in strict mode; otherwise records it as a todo so CI stays green. */
function scenario(name: string, body: () => Promise<void>): void {
  if (STRICT) test(name, body, 120_000);
  else test.todo(name, () => {});
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
  test("strict mode has its prerequisites: a node binary and the built purge fixture page", () => {
    expect(NODE_BIN, "TC_REPLICA_E2E_NODE_BIN must point at the pinned tinycloud node binary").toBeDefined();
    expect(existsSync(join(FIXTURE_DIST, "index.html")), "run `bunx vite build` in test/browser/purge first").toBe(true);
  });
}

describe.skipIf(NODE_BIN === undefined)("TC-1888 local-copy purge (Chromium)", () => {
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
        HOME: TEST_HOME,
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

  async function closeContext(context: BrowserContext): Promise<void> {
    await context.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  }

  /** A fresh context with the node origin's CORS headers added at the driver layer. */
  async function newContext(): Promise<BrowserContext> {
    if (browser === undefined) throw new Error("browser not launched");
    const context = await browser.newContext();
    context.setDefaultTimeout(WAIT_MS);
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
    dataDir = await mkdtemp(join("/var/tmp", "tc1888-node-"));
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
    for (const [key, value] of [["notes/a", "alpha note"], ["notes/b", "beta note"]] as const) {
      const put = await owner.kv.put(key, new TextEncoder().encode(value));
      if (!put.ok) throw new Error(`kv put ${key} failed: ${JSON.stringify(put.error)}`);
    }
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

  type Mode = "provider" | "readonly" | "none";

  /** Opens the fixture in a new page of `context` and boots `TinyCloudWeb`. */
  async function bootPage(context: BrowserContext, mode: Mode = "provider"): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => window.__purge !== undefined, undefined, { timeout: WAIT_MS });
    await page.evaluate((input) => window.__purge.boot(input), { host, walletKey: WALLET_KEY, mode, prefix: "notes/" });
    return page;
  }

  /** Reloads the page and boots it again, as the next page load of the same app. */
  async function reboot(page: Page, mode: Mode = "provider"): Promise<void> {
    await page.reload();
    await page.waitForFunction(() => window.__purge !== undefined, undefined, { timeout: WAIT_MS });
    await page.evaluate((input) => window.__purge.boot(input), { host, walletKey: WALLET_KEY, mode, prefix: "notes/" });
  }

  const databases = (page: Page) => page.evaluate(() => window.__purge.databases());
  const contentRows = async (page: Page): Promise<number> => {
    const rows = await page.evaluate(() => window.__purge.rows());
    return (rows?.entries ?? 0) + (rows?.blobs ?? 0);
  };

  scenario("sign-out: the replica database is not listed once signOut() resolves, the deny floor stays", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__purge.signIn());
      expect(await page.evaluate(() => window.__purge.sync())).toEqual({ status: "ok" });
      expect(await databases(page)).toContain(KV_DATABASE);
      expect(await contentRows(page)).toBeGreaterThan(0);

      expect(await page.evaluate(() => window.__purge.signOut())).toEqual({ status: "resolved" });

      expect(await databases(page)).not.toContain(KV_DATABASE);
      expect(await page.evaluate(() => window.__purge.originFlags())).toEqual({ tombstone: true, marker: false });
      expect(await page.evaluate(() => window.__purge.keyPresence())).toEqual({ gateHmac: false, accountKey: false });
      expect(await page.evaluate(() => window.__purge.purgeFailures())).toEqual([]);
      // Nothing to erase any more: the call is idempotent.
      expect(await page.evaluate(() => window.__purge.purgeLocalCopy())).toEqual({ ok: true });
    } finally {
      await closeContext(context);
    }
  });

  scenario("account switch: the old account's rows are gone and the replica is minted afresh for the new account", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__purge.signIn());
      expect(await page.evaluate(() => window.__purge.sync())).toEqual({ status: "ok" });
      const before = await page.evaluate(() => window.__purge.incarnation());
      expect(before).toBeDefined();
      expect(await contentRows(page)).toBeGreaterThan(0);

      await page.evaluate((key) => window.__purge.switchWallet(key), ACCOUNT_B_KEY);
      await page.evaluate(() => window.__purge.signIn());

      // Before the new account syncs anything, none of the old account's rows remain and the gate is new.
      expect(await contentRows(page)).toBe(0);
      expect(await page.evaluate(() => window.__purge.incarnation())).not.toBe(before);
      expect(await page.evaluate(() => window.__purge.originFlags())).toMatchObject({ tombstone: true, marker: false });
      expect(await page.evaluate(() => window.__purge.purgeFailures())).toEqual([]);
    } finally {
      await closeContext(context);
    }
  });

  scenario("a delete that keeps failing: signOut() resolves, the event fires, purgeLocalCopy() retries to success", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__purge.signIn());
      expect(await page.evaluate(() => window.__purge.sync())).toEqual({ status: "ok" });
      await page.evaluate(() => window.__purge.failDeleteDatabase());

      expect(await page.evaluate(() => window.__purge.signOut())).toEqual({ status: "resolved" });

      expect(await databases(page)).toContain(KV_DATABASE);
      expect(await page.evaluate(() => window.__purge.originFlags())).toEqual({ tombstone: true, marker: true });
      expect(await page.evaluate(() => window.__purge.purgeFailures())).toEqual([
        { type: "replica.purge.failed", trigger: "sign_out", reason: "logout_pending", code: "STORAGE_ERROR", retryNow: true },
      ]);
      expect(await page.evaluate(() => window.__purge.purgeLocalCopy())).toEqual({ ok: false, retryNow: true });

      await page.evaluate(() => window.__purge.clearDeleteFailure());
      expect(await page.evaluate(() => window.__purge.purgeLocalCopy())).toEqual({ ok: true });
      expect(await databases(page)).not.toContain(KV_DATABASE);
      expect(await page.evaluate(() => window.__purge.originFlags())).toEqual({ tombstone: true, marker: false });
    } finally {
      await closeContext(context);
    }
  });

  scenario("a failed erase is finished on the next load through the pending marker", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__purge.signIn());
      expect(await page.evaluate(() => window.__purge.sync())).toEqual({ status: "ok" });
      await page.evaluate(() => window.__purge.failDeleteDatabase());
      expect(await page.evaluate(() => window.__purge.signOut())).toEqual({ status: "resolved" });
      expect(await databases(page)).toContain(KV_DATABASE);
      expect(await page.evaluate(() => window.__purge.originFlags())).toMatchObject({ marker: true });

      // The next page load has no injected fault: startup recovery deletes the database and clears the marker.
      await reboot(page);
      await page.waitForFunction(async () => !(await window.__purge.databases()).includes("tinycloud-replica-kv"), undefined, { timeout: WAIT_MS });

      expect(await databases(page)).not.toContain(KV_DATABASE);
      expect(await page.evaluate(() => window.__purge.originFlags())).toEqual({ tombstone: true, marker: false });
      expect(await page.evaluate(() => window.__purge.keyPresence())).toEqual({ gateHmac: false, accountKey: false });
    } finally {
      await closeContext(context);
    }
  });

  scenario("restore with replication configured and NO wallet provider is gated with the typed reason", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__purge.signIn());
      expect(await page.evaluate(() => window.__purge.sync())).toEqual({ status: "ok" });

      await reboot(page, "none");
      expect(await page.evaluate(() => window.__purge.restoreSession())).toEqual({ status: "restored" });

      expect(await page.evaluate(() => window.__purge.status())).toMatchObject({ state: "gated", gate: "wallet_provider_required" });
      expect(await page.evaluate(() => window.__purge.sync())).toMatchObject({
        status: "error", code: "REPLICA_GATED", gate: "wallet_provider_required",
      });
    } finally {
      await closeContext(context);
    }
  });

  scenario("restore with a read-only provider (silent eth_accounts, signing throws 4200) refills the copy", async () => {
    const context = await newContext();
    try {
      const page = await bootPage(context);
      await page.evaluate(() => window.__purge.signIn());
      expect(await page.evaluate(() => window.__purge.sync())).toEqual({ status: "ok" });

      await reboot(page, "readonly");
      expect(await page.evaluate(() => window.__purge.restoreSession())).toEqual({ status: "restored" });

      expect(await page.evaluate(() => window.__purge.status())).not.toMatchObject({ state: "gated" });
      expect(await page.evaluate(() => window.__purge.sync())).toEqual({ status: "ok" });
      expect(await contentRows(page)).toBeGreaterThan(0);
    } finally {
      await closeContext(context);
    }
  });
});
