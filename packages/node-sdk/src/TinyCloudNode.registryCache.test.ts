import { expect, test } from "bun:test";
import { generatePrivateKey } from "viem/accounts";
import { createInMemoryRegistryCacheStore, signLocationRecordV2, registryOwnerSubjectV1, refreshOwnerRegistry } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./index";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { activateValidatedRuntimeDelegation } from "./delegation";
import { createHermeticEncryptedNode } from "./test-support/hermetic-encrypted-node";

test("startup refresh derives wallet and held-grant owners from verified authority, never the session key or display owner", async () => {
  const fixture = await createHermeticEncryptedNode();
  let registry: Bun.Server<undefined> | undefined;
  let nodeFront: Bun.Server<undefined> | undefined;
  try {
    const wasm = new NodeWasmBindings();
    const signerA = new PrivateKeySigner(generatePrivateKey());
    const signerB = new PrivateKeySigner(fixture.ownerPrivateKey);
    const addressA = await signerA.getAddress();
    const subjectA = registryOwnerSubjectV1(addressA);
    const { nodeId } = await (await fetch(`${fixture.host}/info`)).json() as { nodeId: string };
    nodeFront = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: nodeId, shareInvitationPublicKey: "A".repeat(43) });
      return fetch(new Request(`${fixture.host}${url.pathname}${url.search}`, request));
    } });
    const host = nodeFront.url.origin;
    const spaceA = wasm.makeSpaceId(addressA, 1, "secrets");
    const responses = new Map<string, string>();
    for (const [subject, spaceId, signer] of [[subjectA, spaceA, signerA], [fixture.ownerDid, fixture.ownerRestorableSession.spaceId, signerB]] as const) {
      const record = await signLocationRecordV2({ version: 2, subject, sequence: 3, updated_at: new Date().toISOString(),
        nodes: [{ did: nodeId, url: host }], spaces: [{ space: spaceId, nodes: [{ did: nodeId, mode: "read-write" }] }], encryptionNode: nodeId,
      }, { type: "did:pkh", signMessage: (message) => signer.signMessage(message) });
      responses.set(subject.slice(subject.lastIndexOf(":") + 1), JSON.stringify({ record }));
    }
    const observed = new Set<string>();
    let ownerObserved!: () => void;
    const ownerRefresh = new Promise<void>((resolve) => { ownerObserved = resolve; });
    registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const key = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!);
      observed.add(key);
      if (key === addressA) ownerObserved();
      return new Response(responses.get(key) ?? '{"error":"location record not found"}', { status: responses.has(key) ? 200 : 404 });
    } });
    const manager = wasm.createSessionManager(), jwk = JSON.parse(manager.jwk("default")!);
    const primarySpace = fixture.ownerRestorableSession.spaceId;
    const prepared = wasm.prepareSession({ address: addressA, chainId: 1, domain: "cache-TEST.invalid", spaceId: primarySpace, jwk,
      abilities: {}, issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 600_000).toISOString() });
    const signature = await signerA.signMessage(prepared.siwe);
    const base = wasm.completeSessionSetup({ ...prepared, signature });
    const cacheStore = createInMemoryRegistryCacheStore();
    const node = new TinyCloudNode({ wasmBindings: wasm, host, tinycloudRegistryUrl: registry.url.origin, registryCacheStore: cacheStore });
    await node.restoreSession({ ...base, jwk, address: addressA, chainId: 1, siwe: prepared.siwe, signature, spaceId: primarySpace });
    // The primary resource belongs to B, so only authenticated-owner refresh discovers A.
    await ownerRefresh;
    const grant = await fixture.mintDelegationForAudience(node.sessionDid.split("#", 1)[0]!);
    // Untrusted display owner is deliberately unrelated; signed resources win.
    await activateValidatedRuntimeDelegation(node, { ...grant, ownerAddress: addressA }, { host });
    const addressB = fixture.ownerDid.slice(fixture.ownerDid.lastIndexOf(":") + 1);
    await Promise.all([subjectA, fixture.ownerDid].map((subject) => refreshOwnerRegistry(subject, { cacheStore, registryUrl: registry!.url.origin })));
    expect([...observed].sort()).toEqual([addressA, addressB].sort());
    expect((await cacheStore.get(addressA))?.sequence).toBe(3);
    expect((await cacheStore.get(addressB))?.sequence).toBe(3);
    expect(await cacheStore.get(node.sessionDid)).toBeUndefined();
  } finally { registry?.stop(true); nodeFront?.stop(true); fixture.stop(); }
}, 15_000);
