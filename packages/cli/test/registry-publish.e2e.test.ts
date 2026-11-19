import "../../operations/test-support/test-bootstrap.mjs";
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import { verifyLocationRecordV2, type LocationRecordV2 } from "../../sdk-core/src/location";

// Synthetic fixture key, never a loaded owner/profile/key-file value.
const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("the built publication command distinguishes a write from a no-op without another PUT or a false change marker", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc2657-noop-"));
  const account = privateKeyToAccount(PRIVATE_KEY);
  const subject = `did:pkh:eip155:1:${account.address}`;
  const nodeDid = `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...ed25519.getPublicKey(new Uint8Array(32).fill(7))))}`;
  let record: LocationRecordV2 | null = null;
  let writes = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/info") return Response.json({ nodeId: nodeDid });
    if (path === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid });
    if (path !== `/v2/locations/${account.address}`) return new Response(null, { status: 400 });
    if (request.method === "GET") return record ? Response.json({ record })
      : Response.json({ error: "location record not found" }, { status: 404 });
    if (request.method !== "PUT") return new Response(null, { status: 405 });
    const proposed = await request.json() as LocationRecordV2;
    if (!(await verifyLocationRecordV2(proposed))) return new Response(null, { status: 401 });
    if (record && proposed.sequence <= record.sequence) return new Response(null, { status: 409 });
    record = proposed;
    writes++;
    return Response.json({ record, status: "created" }, { status: 201 });
  } });
  try {
    const directory = join(home, ".tinycloud", "profiles", "owner");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "profile.json"), JSON.stringify({ name: "owner", host: server.url.origin,
      chainId: 1, spaceName: "default", did: subject, ownerDid: subject, address: account.address,
      privateKey: PRIVATE_KEY, authMethod: "local", posture: "local-owner-key", createdAt: new Date().toISOString(),
      tinycloudRegistryUrl: server.url.origin,
    }), { mode: 0o600 });
    const guard = join(home, "owned-fetch.mjs");
    const bootstrap = resolve(import.meta.dir, "../../operations/test-support/test-bootstrap.mjs");
    await writeFile(guard, `import ${JSON.stringify(bootstrap)};\nconst origin=${JSON.stringify(server.url.origin)};const native=fetch.bind(globalThis);globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin!==origin)throw Error('Fixture refuses external fetch');return native(input,init);};\n`, { mode: 0o600 });
    const invoke = async () => {
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(TC_|TINYCLOUD|NODE_OPTIONS|NODE_EXTRA_CA_CERTS)/.test(name)));
      const child = spawn("node", ["--import", guard, resolve(import.meta.dir, "../dist/index.js"), "--profile", "owner", "--json",
        "registry", "publish", "secrets", "--server", server.url.origin, "--yes"], {
        env: { ...inherited, HOME: home, TC_HOME: home, NODE_ENV: "test", TC_REGISTRY_URL: server.url.origin },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      child.stdout.on("data", (bytes) => stdout.push(bytes));
      child.stderr.on("data", (bytes) => stderr.push(bytes));
      const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      expect(exitCode).toBe(0);
      return { result: JSON.parse(Buffer.concat(stdout).toString()), preview: Buffer.concat(stderr).toString() };
    };
    const first = await invoke();
    expect(first.result.changed).toBe(true);
    expect(writes).toBe(1);
    expect(first.preview).toContain("*");
    const second = await invoke();
    expect(second.result.changed).toBe(false);
    expect(second.result.published).toBe(true);
    expect(second.result.record).toEqual(first.result.record);
    expect(writes).toBe(1);
    expect(second.preview).not.toContain("*");
    expect(second.preview.split(second.result.disclosure).length - 1).toBe(1);
  } finally {
    await server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);
