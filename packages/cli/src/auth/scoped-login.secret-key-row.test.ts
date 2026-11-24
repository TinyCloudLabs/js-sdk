import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";

// An OpenKey scoped login whose manifest names one secret's own key on the owner's default network, with decrypt
// and key.create, passes the login verification (`verifyScopedLogin`, reached through `refreshOpenKeySession`), and
// the key grant is kept in the saved session. Before TC-3802 every such login failed OPENKEY_SCOPE_MISMATCH: a raw
// encryption grant was admitted only for the network and Share keys.

const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-scoped-secret-key-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { refreshOpenKeySession } = await import("../commands/auth.js");
const { loadManifestPermissions } = await import("../lib/permissions.js");

const host = "https://node.example.test";
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!);
const did = manager.getDID("default");
const secretsSpaceId = wasm.makeSpaceId(address, 1, "secrets");
const network = `urn:tinycloud:encryption:${ownerDid}:default`;
const keyResource = `${network}/secrets/resend_api_key`;

function manifestWith(resource: string): string {
  return `base64:${Buffer.from(JSON.stringify({
    app_id: "xyz.tinycloud.seed",
    space: "secrets",
    permissions: [
      { service: "tinycloud.kv", path: "vault/secrets/RESEND_API_KEY", actions: ["tinycloud.kv/get", "tinycloud.kv/put"], skipPrefix: true },
      { service: "tinycloud.encryption", space: "encryption", path: resource, actions: ["decrypt", "key.create"], skipPrefix: true },
    ],
  })).toString("base64")}`;
}

/** A real owner-signed session over the kv paths plus the raw encryption grants the owner approved. */
async function signedSession(rawAbilities: Record<string, string[]>) {
  const now = Date.now();
  const prepared = wasm.prepareSession({
    abilities: {
      kv: { "vault/secrets/RESEND_API_KEY": ["tinycloud.kv/get", "tinycloud.kv/put"] },
      capabilities: { "": ["tinycloud.capabilities/read"] },
    },
    rawAbilities,
    address, chainId: 1, domain: "cli.example.test", spaceId: secretsSpaceId, jwk: key,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + 3600_000).toISOString(),
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return { ...session, jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did,
    address, chainId: 1, spaceId: secretsSpaceId, ownerDid, siwe: prepared.siwe, signature };
}

beforeEach(async () => {
  await ProfileManager.ensureConfigDir();
  await ProfileManager.setKey("scoped", key);
  await ProfileManager.setProfile("scoped", { name: "scoped", host, did, sessionDid: did, chainId: 1, spaceName: "default", createdAt: new Date().toISOString() });
  await ProfileManager.clearSession("scoped");
});
afterAll(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

test("a manifest row for secrets/resend_api_key on the default network, with decrypt and key.create, survives the scoped login", async () => {
  const permissions = await loadManifestPermissions(manifestWith(keyResource), "scoped", { allowLogicalSpaces: true, ownerDid });
  const requestedKey = permissions.find((entry) => entry.service === "tinycloud.encryption")!;
  expect(requestedKey).toMatchObject({ path: keyResource });
  expect([...requestedKey.actions].sort()).toEqual(["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"]);

  const approved = await refreshOpenKeySession("scoped", host, {
    permissions,
    openKeyAcquisition: async () => signedSession({ [keyResource]: ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"] }),
  });

  expect(approved.declined).toEqual([]);
  const saved = await ProfileManager.getSession("scoped") as { permissions: PermissionEntry[] };
  // The saved session lists one entry per action.
  const kept = saved.permissions.filter((entry) => entry.service === "tinycloud.encryption" && entry.path === keyResource)
    .flatMap((entry) => entry.actions);
  expect([...kept].sort()).toEqual(["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"]);
});

test("the same login signed for the whole secrets/ prefix instead of the one key is refused and saves nothing", async () => {
  const permissions = await loadManifestPermissions(manifestWith(keyResource), "scoped", { allowLogicalSpaces: true, ownerDid });
  await expect(refreshOpenKeySession("scoped", host, {
    permissions,
    openKeyAcquisition: async () => signedSession({ [`${network}/secrets/`]: ["tinycloud.encryption/decrypt"] }),
  })).rejects.toMatchObject({ code: "OPENKEY_SCOPE_MISMATCH" });
  expect(await ProfileManager.getSession("scoped")).toBeNull();
});
