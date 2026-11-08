import { expect, spyOn, test } from "bun:test";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";
import { activateValidatedRuntimeDelegation, siweRuntimeDelegation, type PortableDelegation } from "./delegation";

const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const wasm = new NodeWasmBindings();
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!);
const did = manager.getDID("default");
const space = (name: string) => wasm.makeSpaceId(address, 1, name);
const host = "https://session-grant.test";
async function fixture(foreign = false) {
  const primary = space("applications");
  const secondary = foreign ? wasm.makeSpaceId("0x0000000000000000000000000000000000000001", 1, "account") : space("account");
  const expiry = new Date(Date.now() + 600_000);
  const prepared = wasm.prepareSession({ address, chainId: 1, domain: "lab.test", spaceId: primary, jwk: key,
    abilities: { sql: { feed: ["tinycloud.sql/read"] } }, spaceAbilities: {
      [primary]: { sql: { feed: ["tinycloud.sql/read"] } }, [secondary]: { kv: { "spaces/": ["tinycloud.kv/list"] } },
    }, issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: expiry.toISOString() });
  const signature = await signer.signMessage(prepared.siwe);
  const session = { ...wasm.completeSessionSetup({ ...prepared, signature }), spaceId: primary, jwk: key, verificationMethod: did,
    address, chainId: 1, siwe: prepared.siwe, signature };
  const node = new TinyCloudNode({ host, wasmBindings: wasm, autoBootstrapAccount: false });
  await node.restoreSession(session);
  const grant: PortableDelegation = { cid: session.delegationCid, delegationHeader: session.delegationHeader, spaceId: primary,
    path: "feed", actions: ["tinycloud.sql/read"], resources: [
      { service: "sql", space: primary, path: "feed", actions: ["tinycloud.sql/read"] },
      { service: "kv", space: secondary, path: "spaces/", actions: ["tinycloud.kv/list"] },
    ], expiry, ownerAddress: address, chainId: 1, delegateDID: did, host, siweProof: { siwe: prepared.siwe, signature } };
  return { node, grant, primary, secondary };
}
test("validated signed-session activation preserves both resource spaces and its requested primary route", async () => {
  const { node, grant, primary, secondary } = await fixture();
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ activated: [], skipped: [] }));
  try {
    const installed = await activateValidatedRuntimeDelegation(node, grant, { host });
    expect(new Set(installed.effectivePermissions.map(p => p.space))).toEqual(new Set([primary, secondary]));
    expect(new Set(installed.delegation.resources!.map(p => p.space))).toEqual(new Set([primary, secondary]));
    expect(installed.delegation.spaceId).toBe(primary);
    const projected = siweRuntimeDelegation(node, { authorization: grant.delegationHeader.Authorization, cid: grant.cid,
      spaceId: primary, ownerAddress: address, chainId: 1, siwe: grant.siweProof!.siwe, signature: grant.siweProof!.signature, host });
    expect(projected.spaceId).toBe(primary);
    expect(new Set(projected.resources!.map(p => p.space))).toEqual(new Set([primary, secondary]));
  } finally { fetch.mockRestore(); }
});
test("signed-session activation rejects a foreign-owner secondary even when the primary is valid", async () => {
  const { node, grant } = await fixture(true);
  await expect(activateValidatedRuntimeDelegation(node, grant, { host })).rejects.toMatchObject({ reason: "authority_invalid" });
});
