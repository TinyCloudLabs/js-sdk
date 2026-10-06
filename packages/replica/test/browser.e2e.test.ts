/**
 * The browser replica against a real TinyCloud node in real Chromium
 * (TC-19). A Vite-built fixture page uses `@tinycloud/replica/browser`
 * (worker + IndexedDB + Web Locks + BroadcastChannel); a test-only service
 * worker caches the shell for the offline reload; `Bun.serve` serves it;
 * Playwright's `chromium` drives it.
 *
 * Needs TC_REPLICA_E2E_NODE_BIN (or TC_NODE_BIN): a tinycloud node binary
 * serving `kv-sync-v1` (tinycloud-node ≥ d7f511f). Build first (`bun run
 * build`) and install the browser once (`bunx playwright install chromium`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { contentHash as hash } from "@tinycloud/replica";
import { PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
import { keyPair, signUcan } from "./fixtures.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NODE_BIN = process.env.TC_REPLICA_E2E_NODE_BIN ?? process.env.TC_NODE_BIN;
const FIXTURE_DIST = resolve(import.meta.dir, "browser/fixture/dist");
const OWNER_KEY = `0x${randomBytes(32).toString("hex")}`;

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

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const fixtures: Record<string, string> = {
  "notes/a": "alpha note",
  "notes/b": "beta note",
  "notes/deep/c": "gamma",
};

describe.skipIf(NODE_BIN === undefined)("browser replica against a real node", () => {
  let dataDir: string;
  let port: number;
  let host: string;
  let node: ChildProcess | undefined;
  let server: Bun.Server<undefined> | undefined;
  let origin = "";
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  /** Count of page requests that reached the node origin. */
  let nodeRequests = 0;

  // The owner: node-sdk with a private key, like `tc auth login --method local`.
  let owner: TinyCloudNode;
  let space = "";
  let spaceId = "";

  // A stable node key: a restart must come back with the same node DID, as a
  // real deployment does — the replica pins its source and refuses a feed
  // from a different DID as SOURCE_CHANGED.
  const nodeSecret = randomBytes(48).toString("base64url");

  async function startNode(): Promise<void> {
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

  async function openReplicaOnPage(
    target: Page,
    options: { grantSubject?: string; prefix?: string; defaultWorker?: boolean } = {},
  ): Promise<{ replicaId: string; deviceDid: string; created: boolean; authorized: boolean; status: unknown }> {
    return target.evaluate(
      async (input) =>
        window.__replica.open({
          host: input.host,
          space: input.space,
          prefix: input.prefix ?? "notes/",
          ...(input.grantSubject === undefined ? {} : { grantSubject: input.grantSubject }),
          ...(input.defaultWorker === true ? { defaultWorker: true } : {}),
        }),
      { host, space, prefix: options.prefix, grantSubject: options.grantSubject, defaultWorker: options.defaultWorker },
    );
  }

  /** Mint (without installing) a grant for the page's replica device DID. */
  async function mintOnPage(
    target: Page,
    options: { actions?: string[]; expiry?: string; path?: string } = {},
  ): Promise<string> {
    const deviceDid = await target.evaluate(() => window.__replica.deviceDid());
    const requested = [
      {
        service: "tinycloud.kv",
        space,
        path: options.path ?? "notes/",
        actions: options.actions ?? ["get", "list", "metadata", "sync"],
      },
    ];
    await owner.grantRuntimePermissions(requested as never, { expiry: options.expiry ?? "30d" });
    const minted = await owner.delegateTo(
      deviceDid,
      requested as never,
      options.expiry === undefined ? {} : { expiry: options.expiry },
    );
    return minted.delegation.delegationHeader.Authorization;
  }

  /** Mint and install a grant for the page's replica device DID. */
  async function grantOnPage(
    target: Page,
    options: { actions?: string[]; expiry?: string; path?: string } = {},
  ): Promise<string> {
    const deviceDid = await target.evaluate(() => window.__replica.deviceDid());
    const requested = [
      {
        service: "tinycloud.kv",
        space,
        path: options.path ?? "notes/",
        actions: options.actions ?? ["get", "list", "metadata", "sync"],
      },
    ];
    // `tinycloud.kv/sync` is explicit-only (TC-732): it is never in the SIWE
    // recap, so `delegateTo` alone cannot mint it. Like `tc auth grant`, the
    // owner first signs a runtime grant to itself (wallet path, no
    // derivability check) and `delegateTo` then derives the UCAN under it.
    await owner.grantRuntimePermissions(requested as never, {
      expiry: options.expiry ?? "30d",
    });
    const minted = await owner.delegateTo(
      deviceDid,
      requested as never,
      options.expiry === undefined ? {} : { expiry: options.expiry },
    );
    const authorization = minted.delegation.delegationHeader.Authorization;
    await target.evaluate((jwt) => window.__replica.installGrant(jwt), authorization);
    return authorization;
  }

  async function kvPut(key: string, value: string): Promise<void> {
    // SQLite can return a transient "database is locked" while the node is
    // still warming; retry the write a few times. (Real clock: the lock is
    // held by the live node process; a fake timer cannot release it.)
    for (let attempt = 0; ; attempt += 1) {
      const result = await owner.kv.put(key, new TextEncoder().encode(value));
      if (result.ok) return;
      const message = JSON.stringify(result.error);
      if (attempt >= 4 || !message.includes("database is locked")) {
        throw new Error(`kv put ${key} failed: ${message}`);
      }
      await Bun.sleep(250);
    }
  }

  async function kvDelete(key: string): Promise<void> {
    const result = await owner.kv.delete(key);
    if (!result.ok) throw new Error(`kv delete ${key} failed: ${JSON.stringify(result.error)}`);
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "tc-replica-browser-node-"));
    port = await freePort();
    host = `http://127.0.0.1:${port}`;
    await startNode();
    const info = (await (await fetch(`${host}/info`)).json()) as { features?: string[] };
    if (!info.features?.includes("kv-sync-v1")) throw new Error(`node lacks kv-sync-v1: ${JSON.stringify(info)}`);

    // Static fixture (Vite build output + the test-only service worker).
    const fixturePort = await freePort();
    origin = `http://127.0.0.1:${fixturePort}`;
    server = Bun.serve({
      port: fixturePort,
      async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = Bun.file(join(FIXTURE_DIST, path));
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        const type = path.endsWith(".js") || path.endsWith(".ts")
          ? "text/javascript"
          : path.endsWith(".html")
            ? "text/html"
            : "application/octet-stream";
        return new Response(file, { headers: { "content-type": type } });
      },
    });

    // The owner session and fixture data.
    owner = new TinyCloudNode({ privateKey: OWNER_KEY, host, autoCreateSpace: true });
    await owner.signIn();
    spaceId = owner.session!.spaceId;
    space = spaceId;
    for (const [key, value] of Object.entries(fixtures)) await kvPut(key, value);
    await kvPut("notes-secret/x", "OUT-OF-SCOPE-SECRET");
    await kvPut("other/y", "OUT-OF-SCOPE-OTHER");

    // Chromium. The node ships no CORS headers; the fixture adds them at the
    // driver layer so worker fetches succeed exactly as they would behind a
    // CORS-enabled deployment (kv-sync spec calls for ACAO:*).
    browser = await chromium.launch();
    context = await browser.newContext();
    await context.route(`${host}/**`, async (route) => {
      // Reaching this handler means the page's network stack touched the
      // node origin; counted as a node request.
      nodeRequests += 1;
      const request = route.request();
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, tinycloud-trace-id, x-tinycloud-*",
      };
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    });
    page = await context.newPage();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop();
    await stopNode();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("happy path: sync, blake3-equal reads, offline reload, reconverge", async () => {
    // The grant's issuer: the owner's session DID (the runtime-grant UCAN is
    // signed by the owner's session key). Stable across reopens so the
    // replicaId partition stays the same.
    const grantSubject = owner.sessionDid.split("#", 1)[0]!;

    // 1. Open the page, mint a grant for the worker's device DID, sync. The
    //    service worker must control the page BEFORE the replica worker is
    //    fetched, or the worker asset is never cached and the offline reload
    //    below cannot spawn it.
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => window.__replica !== undefined);
    await page.waitForFunction(() => window.__replica.serviceWorkerReady());
    const opened = await openReplicaOnPage(page, { grantSubject });
    expect(opened.replicaId.length).toBeGreaterThan(0);
    const grantJwt = await grantOnPage(page);
    const first = await page.evaluate(() => window.__replica.sync());
    expect(first).toMatchObject({ status: "synced", coverage: "complete" });

    // Values are blake3-identical to the owner's.
    for (const [key, value] of Object.entries(fixtures)) {
      const got = await page.evaluate((k) => window.__replica.get(k), key);
      expect(got.status).toBe("present");
      if (got.status !== "present") throw new Error("unreachable");
      const bytes = new Uint8Array(got.value);
      expect(hash(bytes)).toBe(hash(new TextEncoder().encode(value)));
      expect(text(bytes)).toBe(value);
    }
    const listed = await page.evaluate(() => window.__replica.list());
    expect(listed.entries.map((entry: { key: string }) => entry.key)).toEqual(Object.keys(fixtures).sort());

    // 2. The service worker controls the page (its own first load was
    //    cache-miss); a warm reload caches every shell asset.
    await page.waitForFunction(() => window.__replica.serviceWorkerReady());
    await page.reload();
    await page.waitForFunction(() => window.__replica !== undefined);
    await page.waitForFunction(() => window.__replica.serviceWorkerReady());

    // 3. Stop the node; reload offline. get/list come from IndexedDB with
    //    zero requests to the node.
    await stopNode();
    nodeRequests = 0;
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => window.__replica !== undefined);
    // The worker persists the device key and config; open again on the same
    // DB. The new session must re-present the grant to read another
    // principal's bound data — the install is a same-CID no-op.
    await openReplicaOnPage(page, { grantSubject });
    await page.evaluate((jwt) => window.__replica.installGrant(jwt), grantJwt);
    const got = await page.evaluate((k) => window.__replica.get(k), "notes/a");
    expect(got.status).toBe("present");
    if (got.status !== "present") throw new Error("unreachable");
    expect(text(new Uint8Array(got.value))).toBe(fixtures["notes/a"]!);
    const offlineKeys = (await page.evaluate(() => window.__replica.list())).entries.map(
      (entry: { key: string }) => entry.key,
    );
    expect(offlineKeys).toEqual(Object.keys(fixtures).sort());
    expect(nodeRequests).toBe(0);

    // 4. Restart the node; the owner updates, deletes and adds while the
    //    replica is away. The node DID is stable across restarts, so the
    //    cursor stays valid and the delete replays as a tombstone (deleted),
    //    the update and the new key land as live changes.
    await startNode();
    await context.setOffline(false);
    await page.waitForFunction(() => window.__replica !== undefined);
    await openReplicaOnPage(page, { grantSubject });
    await page.evaluate((jwt) => window.__replica.installGrant(jwt), grantJwt);
    await kvPut("notes/a", "alpha note, second version");
    await kvDelete("notes/b");
    await kvPut("notes/deep/new", "added");
    const second = await page.evaluate(() => window.__replica.sync());
    expect(second).toMatchObject({ status: "synced" });
    const convergedA = await page.evaluate(() => window.__replica.get("notes/a"));
    expect(convergedA.status === "present" && text(new Uint8Array(convergedA.value))).toBe(
      "alpha note, second version",
    );
    expect((await page.evaluate(() => window.__replica.get("notes/b"))).status).toBe("deleted");
    const convergedNew = await page.evaluate(() => window.__replica.get("notes/deep/new"));
    expect(convergedNew.status === "present" && text(new Uint8Array(convergedNew.value))).toBe("added");

    // 4b. An in-epoch delete lands as a tombstone.
    await kvDelete("notes/deep/c");
    const third = await page.evaluate(() => window.__replica.sync());
    expect(third).toMatchObject({ status: "synced" });
    expect((await page.evaluate(() => window.__replica.get("notes/deep/c"))).status).toBe("deleted");


    // 5. Nothing outside notes/ reached IndexedDB: no keys, no bytes.
    const dump = await page.evaluate(() => window.__replica.dumpDatabases());
    const allKeys = dump.flatMap((db) => Object.values(db.stores).flatMap((store) => store.keys));
    const allBytes = dump.map((db) => Object.values(db.stores).map((store) => store.bytes).join("")).join("");
    expect(allKeys.some((key) => key.startsWith("notes-secret/") || key.startsWith("other/"))).toBe(false);
    expect(allBytes).not.toContain("OUT-OF-SCOPE");
  }, 180_000);


  test("one tab syncs at a time: busy for the second, committed events across tabs, lock releases on close", async () => {
    const grantSubject = owner.sessionDid.split("#", 1)[0]!;

    // Two tabs on the same origin share the IndexedDB database and the Web
    // Lock for its replicaId.
    const page1 = await context.newPage();
    const page2 = await context.newPage();
    await page1.goto(`${origin}/`);
    await page2.goto(`${origin}/`);
    await page1.waitForFunction(() => window.__replica !== undefined);
    await page2.waitForFunction(() => window.__replica !== undefined);
    await openReplicaOnPage(page1, { grantSubject });
    await openReplicaOnPage(page2, { grantSubject });
    // Each tab's worker session must present a grant before it may read the
    // issuer-bound database.
    await grantOnPage(page1);
    await grantOnPage(page2);

    // A real change for the non-holder to observe after page1 commits.
    await kvPut("notes/twotab", "written during the two-tab test");

    // Freeze node-bound requests so page1 holds the writer lock. `fallback`
    // (not `continue`) reaches the earlier CORS handler. `entered` settles
    // when page1's worker is parked at the fetch — i.e. already holds the lock.
    const makeGate = () => {
      const { promise: blocked, resolve: open } = Promise.withResolvers<void>();
      const { promise: entered, resolve: mark } = Promise.withResolvers<void>();
      const handler = async (route: { fallback(): Promise<void> }) => {
        mark();
        await blocked;
        await route.fallback();
      };
      return { blocked: entered, open, handler };
    };
    const gate1 = makeGate();
    await context.route(`${host}/**`, gate1.handler);

    const sync1 = page1.evaluate(() => window.__replica.sync());
    await gate1.blocked;
    const busy = await page2.evaluate(() => window.__replica.sync());
    expect(busy).toMatchObject({ status: "busy" });

    gate1.open();
    const done = await sync1;
    expect(done).toMatchObject({ status: "synced" });
    await context.unroute(`${host}/**`, gate1.handler);
    // The commit broadcast reached the sibling tab's main thread, and the
    // sibling reads the update page1 committed — proof of cross-tab delivery.
    await page2.waitForFunction(() => window.__replica.committedSerials().length > 0);
    const twotab = await page2.evaluate(() => window.__replica.get("notes/twotab"));
    expect(twotab.status === "present" && text(new Uint8Array(twotab.value))).toBe(
      "written during the two-tab test",
    );
    const listed = await page2.evaluate(() => window.__replica.list());
    expect(listed.entries.length).toBeGreaterThan(0);
    // Killing the holder releases the lock: page2 syncs next.
    const gate2 = makeGate();
    await context.route(`${host}/**`, gate2.handler);
    const hanging = page1.evaluate(() => window.__replica.sync());
    void hanging.catch(() => undefined);
    await gate2.blocked;
    await page1.close();
    gate2.open();
    await context.unroute(`${host}/**`, gate2.handler);
    // The dead tab's lock release is async — poll until page2 becomes writer.
    await page2.waitForFunction(async () => (await window.__replica.sync()).status === "synced");
    await page2.close();
  }, 120_000);

  test("expiry blocks reads; revocation purges and blocks reads", async () => {
    // Grants come from `revoker`: a second session over the same private key
    // whose SIWE manifest carries `tinycloud.delegation/revoke` — the node
    // refuses `revokeDelegation` from a session that only holds a runtime
    // grant (403 Unauthorized Revoker).
    const revoker = new TinyCloudNode({
      privateKey: OWNER_KEY,
      host,
      autoCreateSpace: true,
      manifest: {
        app_id: "tc-19-e2e-revoker",
        name: "TC-19 revoker",
        defaults: false,
        includePublicSpace: false,
        prefix: "",
        space,
        permissions: [
          { service: "tinycloud.kv", space, path: "notes/", actions: ["get", "list", "metadata", "sync"] },
          { service: "tinycloud.delegation", space, path: "", actions: ["revoke"] },
        ],
      } as never,
    });
    await revoker.signIn();
    const grantSubject = revoker.sessionDid.split("#", 1)[0]!;
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => window.__replica !== undefined);
    await page.waitForFunction(() => window.__replica.serviceWorkerReady());

    // Two partitions (grantSubject is part of the database name): A carries
    // the 75 s grant for expiry; B carries a long grant that is the ACTIVE
    // grant of its replica — since the v2 contract, revoking a pending grant
    // discards it without a purge, so revocation coverage must target the
    // grant the replica is already syncing under. B opens with an empty
    // grantSubject: distinct partition, and its installGrant binds the empty
    // partition to the revoker's issuer on first install.
    const openedA = await openReplicaOnPage(page, { grantSubject });
    const deviceDid = openedA.deviceDid;
    const kvScope = [{ service: "tinycloud.kv", space, path: "notes/", actions: ["get", "list", "metadata", "sync"] }];
    const grantA = await revoker.delegateTo(deviceDid, kvScope as never, { expiry: "75s" });
    const grantB = await revoker.delegateTo(deviceDid, kvScope as never, { expiry: "30d" });

    const installedA = await page.evaluate((jwt) => window.__replica.installGrant(jwt), grantA.delegation.delegationHeader.Authorization);
    await page.evaluate(() => window.__replica.sync());
    expect((await page.evaluate(() => window.__replica.get("notes/a"))).status).toBe("present");

    // Partition B: install grant B and sync once so it is the active grant.
    const openedB = await openReplicaOnPage(page);
    expect(openedB.replicaId).not.toBe(openedA.replicaId);
    await page.evaluate((jwt) => window.__replica.installGrant(jwt), grantB.delegation.delegationHeader.Authorization);
    await page.evaluate(() => window.__replica.sync());
    expect((await page.evaluate(() => window.__replica.get("notes/a"))).status).toBe("present");

    // The revoker revokes grant B (the active one); the next sync learns it
    // and the replica purges: reads throw and both stores are empty.
    const revoke = await revoker.revokeDelegation(grantB.delegation.cid);
    if (!revoke.ok) throw new Error(`revokeDelegation failed: ${JSON.stringify(revoke.error)}`);
    const syncError = await page.evaluate(() => window.__replica.sync().catch((error: Error) => ({ code: (error as { code?: string }).code })));
    expect((syncError as { code?: string }).code).toBe("GRANT_REVOKED");
    const revoked = await page.evaluate(() => window.__replica.get("notes/a").catch((error: Error) => ({ code: (error as { code?: string }).code })));
    expect((revoked as { code?: string }).code).toBe("GRANT_REVOKED");
    const dump = await page.evaluate(() => window.__replica.dumpDatabases());
    const replicaDbB = dump.find((db) => db.name.includes(openedB.replicaId));
    expect(replicaDbB).not.toBeUndefined();
    expect((replicaDbB?.stores["entries"]?.keys ?? []) as string[]).toEqual([]);
    // Blob records key by `hash` (not `key`), so content shows up in `bytes`.
    expect(replicaDbB?.stores["blobs"]?.bytes ?? "").toBe("");

    // Wait out grant A's signed window (real clock — the node enforces signed
    // absolute windows with its own clock, and 75 s is the shortest it
    // accepts), then reads on partition A raise GRANT_EXPIRED. The new
    // session must re-present the grant: an expired UCAN still proves the
    // session's principal even though its install is refused.
    await openReplicaOnPage(page, { grantSubject });
    if (installedA.expiresAt === null) throw new Error("grant A has no expiry");
    const waitMs = installedA.expiresAt * 1000 - Date.now() + 1500;
    if (waitMs > 0) await Bun.sleep(waitMs);
    const installResult = await page.evaluate(
      (jwt) => window.__replica.installGrant(jwt).catch((error: Error) => ({ code: (error as { code?: string }).code })),
      grantA.delegation.delegationHeader.Authorization,
    );
    expect((installResult as { code?: string }).code).toBe("GRANT_EXPIRED");
    const expired = await page.evaluate(() => window.__replica.get("notes/a").catch((error: Error) => ({ code: (error as { code?: string }).code })));
    expect((expired as { code?: string }).code).toBe("GRANT_EXPIRED");
  }, 240_000);

  test("an empty-subject open binds the database to the first issuer; another principal cannot read it", async () => {
    // Apps that cannot name the issuer up front open without grantSubject —
    // the database then binds to whoever installs first, and stays theirs.
    // `bound/` is this test's own prefix partition: issuer bindings survive
    // purges, so sharing the empty notes/ partition with earlier tests would
    // interleave their issuers.
    await kvPut("bound/a", "bound data");
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await pageA.goto(`${origin}/`);
    await pageB.goto(`${origin}/`);
    await pageA.waitForFunction(() => window.__replica !== undefined);
    await pageB.waitForFunction(() => window.__replica !== undefined);

    await openReplicaOnPage(pageA, { prefix: "bound/" });
    const grantJwt = await grantOnPage(pageA, { path: "bound/" });
    await pageA.evaluate(() => window.__replica.sync());
    const seeded = await pageA.evaluate(() => window.__replica.get("bound/a"));
    expect(seeded.status === "present" && text(new Uint8Array(seeded.value))).toBe("bound data");

    // A second tab on the same partition has no verified principal yet: the
    // bound issuer's data is refused until it presents that issuer's grant.
    await openReplicaOnPage(pageB, { prefix: "bound/" });
    const denied = await pageB.evaluate(() =>
      window.__replica.get("bound/a").catch((error: Error) => ({ code: (error as { code?: string }).code })),
    );
    expect((denied as { code?: string }).code).toBe("GRANT_UNAUTHORIZED");

    // A foreign issuer's grant cannot bind the database — minted in-test so
    // its issuer is a key nothing else uses.
    const other = keyPair();
    const deviceDid = await pageB.evaluate(() => window.__replica.deviceDid());
    const foreignJwt = signUcan(other, {
      aud: deviceDid,
      exp: Math.floor(Date.now() / 1000) + 3600,
      att: { [`${space}/kv/bound/`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/sync": [{}] } },
      prf: ["bafyparent"],
    });
    const refused = await pageB.evaluate(
      (jwt) => window.__replica.installGrant(jwt).catch((error: Error) => ({ code: (error as { code?: string }).code })),
      foreignJwt,
    );
    expect((refused as { code?: string }).code).toBe("GRANT_INVALID");
    const stillDenied = await pageB.evaluate(() =>
      window.__replica.get("bound/a").catch((error: Error) => ({ code: (error as { code?: string }).code })),
    );
    expect((stillDenied as { code?: string }).code).toBe("GRANT_UNAUTHORIZED");

    // The bound issuer's grant verifies the session; reads succeed.
    await pageB.evaluate((jwt) => window.__replica.installGrant(jwt), grantJwt);
    expect((await pageB.evaluate(() => window.__replica.get("bound/a"))).status).toBe("present");
    await pageA.close();
    await pageB.close();
  }, 120_000);

  test("a refused grant install never authorizes; unauthorized sessions see a restricted status", async () => {
    // `denied/` is this test's own partition — the empty notes/ partition is
    // already bound to the owner's subject in earlier tests.
    await kvPut("denied/a", "denied data");
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await pageA.goto(`${origin}/`);
    await pageB.goto(`${origin}/`);
    await pageA.waitForFunction(() => window.__replica !== undefined);
    await pageB.waitForFunction(() => window.__replica !== undefined);

    await openReplicaOnPage(pageA, { prefix: "denied/" });
    const grantJwt = await grantOnPage(pageA, { path: "denied/" });
    await pageA.evaluate(() => window.__replica.sync());
    expect((await pageA.evaluate(() => window.__replica.get("denied/a"))).status).toBe("present");

    // Before any grant, open() and status() expose only the restricted view:
    // no replica state at all — key names, etags, counts and lastError stay
    // hidden until the bound issuer's grant lands.
    const openedB = await openReplicaOnPage(pageB, { prefix: "denied/" });
    expect(openedB.authorized).toBe(false);
    expect(openedB.status).toBeNull();
    const statusB = await pageB.evaluate(() => window.__replica.status());
    expect(statusB.authorized).toBe(false);
    expect(statusB.status).toBeNull();
    expect(statusB.persistence).not.toBeNull();

    // The bound issuer's grant covering a *different* path installs nothing
    // and authorizes nothing.
    const wrongPath = await mintOnPage(pageB, { path: "elsewhere/" });
    const notCovering = await pageB.evaluate(
      (jwt) => window.__replica.installGrant(jwt).catch((error: Error) => ({ code: (error as { code?: string }).code })),
      wrongPath,
    );
    expect((notCovering as { code?: string }).code).toBe("GRANT_NOT_COVERING");
    const deniedRead = await pageB.evaluate(() =>
      window.__replica.get("denied/a").catch((error: Error) => ({ code: (error as { code?: string }).code })),
    );
    expect((deniedRead as { code?: string }).code).toBe("GRANT_UNAUTHORIZED");

    // A grant from the bound issuer that is already expired when presented
    // fails its install and still authorizes nothing.
    const shortJwt = await mintOnPage(pageB, { path: "denied/", expiry: "3s" });
    await Bun.sleep(4_000);
    const expired = await pageB.evaluate(
      (jwt) => window.__replica.installGrant(jwt).catch((error: Error) => ({ code: (error as { code?: string }).code })),
      shortJwt,
    );
    expect((expired as { code?: string }).code).toBe("GRANT_EXPIRED");
    const stillDenied = await pageB.evaluate(() =>
      window.__replica.get("denied/a").catch((error: Error) => ({ code: (error as { code?: string }).code })),
    );
    expect((stillDenied as { code?: string }).code).toBe("GRANT_UNAUTHORIZED");

    // The bound issuer's own valid grant authorizes the session: full status
    // and reads return.
    await pageB.evaluate((jwt) => window.__replica.installGrant(jwt), grantJwt);
    const authorizedStatus = await pageB.evaluate(() => window.__replica.status());
    expect(authorizedStatus.authorized).toBe(true);
    expect(authorizedStatus.status).not.toBeNull();
    expect((await pageB.evaluate(() => window.__replica.get("denied/a"))).status).toBe("present");
    await pageA.close();
    await pageB.close();
  }, 120_000);

  test("the bundled worker URL (no `worker` option) spawns and syncs", async () => {
    // Fixture pages otherwise always pass the worker URL explicitly, which
    // would let the packaged `new URL("./replica.worker.js", import.meta.url)`
    // path rot. One real spawn exercises it.
    const pageD = await context.newPage();
    await pageD.goto(`${origin}/`);
    await pageD.waitForFunction(() => window.__replica !== undefined);
    const grantSubject = owner.sessionDid.split("#", 1)[0]!;
    const opened = await openReplicaOnPage(pageD, { grantSubject, defaultWorker: true });
    expect(opened.deviceDid.length).toBeGreaterThan(0);
    await grantOnPage(pageD);
    expect(await pageD.evaluate(() => window.__replica.sync())).toMatchObject({ status: "synced" });
    await pageD.close();
  }, 120_000);
});
