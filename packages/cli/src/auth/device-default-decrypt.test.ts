import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";

// builtin:share-publishing asks a paste sign-in for the owner's default-key decrypt (email-addressed shares need it).
// OpenKey's device sign-in refuses encryption grants, so --device and `enable share` request the same manifest without it.
const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-device-decrypt-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { acquireDeviceDelegation } = await import("./device-auth.js");
const { keyToDID } = await import("./local-key.js");
const { sharePublishingPermissions } = await import("../share/publishing-manifest.js");
const { loadManifestPermissions } = await import("../lib/permissions.js");
const { shareCliError } = await import("../commands/share.js");
const { SharePublishAuthorityError } = await import("../share/errors.js");

const NODE = "https://tee.node.tinycloud.xyz";
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const network = `urn:tinycloud:encryption:${ownerDid}:default`;
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
  test("a paste sign-in requests the decrypt entry as space default with an empty path", async () => {
    await setUpProfile();
    const loaded = await loadManifestPermissions("builtin:share-publishing", "default", { allowLogicalSpaces: true });
    expect(loaded.filter((permission) => permission.service === "tinycloud.encryption")).toEqual([wire]);
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
    for (const entry of [wire, { service: "tinycloud.encryption", space: "encryption", path: network, actions: [DECRYPT] }] as PermissionEntry[]) {
      await expect(acquireDeviceDelegation({
        sessionDid, jwk: key, nodeOrigin: NODE, shareOrigin: "https://share.tinycloud.xyz",
        permissions: [...sharePublishingPermissions(), entry], fetchFn, emitInstructions: () => undefined, wait: async () => undefined,
      })).rejects.toMatchObject({ exitCode: 2 });
    }
    expect(contacted).toBe(0);
  });

  test("an email share from a sign-in without decrypt is one plain line pointing at the paste sign-in", () => {
    const refusal = shareCliError(new SharePublishAuthorityError({ kind: "decrypt-not-held" }));
    expect(refusal.message).toBe("Email shares need a paste sign-in: run tc auth login --paste --manifest builtin:share-publishing");
    expect(refusal.message).not.toContain("\n");
  });
});
