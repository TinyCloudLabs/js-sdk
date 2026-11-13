import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
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
  const node = new TinyCloudNode({ host: "http://127.0.0.1:1", tinycloudRegistryUrl: registry.url.origin,
    autoDiscoverLocalNode: false, wasmBindings: wasm });
  async function restore(offset = 0, target = node) {
    const expiresAt = new Date(Date.now() + 3600_000 + offset).toISOString();
    const prepared = wasm.prepareSession({ address, chainId, domain: "thirdparty.example", jwk, spaceId,
      issuedAt: new Date().toISOString(), expirationTime: expiresAt,
      abilities: { kv: { "app/": ["tinycloud.kv/get", "tinycloud.kv/put"] } } });
    const signature = await signer.signMessage(prepared.siwe);
    const completed = wasm.completeSessionSetup({ ...prepared, signature });
    await target.restoreSession({ ...completed, jwk, address, chainId, spaceId,
      siwe: prepared.siwe, signature, expiresAt });
  }
  await restore();
  let activations = 0;
  Reflect.set(node, "activateResourceSession", async () => { activations++; return { success: true, status: 200 }; });
  let capture: Parameters<Parameters<NewShareApprovalClient["beginShareApproval"]>[1]["verify"]>[0];
  const client: NewShareApprovalClient = { beginShareApproval(intent, { verify }) {
    const shareId = randomBytes(16).toString("hex");
    const resource = `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default/share/${shareId}`;
    return { cancel() {}, authorize: async () => {
      const prepared = wasm.prepareSession({ address, chainId, nonce: intent.approvalNonce, domain: "thirdparty.example", jwk: intent.session.publicJwk,
        spaceId, issuedAt: new Date().toISOString(), expirationTime: intent.expiresAt, abilities: {},
        rawAbilities: { [resource]: ["tinycloud.encryption/decrypt"] } });
      const result = { purpose: "share-create" as const, requestId: randomBytes(32).toString("base64url"), shareId,
        ownerDid: `did:pkh:eip155:1:${address}`, sessionDid: node.sessionDid, origin: "https://thirdparty.example",
        prepared, signature: await signer.signMessage(prepared.siwe) };
      const identity = { ...result, expiresAt: Date.now() + 60_000 };
      capture = { result, identity, origin: result.origin };
      expect(await verify(capture)).toBe(true);
      return result;
    } };
  } };
  const replay: NewShareApprovalClient = { beginShareApproval(_intent, { verify }) {
    return { cancel() {}, authorize: async () => { expect(await verify(capture)).toBe(true); return capture.result; } };
  } };
  const options = { expiresAt: new Date(Date.now() + 1800_000) };
  return { node, registry, restore, client, replay, options, activations: () => activations, wasm,
    async newInstance() {
      const other = new TinyCloudNode({ host: "http://127.0.0.1:1", tinycloudRegistryUrl: registry.url.origin,
        autoDiscoverLocalNode: false, wasmBindings: wasm });
      await restore(0, other);
      Reflect.set(other, "activateResourceSession", async () => { activations++; return { success: true, status: 200 }; });
      return other;
    },
  };
}

test("a consumed approval must not be accepted twice", async () => {
  const f = await fixture();
  try {
    await f.node.approveNewShare(f.client, f.options, "https://thirdparty.example");
    expect(await f.node.approveNewShare(f.replay, f.options, "https://thirdparty.example").then(() => true, () => false)).toBe(false);
  } finally { f.registry.stop(true); }
});

test("old approval must not activate after same-key base CID and expiry replacement", async () => {
  const f = await fixture();
  try {
    await f.node.approveNewShare(f.client, f.options, "https://thirdparty.example");
    const before = f.node.restorableSession!;
    await f.restore(600_000);
    expect(f.node.restorableSession!.delegationCid).not.toBe(before.delegationCid);
    expect(f.node.restorableSession!.verificationMethod).toBe(before.verificationMethod);
    expect(f.node.getRuntimePermissionDelegations()).toEqual([]);
    const count = f.activations();
    expect(await f.node.approveNewShare(f.replay, f.options, "https://thirdparty.example").then(() => true, () => false)).toBe(false);
    expect(f.activations()).toBe(count);
  } finally { f.registry.stop(true); }
});

