import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode, type PortableDelegation } from "@tinycloud/node-sdk";
import { createAuthRuntimeFixture } from "../test-support/auth-runtime.js";
import { additionalDelegationsPath, sessionPath, writeJsonAtomic } from "./state.js";
import { createInvocationRuntime } from "./runtime.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(`${tmpdir()}/tc-cacao-replay-`); process.env.TC_HOME = home; });
afterEach(async () => { delete process.env.TC_HOME; await rm(home, { recursive: true, force: true }); });

async function fixture(caveats?: Record<string, unknown>[]) {
  const fixture = await createAuthRuntimeFixture();
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(fixture.hermetic.ownerPrivateKey);
  const address = await signer.getAddress();
  const jwk = fixture.hermetic.restorableSession.jwk as object;
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  async function proof(spaceId: string, path: string) {
    const prepared = wasm.prepareSession({ abilities: { kv: { [path]: ["tinycloud.kv/get"] } }, address, chainId: 1,
      domain: "synthetic.invalid", spaceId, jwk, issuedAt: new Date(Date.now() - 60_000).toISOString(), expirationTime: expiresAt });
    if (caveats && spaceId === fixture.hermetic.accountSpaceId) {
      prepared.siwe = prepared.siwe.replace(/urn:recap:([A-Za-z0-9_-]+)/g, (_urn: string, encoded: string) => {
        const recap = JSON.parse(Buffer.from(encoded, "base64url").toString());
        for (const abilities of Object.values(recap.att) as Record<string, unknown>[]) {
          for (const action of Object.keys(abilities)) abilities[action] = caveats;
        }
        return `urn:recap:${Buffer.from(JSON.stringify(recap)).toString("base64url")}`;
      });
    }
    const signature = await signer.signMessage(prepared.siwe);
    const completed = wasm.completeSessionSetup({ ...prepared, signature });
    return { delegationHeader: completed.delegationHeader, delegationCid: completed.delegationCid, spaceId,
      verificationMethod: fixture.sessionDid, address, chainId: 1, siwe: prepared.siwe as string, signature, expiresAt };
  }
  const base = await proof(fixture.hermetic.restorableSession.spaceId, "private/synthetic-base");
  const sessionProof = await proof(fixture.hermetic.accountSpaceId, "applications/agent-demo");
  const delegation: PortableDelegation = {
    cid: sessionProof.delegationCid, delegationHeader: sessionProof.delegationHeader,
    spaceId: sessionProof.spaceId, path: "applications/agent-demo", actions: ["tinycloud.kv/get"],
    resources: [{ service: "kv", space: sessionProof.spaceId, path: "applications/agent-demo", actions: ["tinycloud.kv/get"] }],
    expiry: new Date(expiresAt), delegateDID: fixture.sessionDid, ownerAddress: address, chainId: 1, host: fixture.hermetic.host,
  };
  await writeJsonAtomic(sessionPath(fixture.profile), { ...base, jwk });
  return { ...fixture, jwk, base, entry: { delegation, sessionProof } };
}

test.each(["omitted", "empty-branch"])("fresh runtime restores real two-space CACAO (%s caveats) and signs a narrow account read", async (caveats) => {
  const f = await fixture(caveats === "empty-branch" ? [{}] : undefined);
  const originalVerify = NodeWasmBindings.prototype.validatePersistedSession;
  // Different WASM builds expose a verified unconstrained branch as either
  // [] or [Map()]. Preserve the real cryptographic verifier in this variant.
  const witnessShape = caveats === "empty-branch" ? spyOn(NodeWasmBindings.prototype, "validatePersistedSession").mockImplementation(function (this: NodeWasmBindings, proof) {
    const verified = originalVerify.call(this, proof);
    if (proof.spaceId !== f.hermetic.accountSpaceId) return verified;
    return { ...verified, verifiedRecap: verified.verifiedRecap.map((p: any) => ({ ...p, caveats: [new Map()] })) };
  }) : undefined;
  try {
    await writeJsonAtomic(additionalDelegationsPath(f.profile), [f.entry]);
    const result = await createInvocationRuntime({ profile: f.profile });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("runtime missing");
    expect(result.context.runtime.granted).toContainEqual({ service: "tinycloud.kv", space: f.hermetic.accountSpaceId,
      path: "applications/agent-demo", actions: ["tinycloud.kv/get"] });
    const node = result.context.runtime.node as TinyCloudNode;
    const read = await node.kvForSpace(f.hermetic.accountSpaceId).get("applications/agent-demo");
    expect(read.ok).toBe(true);
    expect(node.hasRuntimePermissions([{ service: "tinycloud.kv", space: f.hermetic.accountSpaceId, path: "applications/agent-demo", actions: ["tinycloud.kv/put"] }])).toBe(false);
  } finally { witnessShape?.mockRestore(); f.hermetic.stop(); }
});

test("CACAO replay rejects tampered proof and authority metadata before activation", async () => {
  const f = await fixture();
  try {
    const module = await import("./delegations.js").catch(() => ({})) as typeof import("./delegations.js");
    expect(typeof module.activateStoredRuntimeDelegation).toBe("function");
    const node = new TinyCloudNode({ host: f.hermetic.host });
    await node.restoreSession({ ...f.base, jwk: f.jwk });
    const mutations = [
      { ...f.entry, sessionProof: { ...f.entry.sessionProof, signature: "0x00" } },
      { ...f.entry, sessionProof: { ...f.entry.sessionProof, siwe: f.entry.sessionProof.siwe + " altered" } },
      { ...f.entry, delegation: { ...f.entry.delegation, host: "https://wrong.invalid" } },
      { ...f.entry, delegation: { ...f.entry.delegation, cid: "bafy-wrong" } },
      { ...f.entry, delegation: { ...f.entry.delegation, expiry: new Date(Date.now() + 90_000) } },
      { ...f.entry, delegation: { ...f.entry.delegation, resources: [{ service: "kv", space: f.entry.delegation.spaceId, path: "", actions: ["tinycloud.kv/put"] }] } },
      { ...f.entry, sessionProof: undefined },
    ];
    for (const entry of mutations) {
      await expect(module.activateStoredRuntimeDelegation(node, entry, { host: f.hermetic.host, jwk: f.jwk })).rejects.toThrow();
      expect(node.getRuntimePermissionDelegations()).toHaveLength(0);
    }
    const otherKey = JSON.parse(new NodeWasmBindings().createSessionManager().jwk("default")!);
    await expect(module.activateStoredRuntimeDelegation(node, f.entry, { host: f.hermetic.host, jwk: otherKey })).rejects.toThrow();
    expect(node.getRuntimePermissionDelegations()).toHaveLength(0);
  } finally { f.hermetic.stop(); }
});
