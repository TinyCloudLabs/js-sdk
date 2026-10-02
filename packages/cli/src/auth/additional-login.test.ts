import { afterAll, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";

const home = await mkdtemp(join(tmpdir(), "tc-additional-login-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { loadAdditionalDelegations } = await import("../lib/permissions.js");
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const owner = `did:pkh:eip155:1:${address}`;
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!);
const sessionDid = manager.getDID("default");
const host = "https://node.example.test";
const profileDir = join(home, ".tinycloud", "profiles", "additional");
const permissionsPath = join(home, "permissions.json");
const cliPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const scope = (space = "applications", path = "measurements/") => ({ service: "tinycloud.kv", space, path, actions: ["tinycloud.kv/get"] });

async function proof(space = "applications", path = "measurements/", expired = false) {
  const prepared = wasm.prepareSession({
    abilities: { kv: { [path]: ["tinycloud.kv/get"] } }, address, chainId: 1,
    domain: "cli.example.test", spaceId: wasm.makeSpaceId(address, 1, space), jwk: key,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expirationTime: new Date(Date.now() + (expired ? -30_000 : 3600_000)).toISOString(),
  });
  const signature = await signer.signMessage(prepared.siwe);
  return { ...wasm.completeSessionSetup({ ...prepared, signature }), address, chainId: 1,
    siwe: prepared.siwe, signature, verificationMethod: sessionDid, hostActivated: true };
}

function login(response: object, args: string[] = []) {
  const child = spawnSync(process.execPath, [cliPath, "--quiet", "--json", "--profile", "additional", "auth", "login",
    "--method", "openkey", "--paste", "--additional", "--permissions", permissionsPath, ...args], {
    env: { ...process.env, TC_HOME: home }, input: JSON.stringify(response) + "\n", encoding: "utf8", timeout: 15_000,
  });
  // Never print raw output: transport stderr contains the generated approval URL.
  let result: any;
  for (const output of [child.stdout, child.stderr]) {
    const start = output.search(/\{\s*"(?:error|authenticated)"\s*:/);
    if (start >= 0) try { result = JSON.parse(output.slice(start)); } catch { /* Ignore transport text. */ }
  }
  result ??= { error: { code: "NO_JSON_RECEIPT" } };
  return { exit: child.status, result };
}

async function primaryBytes() {
  return Promise.all(["profile.json", "session.json", "key.json"].map(file => readFile(join(profileDir, file), "utf8")));
}

beforeEach(async () => {
  await rm(profileDir, { recursive: true, force: true });
  await ProfileManager.ensureConfigDir();
  await ProfileManager.setKey("additional", key);
  const base = await proof("account", "applications/");
  await ProfileManager.setProfile("additional", { name: "additional", host, did: sessionDid, sessionDid,
    ownerDid: owner, spaceId: base.spaceId, chainId: 1, spaceName: "account", authMethod: "openkey",
    createdAt: new Date().toISOString() });
  await ProfileManager.setSession("additional", { ...base, jwk: key });
  await writeFile(permissionsPath, JSON.stringify([scope()]), { mode: 0o600 });
});
afterAll(() => rm(home, { recursive: true, force: true }));

test("single-space additional paste retains the primary session and replays proof in a fresh process", async () => {
  const before = await primaryBytes();
  const receipt = login(await proof());
  expect(receipt).toMatchObject({ exit: 0, result: { authenticated: true, additional: true } });
  expect(await primaryBytes()).toEqual(before);
  const entries = await loadAdditionalDelegations("additional");
  expect(entries).toHaveLength(1);
  expect(entries[0]!.sessionProof).toBeDefined();

  const scriptPath = join(home, "restore.mjs");
  await writeFile(scriptPath, `
    import { ProfileManager } from ${JSON.stringify(new URL("../config/profiles.ts", import.meta.url).href)};
    import { loadAdditionalDelegations } from ${JSON.stringify(new URL("../lib/permissions.ts", import.meta.url).href)};
    import { activateStoredRuntimeDelegation } from ${JSON.stringify(new URL("../../../operations/src/delegations.ts", import.meta.url).href)};
    const profile = await ProfileManager.getProfile('additional');
    const entries = await loadAdditionalDelegations('additional');
    let activated = 0;
    const node = { did: profile.ownerDid, sessionDid: profile.sessionDid, useRuntimeDelegation: async () => { activated++; } };
    for (const entry of entries) await activateStoredRuntimeDelegation(node, { ...entry, delegation: { ...entry.delegation, expiry: new Date(entry.delegation.expiry) } }, { host: profile.host, jwk: await ProfileManager.getKey('additional') });
    console.log(JSON.stringify({ activated, primarySpace: (await ProfileManager.getSession('additional')).spaceId }));
  `, { mode: 0o600 });
  const replay = spawnSync(process.execPath, [scriptPath], { env: { ...process.env, TC_HOME: home }, encoding: "utf8", timeout: 15_000 });
  expect(replay.status).toBe(0);
  expect(JSON.parse(replay.stdout)).toEqual({ activated: 1, primarySpace: wasm.makeSpaceId(address, 1, "account") });
});

test("additional paste retains previous grants and duplicate imports do not append twice", async () => {
  const first = await proof();
  expect(login(first).exit).toBe(0);
  expect(login(first).exit).toBe(0);
  await writeFile(permissionsPath, JSON.stringify([scope("applications", "other/")]));
  expect(login(await proof("applications", "other/")).exit).toBe(0);
  expect(await loadAdditionalDelegations("additional")).toHaveLength(2);
});

test.each([
  ["expired", "AUTH_EXPIRED"],
  ["owner", "OPENKEY_OWNER_MISMATCH"],
  ["scope", "OPENKEY_SCOPE_MISMATCH"],
  ["key", "OPENKEY_PROOF_INVALID"],
] as const)("additional paste rejects %s without changing saved authority", async (kind, code) => {
  const before = await primaryBytes();
  const response = await proof(kind === "scope" ? "other" : "applications", "measurements/", kind === "expired");
  if (kind === "key") response.verificationMethod = "did:key:zWrongKey";
  const args = kind === "owner" ? ["--owner", "did:pkh:eip155:1:0x1111111111111111111111111111111111111111"] : [];
  expect(login(response, args).result).toMatchObject({ error: { code } });
  expect(await primaryBytes()).toEqual(before);
  expect(await loadAdditionalDelegations("additional")).toHaveLength(0);
});

test("additional paste requires an existing primary session", async () => {
  await ProfileManager.clearSession("additional");
  expect(login(await proof()).result).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  expect(await ProfileManager.getSession("additional")).toBeNull();
});

test("additional paste requires proof for every requested permission space", async () => {
  await writeFile(permissionsPath, JSON.stringify([scope(), scope("account")]));
  expect(login(await proof()).result).toMatchObject({ error: { code: "OPENKEY_SCOPE_INCOMPLETE" } });
});
