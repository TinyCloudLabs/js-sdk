import { expect, test } from "bun:test";
import { generatePrivateKey } from "viem/accounts";
import { createInMemoryRegistryCacheStore, signLocationRecordV2, registryOwnerSubjectV1 } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./index";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { activateValidatedRuntimeDelegation } from "./delegation";
import { createHermeticEncryptedNode } from "./test-support/hermetic-encrypted-node";

test("offline restore defers independent wallet-owner refresh until live grant routing, never looking up session or display owners", async () => {
  const fixture = await createHermeticEncryptedNode();
  let registry: Bun.Server<undefined> | undefined;
  let nodeFront: Bun.Server<undefined> | undefined;
  try {
    const wasm = new NodeWasmBindings();
    const signerA = new PrivateKeySigner(generatePrivateKey());
    const signerB = new PrivateKeySigner(fixture.ownerPrivateKey);
    const addressA = await signerA.getAddress();
    const subjectA = registryOwnerSubjectV1(addressA);
    const displayOwner = await new PrivateKeySigner(generatePrivateKey()).getAddress();
    const { nodeId } = await (await fetch(`${fixture.host}/info`)).json() as { nodeId: string };
    const nodeRequests: string[] = [];
    nodeFront = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      nodeRequests.push(url.pathname);
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
    const ownerRefresh = Promise.withResolvers<void>();
    registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const key = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!);
      observed.add(key);
      return new Response(responses.get(key) ?? '{"error":"location record not found"}', { status: responses.has(key) ? 200 : 404 });
    } });
    const manager = wasm.createSessionManager(), jwk = JSON.parse(manager.jwk("default")!);
    const primarySpace = fixture.ownerRestorableSession.spaceId;
    const prepared = wasm.prepareSession({ address: addressA, chainId: 1, domain: "cache-TEST.invalid", spaceId: primarySpace, jwk,
      abilities: { kv: { "": ["tinycloud.kv/get"] } },
      issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 600_000).toISOString() });
    const signature = await signerA.signMessage(prepared.siwe);
    const base = wasm.completeSessionSetup({ ...prepared, signature });
    const cacheStore = createInMemoryRegistryCacheStore();
    const updateCache = cacheStore.update.bind(cacheStore);
    cacheStore.update = async (key, update) => {
      const entry = await updateCache(key, update);
      if (key === addressA) ownerRefresh.resolve();
      return entry;
    };
    const node = new TinyCloudNode({ wasmBindings: wasm, host, tinycloudRegistryUrl: registry.url.origin, registryCacheStore: cacheStore });
    await node.restoreSession({ ...base, jwk, address: addressA, chainId: 1, siwe: prepared.siwe, signature, spaceId: primarySpace });
    expect([...observed]).toEqual([]);
    expect(nodeRequests).toEqual([]);
    // Only B is authorized; live grant routing must independently discover wallet owner A.
    const verified = node.verifySessionGrant({
      ...base, address: addressA, chainId: 1, siwe: prepared.siwe, signature, spaceId: primarySpace,
    });
    expect(verified.recap.map(({ space }) => space)).toEqual([primarySpace]);
    const grant = await fixture.mintDelegationForAudience(node.sessionDid.split("#", 1)[0]!);
    // An unsigned display owner C must not cause a lookup alongside A or signed owner B.
    await activateValidatedRuntimeDelegation(node, { ...grant, ownerAddress: displayOwner }, { host });
    await ownerRefresh.promise;
    const addressB = fixture.ownerDid.slice(fixture.ownerDid.lastIndexOf(":") + 1);
    expect([...observed].sort()).toEqual([addressA, addressB].sort());
    expect((await cacheStore.get(addressA))?.sequence).toBe(3);
    expect((await cacheStore.get(addressB))?.sequence).toBe(3);
    expect(await cacheStore.get(node.sessionDid)).toBeUndefined();
    expect(await cacheStore.get(displayOwner)).toBeUndefined();
  } finally { registry?.stop(true); nodeFront?.stop(true); fixture.stop(); }
}, 15_000);
