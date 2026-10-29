import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";

// builtin:share-publishing asks a paste sign-in for the owner's default/share/ decrypt prefix.
// OpenKey's device sign-in refuses encryption grants, so --device and `enable share` request the same manifest without it.
const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-device-decrypt-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { acquireDeviceDelegation } = await import("./device-auth.js");
const { verifyScopedLogin } = await import("./scoped-login.js");
const { keyToDID } = await import("./local-key.js");
const { sharePublishingPermissions } = await import("../share/publishing-manifest.js");
const { loadManifestPermissions } = await import("../lib/permissions.js");

const NODE = "https://tee.node.tinycloud.xyz";
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const network = `urn:tinycloud:encryption:${ownerDid}:default`;
const sharePrefix = `${network}/share/`;
const spaceId = wasm.makeSpaceId(address, 1, "default");
const key = JSON.parse(wasm.createSessionManager().jwk("default")!) as Record<string, string>;
const sessionDid = keyToDID(key);
const DECRYPT = "tinycloud.encryption/decrypt";
const wire: PermissionEntry = { service: "tinycloud.encryption", space: "default", path: "", actions: [DECRYPT] };

afterAll(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

async function setUpProfile() {
  await ProfileManager.setKey("default", key);
  await ProfileManager.setProfile("default", { name: "default", host: NODE, chainId: 1, spaceName: "default", did: sessionDid, createdAt: "2026-10-01T00:00:00.000Z" });
}

describe("share publishing and the default-key decrypt", () => {
  test("a paste sign-in requests the share prefix without root decrypt", async () => {
    await setUpProfile();
    const loaded = await loadManifestPermissions("builtin:share-publishing", "default", { allowLogicalSpaces: true, ownerDid });
    expect(loaded.filter((permission) => permission.service === "tinycloud.encryption")).toEqual([
      { service: "tinycloud.encryption", space: "encryption", path: sharePrefix, actions: [DECRYPT] },
    ]);
  });

  test("a paste sign-in that cannot name its owner fails with OWNER_DID_UNKNOWN and says to pass --owner", async () => {
    await setUpProfile();
    await expect(loadManifestPermissions("builtin:share-publishing", "default", { allowLogicalSpaces: true }))
      .rejects.toMatchObject({ code: "OWNER_DID_UNKNOWN", message: expect.stringContaining("--owner") });
  });

  test("a device sign-in requests builtin:share-publishing without decrypt, and so does enable share", async () => {
    await setUpProfile();
    const loaded = await loadManifestPermissions("builtin:share-publishing", "default", { allowLogicalSpaces: true, device: true });
    expect(loaded.some((permission) => permission.service === "tinycloud.encryption")).toBe(false);
    expect(loaded.length).toBeGreaterThan(0);
    expect(sharePublishingPermissions().some((permission) => permission.service === "tinycloud.encryption")).toBe(false);
  });

  test("device sign-in still refuses every encryption entry before contacting OpenKey", async () => {
    let contacted = 0;
    const fetchFn = (async () => { contacted += 1; return new Response(null, { status: 500 }); }) as unknown as typeof globalThis.fetch;
    for (const entry of [wire, { service: "tinycloud.encryption", space: "encryption", path: network, actions: [DECRYPT] },
      { service: "tinycloud.encryption", space: "encryption", path: sharePrefix, actions: [DECRYPT] }] as PermissionEntry[]) {
      await expect(acquireDeviceDelegation({
        sessionDid, jwk: key, nodeOrigin: NODE, shareOrigin: "https://share.tinycloud.xyz",
        permissions: [...sharePublishingPermissions(), entry], fetchFn, emitInstructions: () => undefined, wait: async () => undefined,
      })).rejects.toMatchObject({ exitCode: 2 });
    }
    expect(contacted).toBe(0);
  });

  test("a session signed as OpenKey signs it verifies against the paste request", async () => {
    await setUpProfile();
    const requested = await loadManifestPermissions("builtin:share-publishing", "default", { allowLogicalSpaces: true, ownerDid });
    const abilities: Record<string, Record<string, string[]>> = {};
    for (const permission of requested) {
      if (permission.service !== "tinycloud.encryption") (abilities[permission.service.slice("tinycloud.".length)] ??= {})[permission.path] = permission.actions;
    }
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000).toISOString();
    const prepared = wasm.prepareSession({
      abilities, rawAbilities: { [sharePrefix]: [DECRYPT] }, address, chainId: 1, domain: "openkey.so", spaceId, jwk: key,
      issuedAt: new Date(Date.now() - 60_000).toISOString(), expirationTime: expiresAt,
    });
    const signature = await signer.signMessage(prepared.siwe);
    const delegation = {
      ...wasm.completeSessionSetup({ ...prepared, signature }),
      jwk: key, verificationMethod: sessionDid, address, chainId: 1, spaceId, ownerDid, siwe: prepared.siwe, signature, expiresAt, hostActivated: true,
    };
    const { session } = verifyScopedLogin(delegation, key, sessionDid, requested, { expectedOwner: ownerDid });
    expect(session.permissions.filter((permission) => permission.service === "tinycloud.encryption")).toEqual([
      { service: "tinycloud.encryption", space: "encryption", path: sharePrefix, actions: [DECRYPT] },
    ]);
  });

});
