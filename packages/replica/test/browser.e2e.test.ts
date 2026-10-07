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
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NODE_BIN = process.env.TC_REPLICA_E2E_NODE_BIN ?? process.env.TC_NODE_BIN;
const FIXTURE_DIST = resolve(import.meta.dir, "browser/fixture/dist");
/** The package root: `/pkg/` serves it verbatim for the default-worker page. */
const PACKAGE_ROOT = resolve(import.meta.dir, "..");
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
  /** A second user's DID — partitions replicas; no real identity needed. */
  const OTHER_PRINCIPAL = "did:pkh:eip155:1:0x0000000000000000000000000000000000000002";
  /** The partition test's second principal — expiry test B's OTHER_PRINCIPAL
   *  database keeps a learned-revocation marker, so it cannot be reused. */
  const PARTITION_PRINCIPAL = "did:pkh:eip155:1:0x0000000000000000000000000000000000000003";

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

  /** The signed-in user's identity DID — the replica partition. */
  const ownerPrincipal = () => owner.did;

  async function openReplicaOnPage(
    target: Page,
    options: { principal?: string; prefix?: string; defaultWorker?: boolean } = {},
  ): Promise<{ replicaId: string; deviceDid: string; created: boolean; status: unknown }> {
    return target.evaluate(
      async (input) =>
        window.__replica.open({
          host: input.host,
          space: input.space,
          prefix: input.prefix ?? "notes/",
          principal: input.principal,
          ...(input.defaultWorker === true ? { defaultWorker: true } : {}),
        }),
      { host, space, prefix: options.prefix, principal: options.principal ?? ownerPrincipal(), defaultWorker: options.defaultWorker },
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
        const typeOf = (path: string) =>
          path.endsWith(".js") || path.endsWith(".ts")
            ? "text/javascript"
            : path.endsWith(".html")
              ? "text/html"
              : path.endsWith(".map")
                ? "application/json"
                : "application/octet-stream";
        // `/pkg/` exposes the package root verbatim so the importmap page can
        // load the real dist files — nothing emits a worker asset for it.
        if (url.pathname.startsWith("/pkg/")) {
          const rel = decodeURIComponent(url.pathname.slice(5));
          const target = resolve(PACKAGE_ROOT, rel);
          if (!target.startsWith(PACKAGE_ROOT)) return new Response("forbidden", { status: 403 });
          const file = Bun.file(target);
          if (!(await file.exists())) return new Response("not found", { status: 404 });
          return new Response(file, { headers: { "content-type": typeOf(rel) } });
        }
        if (url.pathname === "/default.html") {
          const file = Bun.file(join(import.meta.dir, "browser/default.html"));
          return new Response(file, { headers: { "content-type": "text/html" } });
        }
        const path = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = Bun.file(join(FIXTURE_DIST, path));
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        return new Response(file, { headers: { "content-type": typeOf(path) } });
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
    // The partition label: the owner's signed-in identity DID (pkh). Stable
    // across reopens and session-key rotations, so the replicaId stays.

    // 1. Open the page, mint a grant for the worker's device DID, sync. The
    //    service worker must control the page BEFORE the replica worker is
    //    fetched, or the worker asset is never cached and the offline reload
    //    below cannot spawn it.
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => window.__replica !== undefined);
    await page.waitForFunction(() => window.__replica.serviceWorkerReady());
    const opened = await openReplicaOnPage(page, { principal: ownerPrincipal() });
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
    // DB and re-install the grant (same CID — a no-op) for its window.
    await openReplicaOnPage(page, { principal: ownerPrincipal() });
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
    await openReplicaOnPage(page, { principal: ownerPrincipal() });
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
    // principal = the signed-in user DID (pkh).

    // Two tabs on the same origin share the IndexedDB database and the Web
    // Lock for its replicaId.
    const page1 = await context.newPage();
    const page2 = await context.newPage();
    await page1.goto(`${origin}/`);
    await page2.goto(`${origin}/`);
    await openReplicaOnPage(page1, { principal: ownerPrincipal() });
    await openReplicaOnPage(page2, { principal: ownerPrincipal() });
    // Both tabs share the replica's IndexedDB and its Web Lock; each installs
    // the owner grant before reads.
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
    // principal = the owner pkh DID (revoker shares the key).
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => window.__replica !== undefined);
    await page.waitForFunction(() => window.__replica.serviceWorkerReady());

    // Two principals ⇒ two replicaIds and two databases: A carries the 75 s
    // grant for expiry; B carries a long grant that is the ACTIVE grant of
    // its replica — since the v2 contract, revoking a pending grant discards
    // it without a purge, so revocation coverage must target the grant the
    // replica is already syncing under.
    const openedA = await openReplicaOnPage(page, { principal: ownerPrincipal() });
    const deviceDid = openedA.deviceDid;
    const kvScope = [{ service: "tinycloud.kv", space, path: "notes/", actions: ["get", "list", "metadata", "sync"] }];
    const grantA = await revoker.delegateTo(deviceDid, kvScope as never, { expiry: "75s" });
    const grantB = await revoker.delegateTo(deviceDid, kvScope as never, { expiry: "30d" });

    const installedA = await page.evaluate((jwt) => window.__replica.installGrant(jwt), grantA.delegation.delegationHeader.Authorization);
    await page.evaluate(() => window.__replica.sync());
    expect((await page.evaluate(() => window.__replica.get("notes/a"))).status).toBe("present");

    // Partition B: install grant B and sync once so it is the active grant.
    const openedB = await openReplicaOnPage(page, { principal: OTHER_PRINCIPAL });
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
    // Learned revocation is scoped to B's replicaId: partition A's data is
    // untouched, and — while A's grant is still inside its window — A reads
    // with the bytes it converged to in the happy path.
    await openReplicaOnPage(page, { principal: ownerPrincipal() });
    const intact = await page.evaluate(() => window.__replica.get("notes/a"));
    expect(intact.status === "present" && text(new Uint8Array(intact.value))).toBe(
      "alpha note, second version",
    );

    // Wait out grant A's signed window (real clock — the node enforces signed
    // absolute windows with its own clock, and 75 s is the shortest it
    // accepts), then reads on partition A raise GRANT_EXPIRED. Re-presenting
    // the expired grant is refused with GRANT_EXPIRED too.
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


  test("session-key rotation installs into the same replica and continues from its cursor", async () => {
    // `delegateTo` signs the device grant with the app's *session key*, which
    // rotates on every signIn. The replica partitions by `principal` (the
    // owner's pkh DID), so a grant minted under session 2 must land in the
    // same database and continue from session 1's cursor.
    const rotationPage = await context.newPage();
    await rotationPage.goto(`${origin}/`);
    await rotationPage.waitForFunction(() => window.__replica !== undefined);

    // Session 1 (the `owner` from beforeAll): install G1 and sync.
    const opened = await openReplicaOnPage(rotationPage, { principal: ownerPrincipal() });
    const g1MintedAt = Date.now();
    const g1 = await owner.delegateTo(opened.deviceDid, [
      { service: "tinycloud.kv", space, path: "notes/", actions: ["get", "list", "metadata", "sync"] },
    ] as never, { expiry: "75s" });
    const issuer1 = JSON.parse(
      Buffer.from(g1.delegation.delegationHeader.Authorization.split(".")[1]!, "base64url").toString(),
    ).iss as string;
    await rotationPage.evaluate((jwt) => window.__replica.installGrant(jwt), g1.delegation.delegationHeader.Authorization);
    const first = await rotationPage.evaluate(() => window.__replica.sync());
    expect(first).toMatchObject({ status: "synced" });

    // Session 2: signIn() rotates the session key — G2's issuer differs.
    const owner2 = new TinyCloudNode({ privateKey: OWNER_KEY, host, autoCreateSpace: true });
    await owner2.signIn();
    expect(owner2.did).toBe(owner.did); // the pkh identity is stable
    // Explicit-only abilities never enter the SIWE recap: session 2 must
    // mint its own runtime grant before delegateTo can derive under it.
    await owner2.grantRuntimePermissions(
      [{ service: "tinycloud.kv", space, path: "notes/", actions: ["get", "list", "metadata", "sync"] }] as never,
      { expiry: "30d" },
    );
    const g2 = await owner2.delegateTo(opened.deviceDid, [
      { service: "tinycloud.kv", space, path: "notes/", actions: ["get", "list", "metadata", "sync"] },
    ] as never, { expiry: "30d" });
    const issuer2 = JSON.parse(
      Buffer.from(g2.delegation.delegationHeader.Authorization.split(".")[1]!, "base64url").toString(),
    ).iss as string;
    expect(issuer2).not.toBe(issuer1);

    // The replica was created under S1's grant — installing S2's UCAN into
    // the same replicaId must not fail on the issuer difference.
    const reopened = await openReplicaOnPage(rotationPage, { principal: ownerPrincipal() });
    expect(reopened.replicaId).toBe(opened.replicaId);
    await rotationPage.evaluate((jwt) => window.__replica.installGrant(jwt), g2.delegation.delegationHeader.Authorization);

    // G2 is pending, not promoted: status still reports G1 as the active
    // delegation until a node-attested page replaces it.
    const preSync = await rotationPage.evaluate(() => window.__replica.status());
    expect(preSync.status.device.delegationCid).toBe(g1.delegation.cid);
    expect(preSync.status.device.pendingDelegationCid).toBe(g2.delegation.cid);

    // The pending grant never replaces the window early: once G1's signed
    // window lapses (75 s is the shortest the node accepts) reads fail — the
    // stored data does not borrow authority from G2.
    const waitMs = g1MintedAt + 75_000 - Date.now() + 1500;
    if (waitMs > 0) await Bun.sleep(waitMs);
    const expiredRead = await rotationPage.evaluate(() =>
      window.__replica.get("notes/a").catch((error: Error) => ({ code: (error as { code?: string }).code })),
    );
    expect((expiredRead as { code?: string }).code).toBe("GRANT_EXPIRED");

    // One write, then sync: the cursor continues — exactly one change, not a
    // resync of the fixture keys. The attested page promotes G2.
    await kvPut("notes/rotation", "after rotation");
    const second = await rotationPage.evaluate(() => window.__replica.sync());
    expect(second).toMatchObject({ status: "synced", changes: 1 });
    const postSync = await rotationPage.evaluate(() => window.__replica.status());
    expect(postSync.status.device.delegationCid).toBe(g2.delegation.cid);

    // Reads work again under G2's attestation — past G1's expiry, so the
    // data provably rides G2 now.
    const after = await rotationPage.evaluate(() => window.__replica.get("notes/rotation"));
    expect(after.status === "present" && text(new Uint8Array(after.value))).toBe("after rotation");
    await rotationPage.close();
  }, 240_000);

  test("two principals get separate replicas; purging one leaves the other intact", async () => {
    // `principal` partitions the local replica, not the sync scope: both
    // databases hold the same notes/ data, so a purge of one proves its
    // boundary by leaving the other readable.
    await kvPut("notes/partition", "shared across principals");
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await pageA.goto(`${origin}/`);
    await pageB.goto(`${origin}/`);
    await pageA.waitForFunction(() => window.__replica !== undefined);
    await pageB.waitForFunction(() => window.__replica !== undefined);

    const openedA = await openReplicaOnPage(pageA, { principal: ownerPrincipal() });
    const openedB = await openReplicaOnPage(pageB, { principal: PARTITION_PRINCIPAL });
    expect(openedB.replicaId).not.toBe(openedA.replicaId);

    // The grant's issuer is unrelated to `principal`: the same owner-signed
    // scope installs into either partition.
    const grantA = await mintOnPage(pageA);
    await pageA.evaluate((jwt) => window.__replica.installGrant(jwt), grantA);
    await pageA.evaluate(() => window.__replica.sync());
    expect((await pageA.evaluate(() => window.__replica.get("notes/partition"))).status).toBe("present");
    const grantB = await mintOnPage(pageB);
    await pageB.evaluate((jwt) => window.__replica.installGrant(jwt), grantB);
    await pageB.evaluate(() => window.__replica.sync());
    expect((await pageB.evaluate(() => window.__replica.get("notes/partition"))).status).toBe("present");

    // Purging A wipes its database in place — the file remains as a small
    // empty database named by the hash — and reports the reset to its own
    // client (BroadcastChannel never echoes to the sender).
    await pageA.evaluate(() => window.__replica.reset({ purge: true }));
    expect(await pageA.evaluate(() => window.__replica.resetReasons().filter((r) => r === "purge").length)).toBe(1);
    const dump = await pageA.evaluate(() => window.__replica.dumpDatabases());
    expect(dump.some((db) => db.name.includes(openedA.replicaId))).toBe(true);
    const still = await pageB.evaluate(() => window.__replica.get("notes/partition"));
    expect(still.status === "present" && text(new Uint8Array(still.value))).toBe("shared across principals");
    await pageA.close();
    await pageB.close();
  }, 120_000);

  test("the packaged worker URL (no `worker` option) spawns and syncs", async () => {
    // /default.html uses an importmap to the raw package dist: the build
    // emits no worker asset for it, so this passes only if the package's own
    // `new URL("./replica.worker.js", import.meta.url)` resolves — the old
    // ?url-imported asset used to mask a broken packaged path.
    const pageD = await context.newPage();
    await pageD.goto(`${origin}/default.html`);
    await pageD.waitForFunction(() => window.__replica !== undefined);
    const opened = await openReplicaOnPage(pageD);
    expect(opened.deviceDid.length).toBeGreaterThan(0);
    await grantOnPage(pageD);
    expect(await pageD.evaluate(() => window.__replica.sync())).toMatchObject({ status: "synced" });
    await pageD.close();
  }, 120_000);
});
