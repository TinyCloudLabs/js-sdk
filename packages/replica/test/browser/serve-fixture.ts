/**
 * Manual TC-19 fixture runner (test-only — not built, not published).
 *
 *   TC_REPLICA_E2E_NODE_BIN=<node binary> bun packages/replica/test/browser/serve-fixture.ts
 *
 * Starts a real tinycloud node on SQLite in a temp dir, an owner session
 * (node-sdk, private key) that seeds notes/a, notes/b, notes/bin and
 * notes-secret/x, serves the built fixture page plus manual.html on a fixed
 * port, and prints one self-completing URL: the page mints its device grant
 * through POST /admin/grant, puts the JWT in the hash and reloads.
 *
 * The node ships no CORS headers; a same-script proxy (TC_FIXTURE_PROXY_PORT)
 * forwards to the node with ACAO:* so the browser page can reach it — the
 * same role Playwright's route() plays in browser.e2e.test.ts.
 *
 * Admin endpoints (all on the fixture origin, JSON in/out):
 *   POST /admin/node/stop | /admin/node/start   — offline/online flow
 *   GET  /admin/node/state                      — { running, host }
 *   POST /admin/grant        { did, expiry? }   — mint + return a kv grant JWT
 *   POST /admin/grant/revoke { cid }            — revoke a minted grant
 *   POST /admin/mutate                          — owner: notes/a → new value,
 *                                                 delete notes/b
 */
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NODE_BIN = process.env.TC_REPLICA_E2E_NODE_BIN ?? process.env.TC_NODE_BIN;
if (NODE_BIN === undefined) {
  console.error("Set TC_REPLICA_E2E_NODE_BIN (or TC_NODE_BIN) to a tinycloud node binary with kv-sync-v1.");
  process.exit(1);
}

const FIXTURE_DIST = resolve(import.meta.dir, "fixture/dist");
const NODE_PORT = Number(process.env.TC_FIXTURE_NODE_PORT ?? 8920);
const PROXY_PORT = Number(process.env.TC_FIXTURE_PROXY_PORT ?? 8921);
const FIXTURE_PORT = Number(process.env.TC_FIXTURE_PORT ?? 8922);
const OWNER_KEY = `0x${randomBytes(32).toString("hex")}`;

const dataDir = await mkdtemp(join(tmpdir(), "tc-replica-fixture-node-"));
// A stable node key: a restart must come back with the same node DID, as a
// real deployment does — the replica pins its source.
const nodeSecret = randomBytes(48).toString("base64url");
const nodeHost = `http://127.0.0.1:${NODE_PORT}`;
const proxyHost = `http://127.0.0.1:${PROXY_PORT}`;

let node: ChildProcess | undefined;

