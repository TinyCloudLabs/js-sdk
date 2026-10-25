import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PrivateKeySigner } from "@tinycloud/node-sdk";
import { extractRecapAttenuations } from "@tinycloud/sdk-core";
import { profileConfigPath, sessionPath, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";

const PROFILE = "keys";
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";
const KEY_CREATE = "tinycloud.encryption/key.create";
const DECRYPT = "tinycloud.encryption/decrypt";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function run(home: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE, ...args], {
    env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function setup(features: string[]) {
  const home = await mkdtemp("/var/tmp/tc2034-keys-");
  homes.push(home);
  const requests: string[] = [];
  const node = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features });
      if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
      return new Response(`Unsupported stub node request: ${request.method} ${path}`, { status: 404 });
    },
  });
  servers.push(node);
  const address = await new PrivateKeySigner(OWNER_KEY).getAddress();
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const sessionFile = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: ownerDid,
      ownerDid, privateKey: OWNER_KEY, authMethod: "local", posture: "local-owner-key",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    return sessionPath(PROFILE);
  });
  const readProfile = () => withTinyCloudStateRoot(home, async () =>
    JSON.parse(await readFile(profileConfigPath(PROFILE), "utf8")) as Record<string, unknown>);
  return { home, requests, address, ownerDid, sessionFile, readProfile };
}

async function recapOf(sessionFile: string): Promise<Record<string, Record<string, unknown>>> {
  const session = JSON.parse(await readFile(sessionFile, "utf8"));
  return extractRecapAttenuations(session.siwe) as Record<string, Record<string, unknown>>;
}

const exists = (path: string) => access(path).then(() => true, () => false);

test("--keys adds exactly the two abilities on the exact prefix URN and changes nothing else in the ReCap", async () => {
  const plain = await setup(["encryption-named-keys-v1"]);
  const plainLogin = await run(plain.home, ["auth", "login", "--method", "local"]);
  expect(plainLogin.exitCode, plainLogin.stderr).toBe(0);
  const base = await recapOf(plain.sessionFile);

  const keyed = await setup(["encryption-named-keys-v1"]);
  const login = await run(keyed.home, ["auth", "login", "--method", "local", "--keys", "qa/"]);
  expect(login.exitCode, login.stderr).toBe(0);
  const withKeys = await recapOf(keyed.sessionFile);

  const resource = `urn:tinycloud:encryption:${keyed.ownerDid}:default/qa/`;
  expect(keyed.address).toBe(plain.address);
  const added = Object.keys(withKeys).filter((key) => !(key in base));
  expect(added).toEqual([resource]);
  expect(Object.keys(withKeys[resource]!).sort()).toEqual([DECRYPT, KEY_CREATE].sort());
  const { [resource]: _granted, ...rest } = withKeys;
  expect(rest).toEqual(base);
  expect((await keyed.readProfile()).namedKeys).toEqual({ prefix: "qa", resource });
});

test("a later login without --keys records no key prefix", async () => {
  const t = await setup(["encryption-named-keys-v1"]);
  expect((await run(t.home, ["auth", "login", "--method", "local", "--keys", "qa"])).exitCode).toBe(0);
  expect((await t.readProfile()).namedKeys).toBeDefined();
  expect((await run(t.home, ["auth", "login", "--method", "local"])).exitCode).toBe(0);
  expect((await t.readProfile()).namedKeys).toBeUndefined();
  const recap = await recapOf(t.sessionFile);
  expect(Object.keys(recap).some((key) => key.startsWith("urn:tinycloud:encryption:") && key.includes("/"))).toBe(false);
});

test("--keys against a node without encryption-named-keys-v1 is refused before signing and stores nothing", async () => {
  const t = await setup(["sql"]);
  const login = await run(t.home, ["auth", "login", "--method", "local", "--keys", "qa/"]);
  expect(login.exitCode).toBe(7);
  expect(login.stderr + login.stdout).toContain("doesn't support named keys");
  expect(t.requests).toEqual(["GET /info"]);
  expect(await exists(t.sessionFile)).toBe(false);
  expect((await t.readProfile()).namedKeys).toBeUndefined();
});

test.each([
  ["empty", "/"],
  ["app prefix", "apps/tinychat/"],
  ["bare apps", "apps"],
  ["double slash", "a//b/"],
  ["uppercase", "QA/"],
  ["too deep", "a/b/c/d/e/f/g/h/i/"],
  ["too long", `${"a".repeat(256)}/`],
])("--keys with an invalid prefix (%s) is refused before any node request or signature", async (_name, prefix) => {
  const t = await setup(["encryption-named-keys-v1"]);
  const login = await run(t.home, ["auth", "login", "--method", "local", "--keys", prefix]);
  expect(login.exitCode).toBe(2);
  expect(t.requests).toEqual([]);
  expect(await exists(t.sessionFile)).toBe(false);
});
