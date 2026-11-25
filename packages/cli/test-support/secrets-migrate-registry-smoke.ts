import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { resolveSecretPath } from "@tinycloud/sdk-services";
import { NodeWasmBindings } from "@tinycloud/node-sdk";
import { ProfileManager } from "../src/config/profiles.js";
import { createSDKInstance } from "../src/lib/sdk.js";

const root = process.env.TC_HOME!;
const nodeRoot = join(root, "node");
await mkdir(join(nodeRoot, "data"), { recursive: true });
const availablePort = Promise.withResolvers<number>();
const socket = createServer();
socket.on("error", availablePort.reject);
socket.listen(0, "127.0.0.1", () => {
  const address = socket.address();
  assert(address && typeof address !== "string");
  socket.close((error) => error ? availablePort.reject(error) : availablePort.resolve(address.port));
});
const port = await availablePort.promise;
const host = `http://127.0.0.1:${port}`;
let phase = "setup";
let v2 = 0, v1 = 0;
const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  if (phase === "migrate") {
    if (url.pathname.startsWith("/v2/locations/")) v2++;
    else if (url.pathname.startsWith("/v1/locations/")) v1++;
    else throw new Error(`Unexpected registry path ${url.pathname}`);
  }
  return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
} });
process.env.TC_REGISTRY_URL = registry.url.origin;
process.env.TC_SECRETS_NAMED_KEY_WRITES = "0";
const guard = join(root, "loopback-only.mjs");
await writeFile(guard, `const raw=globalThis.fetch;const allowed=new Set(${JSON.stringify([host, registry.url.origin])});globalThis.fetch=Object.assign((input,init)=>{const u=new URL(input instanceof Request?input.url:String(input));if(!allowed.has(u.origin))throw Error("Non-fixture origin refused: "+u.origin);return raw(input,init)},{preconnect:raw.preconnect});`);
const rawFetch = globalThis.fetch;
const allowed = new Set([host, registry.url.origin]);
globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert(allowed.has(url.origin), `Non-fixture origin refused: ${url.origin}`);
  return rawFetch(input, init);
}, { preconnect: rawFetch.preconnect });
const node = Bun.spawn([process.argv[2]!], {
  cwd: nodeRoot,
  env: {
    PATH: process.env.PATH, HOME: root, TMPDIR: root,
    TINYCLOUD_STORAGE__DATADIR: join(nodeRoot, "data"),
    TINYCLOUD_PORT: String(port), TINYCLOUD_ADDRESS: "127.0.0.1", ROCKET_PORT: String(port), ROCKET_ADDRESS: "127.0.0.1",
    TINYCLOUD_KEYS__TYPE: "Static", TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
    TINYCLOUD_ENCRYPTION_NETWORK__NAMED_KEYS_V1: "true",
    TINYCLOUD_ENCRYPTION_NETWORK__DELETION_LEDGER_PATH: join(nodeRoot, "ledger"),
  },
  stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
const launched = Promise.withResolvers<void>();
let nodeLog = "";
const consume = async (stream: ReadableStream<Uint8Array>) => {
  for await (const chunk of stream) {
    nodeLog = (nodeLog + new TextDecoder().decode(chunk)).slice(-16_384);
    if (nodeLog.includes("Rocket has launched")) launched.resolve();
  }
};
const logs = [consume(node.stdout), consume(node.stderr)];
const cli = async (args: string[]) => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", guard,
    new URL("../src/index.ts", import.meta.url).pathname, "--quiet", "--json", "--host", host, ...args], {
    env: { ...process.env, TC_HIDE_BANNER: "1", TINYCLOUD_CLI_LOGS: "0" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGTERM"), 180_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]).finally(() => clearTimeout(deadline));
  assert.equal(exitCode, 0, JSON.stringify({ args, exitCode, stderr }));
  return JSON.parse(stdout);
};
try {
  const startup = setTimeout(() => launched.reject(new Error(`Node startup timeout: ${nodeLog}`)), 30_000);
  try {
    await Promise.race([launched.promise, node.exited.then((code) => { throw new Error(`Node exited ${code}: ${nodeLog}`); })]);
  } finally { clearTimeout(startup); }
  const version = await (await fetch(`${host}/version`)).json() as { version?: string; features?: string[] };
  assert(version.features?.includes("encryption-named-keys-v1"), JSON.stringify(version));
  await cli(["init", "--name", "owner", "--key-only"]);
  await ProfileManager.updateProfile("owner", (profile) => ({ ...profile, tinycloudRegistryUrl: registry.url.origin }));
  await cli(["--profile", "owner", "auth", "login", "--method", "local"]);
  await cli(["--profile", "owner", "secrets", "network", "init"]);
  const ctx = { profile: "owner", host, tinycloudRegistryUrl: registry.url.origin,
    verbose: false, noCache: false, quiet: true, replication: false, replicationDebug: false };
  const owner = await createSDKInstance(ctx);
  const space = new NodeWasmBindings().makeSpaceId(owner.session!.address, owner.session!.chainId, "secrets");
  const kv = owner.kvForSpace(space);
  const entries = Array.from({ length: 140 }, (_, i) => ({
    name: `REGISTRY_TEST_${i}`,
    ...(i % 2 === 0 ? { scope: `fixture-${i % 7}` } : {}),
    value: `TC-4373-fixture-${i}`,
  }));
  for (const entry of entries) {
    const stored = await owner.secrets.put(entry.name, entry.value, { scope: entry.scope, namedKey: false });
    assert(stored.ok, JSON.stringify(stored));
    const resolved = resolveSecretPath(entry.name, { scope: entry.scope });
    const raw = await kv.get<string>(`vault/${resolved.vaultKey}`, { raw: true });
    assert(raw.ok, JSON.stringify(raw));
    if (raw.ok) assert.equal(JSON.parse(raw.data.data as string).v, 1);
  }
  phase = "migrate";
  const start = performance.now();
  const report = await cli(["--profile", "owner", "secrets", "migrate"]);
  const elapsedMs = performance.now() - start;
  phase = "verify";
  assert.deepEqual({ total: report.total, moved: report.moved, already: report.already,
    staysOnNetwork: report.staysOnNetwork, skipped: report.skipped }, {
    total: 140, moved: 140, already: 0, staysOnNetwork: 0, skipped: {},
  });
  const maxPairs = 1 + Math.floor(elapsedMs / 60_000);
  assert(v2 >= 1 && v2 <= maxPairs, JSON.stringify({ v2, v1, elapsedMs, maxPairs }));
  assert.equal(v1, v2);
  for (const entry of entries) {
    const resolved = resolveSecretPath(entry.name, { scope: entry.scope });
    const raw = await kv.get<string>(`vault/${resolved.vaultKey}`, { raw: true });
    assert(raw.ok, JSON.stringify(raw));
    if (raw.ok) {
      const envelope = JSON.parse(raw.data.data as string);
      assert.equal(envelope.v, 2);
      assert.equal(envelope.keyPath, resolved.keyPath);
    }
    // This seed SDK predates migrate's runtime grants; its owner explicitly authorizes the exact-key read.
    const read = await owner.secrets.get(entry.name, { scope: entry.scope, requestPermission: true });
    assert(read.ok, JSON.stringify(read));
    if (read.ok) assert.equal(read.data, entry.value);
  }
  console.log(JSON.stringify({ nodeVersion: version.version, exitCode: 0, total: report.total, moved: report.moved,
    verified: entries.length, v2, v1, maxPairs, elapsedMs }));
} catch (error) {
  console.error(JSON.stringify({ phase, v2, v1, error: error instanceof Error ? error.message : String(error) }));
  throw error;
} finally {
  node.kill("SIGTERM");
  await node.exited;
  await Promise.all(logs);
  globalThis.fetch = rawFetch;
  registry.stop(true);
}