test("stale minted path cannot use runtime expansion after base CID replacement", async () => {
  const f = await fixture();
  try {
    const approved = await f.node.approveNewShare(f.client, f.options, "https://thirdparty.example");
    await f.restore(600_000);
    expect(() => f.node.hasRuntimePermissions(approved.registrationPermissions)).toThrow("manifest.keys");
    expect(() => f.node.getRuntimePermissionDelegations(approved.registrationPermissions)).toThrow("manifest.keys");
  } finally { f.registry.stop(true); }
});

test("minted path does not authorize descendants or sibling share ids", async () => {
  const f = await fixture();
  try {
    const approved = await f.node.approveNewShare(f.client, f.options, "https://thirdparty.example");
    const entry = approved.registrationPermissions[0]!;
    for (const path of [entry.path + "/child", entry.path + "a", entry.path.replace(approved.shareId, "0".repeat(32))]) {
      const expand = Reflect.get(f.node, "expandPermissionEntries") as (entries: typeof approved.registrationPermissions) => typeof approved.registrationPermissions;
      expect(() => expand.call(f.node, [{ ...entry, path }])).toThrow();
      expect(() => f.node.hasRuntimePermissions([{ ...entry, path }])).toThrow();
      expect(() => f.node.getRuntimePermissionDelegations([{ ...entry, path }])).toThrow();
    }
    const prefix = [{ ...entry, path: entry.path.split("/share/")[0] + "/share/" }];
    expect(f.node.hasRuntimePermissions(prefix)).toBe(false);
    expect(f.node.getRuntimePermissionDelegations(prefix)).toEqual([]);
    expect(f.node.hasRuntimePermissions(approved.registrationPermissions)).toBe(true);
  } finally { f.registry.stop(true); }
});

test("missing WASM verifiers refuse before activation", async () => {
  const f = await fixture();
  try {
    Reflect.set(f.wasm, "validateSessionGrant", undefined);
    Reflect.set(f.wasm, "validatePersistedSession", undefined);
    await expect(f.node.approveNewShare(f.client, f.options, "https://thirdparty.example")).rejects.toThrow();
    expect(f.activations()).toBe(0);
  } finally { f.registry.stop(true); }
});

test("same-key session replacement while approval is pending cannot activate", async () => {
  const f = await fixture();
  try {
    const swap: NewShareApprovalClient = { beginShareApproval(intent, options) {
      const handle = f.client.beginShareApproval(intent, options);
      return { cancel: handle.cancel, authorize: async () => {
        const result = await handle.authorize();
        await f.restore(600_000);
        return result;
      } };
    } };
    expect(await f.node.approveNewShare(swap, f.options, "https://thirdparty.example").then(() => true, () => false)).toBe(false);
    expect(f.activations()).toBe(0);
    expect(f.node.getRuntimePermissionDelegations()).toEqual([]);
  } finally { f.registry.stop(true); }
});

test("minted runtime authority expires and does not survive sign-out", async () => {
  const f = await fixture();
  const clock = Date.now;
  try {
    const approved = await f.node.approveNewShare(f.client, f.options, "https://thirdparty.example");
    Date.now = () => approved.delegation.expiry.getTime() + 1;
    expect(f.node.getRuntimePermissionDelegations()).toEqual([]);
    expect(() => f.node.hasRuntimePermissions(approved.registrationPermissions)).toThrow("manifest.keys");
    Date.now = clock;
    await f.node.signOut();
    expect(f.node.hasRuntimePermissions(approved.registrationPermissions)).toBe(false);
    expect(f.node.getRuntimePermissionDelegations()).toEqual([]);
  } finally { Date.now = clock; f.registry.stop(true); }
});


test("an earlier result is refused by a new SDK instance using the same session key", async () => {
  const f = await fixture();
  try {
    await f.node.approveNewShare(f.client, f.options, "https://thirdparty.example");
    const other = await f.newInstance();
    expect(other.sessionDid).toBe(f.node.sessionDid);
    const before = f.activations();
    await expect(other.approveNewShare(f.replay, f.options, "https://thirdparty.example")).rejects.toThrow();
    expect(f.activations()).toBe(before);
  } finally { f.registry.stop(true); }
});

test("one pending call refuses its second verification delivery", async () => {
  const f = await fixture();
  try {
    const twice: NewShareApprovalClient = { beginShareApproval(intent, options) {
      return f.client.beginShareApproval(intent, { verify: async input => {
        expect(await options.verify(input)).toBe(true);
        await expect(options.verify(input)).rejects.toThrow("already consumed");
        return true;
      } });
    } };
    await f.node.approveNewShare(twice, f.options, "https://thirdparty.example");
    expect(f.activations()).toBe(1);
  } finally { f.registry.stop(true); }
});