async function startNode(): Promise<void> {
  if (node !== undefined && node.exitCode === null) return;
  const child = spawn(NODE_BIN!, [], {
    cwd: dataDir,
    env: {
      ...process.env,
      TINYCLOUD_STORAGE__DATADIR: join(dataDir, "data"),
      TINYCLOUD_KEYS__SECRET: nodeSecret,
      TINYCLOUD_ADDRESS: "127.0.0.1",
      TINYCLOUD_PORT: String(NODE_PORT),
      ROCKET_PORT: String(NODE_PORT),
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

const nodeRunning = () => node !== undefined && node.exitCode === null;

await startNode();
const info = (await (await fetch(`${nodeHost}/info`)).json()) as { features?: string[] };
if (!info.features?.includes("kv-sync-v1")) throw new Error(`node lacks kv-sync-v1: ${JSON.stringify(info)}`);

// The owner: node-sdk with a private key, like `tc auth login --method local`.
const owner = new TinyCloudNode({ privateKey: OWNER_KEY, host: nodeHost, autoCreateSpace: true });
await owner.signIn();
const space = owner.session!.spaceId;

async function kvPut(key: string, value: string | Uint8Array): Promise<void> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  // SQLite can return a transient "database is locked" while the node is
  // still warming; retry the write a few times.
  for (let attempt = 0; ; attempt += 1) {
    const result = await owner.kv.put(key, bytes);
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

await kvPut("notes/a", "alpha note");
await kvPut("notes/b", "beta note");
await kvPut("notes/bin", Uint8Array.from({ length: 64 }, (_, index) => index));
await kvPut("notes-secret/x", "OUT-OF-SCOPE-SECRET");
await kvPut("other/y", "OUT-OF-SCOPE-OTHER");

// `tinycloud.kv/sync` is explicit-only (TC-732): like `tc auth grant`, the
// owner first signs a runtime grant to itself and `delegateTo` derives the
// UCAN under it.
const kvScope = [{ service: "tinycloud.kv", space, path: "notes/", actions: ["get", "list", "metadata", "sync"] }];
await owner.grantRuntimePermissions(kvScope as never, { expiry: "30d" });

async function mintGrant(did: string, expiry = "30d"): Promise<{ jwt: string; cid: string }> {
  const grant = await owner.delegateTo(did, kvScope as never, { expiry });
  return { jwt: grant.delegation.delegationHeader.Authorization, cid: grant.delegation.cid };
}

// Revocation needs a session whose SIWE manifest carries
// tinycloud.delegation/revoke (see browser.e2e.test.ts).
let revoker: TinyCloudNode | undefined;
async function revokeGrant(cid: string): Promise<void> {
  revoker ??= await (async () => {
    const session = new TinyCloudNode({
      privateKey: OWNER_KEY,
      host: nodeHost,
      autoCreateSpace: true,
      manifest: {
        app_id: "tc-19-fixture-revoker",
        name: "TC-19 fixture revoker",
        defaults: false,
        includePublicSpace: false,
        prefix: "",
        space,
        permissions: [
          ...kvScope,
          { service: "tinycloud.delegation", space, path: "", actions: ["revoke"] },
        ],
      } as never,
    });
    await session.signIn();
    return session;
  })();
  const result = await revoker.revokeDelegation(cid);
  if (!result.ok) throw new Error(`revokeDelegation failed: ${JSON.stringify(result.error)}`);
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const readJson = async (request: Request): Promise<Record<string, unknown>> =>
  request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".ts": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

Bun.serve({
  hostname: "127.0.0.1",
  port: FIXTURE_PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/admin/node/state") return json({ running: nodeRunning(), host: nodeHost });
    if (path === "/admin/node/stop") {
      await stopNode();
      return json({ running: false });
    }
    if (path === "/admin/node/start") {
      await startNode();
      return json({ running: true, host: nodeHost });
    }
    if (path === "/admin/grant") {
      const body = await readJson(request);
      if (typeof body.did !== "string") return json({ error: "missing did" }, 400);
      return json(await mintGrant(body.did, typeof body.expiry === "string" ? body.expiry : "30d"));
    }
    if (path === "/admin/grant/revoke") {
      const body = await readJson(request);
      if (typeof body.cid !== "string" || body.cid === "") return json({ error: "missing cid" }, 400);
      await revokeGrant(body.cid);
      return json({ revoked: body.cid });
    }
    if (path === "/admin/mutate") {
      // The step-3 mutation: update notes/a, delete notes/b.
      await kvPut("notes/a", `alpha note — updated ${new Date().toISOString()}`);
      await kvDelete("notes/b");
      return json({ updated: "notes/a", deleted: "notes/b" });
    }

    // manual.html lives next to this script (test-only); the Vite bundle and
    // the service worker come from fixture/dist. The type is keyed on the
    // resolved file, not the request path — `/` is HTML, not octet-stream
    // (Chromium would otherwise download it and break the page).
    const local = path === "/" || path === "/manual.html" ? "manual.html" : undefined;
    const file = Bun.file(local === undefined ? join(FIXTURE_DIST, path) : join(import.meta.dir, local));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    const name = local ?? path;
    const type = CONTENT_TYPES[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream";
    return new Response(file, { headers: { "content-type": type } });
  },
});

// CORS proxy: the node origin as the page sees it, with ACAO:* added.
Bun.serve({
  hostname: "127.0.0.1",
  port: PROXY_PORT,
  async fetch(request) {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, tinycloud-trace-id, x-tinycloud-limit, x-tinycloud-cursor, x-tinycloud-cid, x-tinycloud-retention-grant, x-tinycloud-max-response-bytes, x-tinycloud-*",
      "access-control-allow-private-network": "true",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!nodeRunning()) return new Response("node is stopped", { status: 502, headers: cors });
    const url = new URL(request.url);
    const upstream = await fetch(`${nodeHost}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    });
    const headers = new Headers(upstream.headers);
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
});

const page = `http://127.0.0.1:${FIXTURE_PORT}/#${new URLSearchParams({ host: proxyHost, space, principal: owner.did }).toString()}`;
console.log(`node:      ${nodeHost} (data: ${dataDir})`);
console.log(`proxy:     ${proxyHost} (CORS-enabled view of the node)`);
console.log(`owner DID: ${owner.did}`);
console.log(`space:     ${space}`);
console.log(`fixture:   http://127.0.0.1:${FIXTURE_PORT}`);
console.log(`\nOpen in Chromium:\n  ${page}\n`);
console.log("The page mints its device grant on first load and reloads with it in the hash.");
console.log("Controls on the page: Sync / Get / List / Status / Dump IDB / Reset / Reset --purge.");
console.log(`Admin (curl http://127.0.0.1:${FIXTURE_PORT}…):`);
console.log("  -X POST /admin/node/stop    -X POST /admin/node/start");
console.log("  -X POST /admin/mutate       (update notes/a, delete notes/b)");
console.log('  -X POST /admin/grant        {"did":"<deviceDid>","expiry":"75s"}');
console.log('  -X POST /admin/grant/revoke {"cid":"<grantCid>"}');
console.log('Minted grants: /admin/grant returns {"jwt","cid"}; revoke needs the cid.');

// Keep the process alive; Ctrl-C stops the node too.
process.on("SIGINT", () => void stopNode().finally(() => process.exit(0)));
process.on("SIGTERM", () => void stopNode().finally(() => process.exit(0)));
