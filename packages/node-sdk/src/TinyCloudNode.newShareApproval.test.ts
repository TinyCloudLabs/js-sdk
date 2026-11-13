import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { expandPermissionEntries } from "@tinycloud/sdk-core";
import { TinyCloudNode, type NewShareApprovalClient } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { startUnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

async function fixture() {
  const registry = startUnregisteredLocationRegistry();
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default")!);
  const signer = new PrivateKeySigner("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  const address = await signer.getAddress();
  const chainId = 1;
  const spaceId = wasm.makeSpaceId(address, chainId, "applications");
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const prepared = wasm.prepareSession({ address, chainId, domain: "thirdparty.example", jwk, spaceId,
    issuedAt: new Date().toISOString(), expirationTime: expiresAt,
    abilities: { kv: { "app/": ["tinycloud.kv/get", "tinycloud.kv/put"] } } });
  const signature = await signer.signMessage(prepared.siwe);
  const completed = wasm.completeSessionSetup({ ...prepared, signature });
  const node = new TinyCloudNode({ host: "http://127.0.0.1:1", tinycloudRegistryUrl: registry.url.origin,
    autoDiscoverLocalNode: false, wasmBindings: wasm });
  await node.restoreSession({ ...completed, jwk, address, chainId, spaceId,
    siwe: prepared.siwe, signature, expiresAt });
  // Activation is an explicit fixture collaborator; real WASM proof verification and runtime expansion run unchanged.
  (node as any).activateResourceSession = async () => ({ success: true, status: 200 });
  let began = false;
  const client: NewShareApprovalClient = { beginShareApproval(intent, { verify }) {
    began = true;
    expect(intent.session.publicJwk).not.toHaveProperty("d");
    const shareId = randomBytes(16).toString("hex");
    const resource = `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default/share/${shareId}`;
    return { cancel() {}, authorize: async () => {
      const approval = wasm.prepareSession({ address, chainId, domain: "thirdparty.example", jwk: intent.session.publicJwk,
        spaceId, issuedAt: new Date().toISOString(), expirationTime: intent.expiresAt, abilities: {},
        rawAbilities: { [resource]: ["tinycloud.encryption/decrypt"],
          ...Object.fromEntries(intent.permissions.map(entry => [`${wasm.makeSpaceId(address, chainId, entry.space)}/kv/${entry.path}`, entry.actions])) } });
      const result = { purpose: "share-create" as const, requestId: randomBytes(32).toString("base64url"), shareId,
        ownerDid: `did:pkh:eip155:1:${address}`, sessionDid: node.sessionDid, origin: "https://thirdparty.example",
        prepared: approval, signature: await signer.signMessage(approval.siwe) };
      const accepted = await verify({ result, origin: result.origin, identity: { ...result, expiresAt: Date.now() + 60_000 } });
      expect(accepted).toBe(true);
      return result;
    } };
  } };
  return { node, client, registry, began: () => began };
}

test("provider-less signed restore activates only its OpenKey-minted exact share through real runtime expansion", async () => {
  const f = await fixture();
  try {
    expect(f.node.isSessionOnly).toBe(true);
    const pending = f.node.approveNewShare(f.client, { expiresAt: new Date(Date.now() + 1800_000), permissions: [{
      service: "tinycloud.kv", space: "applications", path: "app/shares/file.json", actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    }] }, "https://thirdparty.example");
    expect(f.began()).toBe(true);
    const result = await pending;
    expect(f.node.hasRuntimePermissions(result.registrationPermissions)).toBe(true);
    expect(result.encryptionNetwork).toBe(result.registrationPermissions[0]!.path.split("/share/")[0]);
    expect(result.delegation.resources?.some(entry => entry.path === "app/shares/file.json" && entry.actions.includes("tinycloud.kv/metadata"))).toBe(true);
    expect(f.node.getRuntimePermissionDelegations(result.registrationPermissions).map(grant => grant.cid)).toEqual([result.delegation.cid]);
    const entry = result.registrationPermissions[0]!;
    expect(() => expandPermissionEntries([entry])).toThrow("manifest.keys");
    expect(() => f.node.hasRuntimePermissions([{ ...entry, path: entry.path.replace(result.shareId, "0".repeat(32)) }])).toThrow("manifest.keys");
    expect(() => f.node.hasRuntimePermissions([{ ...entry, actions: ["tinycloud.encryption/key.create"] }])).toThrow();
  } finally { f.registry.stop(true); }
});

test("an adapter cannot install a result without the required verifier", async () => {
  const f = await fixture();
  try {
    let preparedResult: any;
    const intercepted: NewShareApprovalClient = { beginShareApproval(intent) {
      return f.client.beginShareApproval(intent, { verify: async ({ result }) => { preparedResult = result; return true; } });
    } };
    await expect(f.node.approveNewShare(intercepted, { expiresAt: new Date(Date.now() + 1800_000) },
      "https://thirdparty.example")).rejects.toThrow("Share approval changed");
    expect(f.node.getRuntimePermissionDelegations()).toHaveLength(0);
    expect(() => f.node.hasRuntimePermissions([{ service: "tinycloud.encryption",
      path: `urn:tinycloud:encryption:${preparedResult.ownerDid}:default/share/${preparedResult.shareId}`,
      actions: ["tinycloud.encryption/decrypt"] }])).toThrow("manifest.keys");
  } finally { f.registry.stop(true); }
});

test("sign-out while the approval is pending cannot activate its result", async () => {
  const f = await fixture();
  try {
    const intercepted: NewShareApprovalClient = { beginShareApproval(intent, options) {
      const handle = f.client.beginShareApproval(intent, options);
      return { cancel: handle.cancel, authorize: async () => {
        const result = await handle.authorize();
        void f.node.signOut();
        return result;
      } };
    } };
    await expect(f.node.approveNewShare(intercepted, { expiresAt: new Date(Date.now() + 1800_000) },
      "https://thirdparty.example")).rejects.toThrow();
    expect(f.node.getRuntimePermissionDelegations()).toHaveLength(0);
  } finally { f.registry.stop(true); }
});
