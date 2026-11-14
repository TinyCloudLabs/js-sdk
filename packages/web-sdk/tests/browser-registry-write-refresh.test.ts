import "./support/browserGlobalsShim";
import "../../operations/test-support/test-bootstrap.mjs";
import { expect, test } from "bun:test";
import { REGISTRY_NOT_FOUND_BODY, signLocationRecordV2 } from "@tinycloud/sdk-core";
import { TinyCloudWeb } from "../src/modules/tcw";
import { NodeWasmBindings } from "../../node-sdk/src/NodeWasmBindings";
import { PrivateKeySigner } from "../../node-sdk/src/signers/PrivateKeySigner";
import { createHermeticEncryptedNode } from "../../node-sdk/src/test-support/hermetic-encrypted-node";

test("a browser write refreshes cached absence and uses the newly registered node", async () => {
  const oldNode = await createHermeticEncryptedNode();
  const newNode = await createHermeticEncryptedNode();
  const realFetch = globalThis.fetch;
  let registryBody: string | undefined;
  let registryRequests = 0;
  const key = "notes/write-refresh";
  const space = oldNode.ownerRestorableSession.spaceId;
  try {
    const wasm = new NodeWasmBindings();
    const manager = wasm.createSessionManager();
    const signer = new PrivateKeySigner(oldNode.ownerPrivateKey);
    const address = await signer.getAddress();
    const jwk = JSON.parse(manager.jwk("default")!);
    const prepared = wasm.prepareSession({ address, chainId: 1, spaceId: space, jwk,
      domain: "registry-write.test", abilities: { kv: { [key]: ["tinycloud.kv/get", "tinycloud.kv/put"] } },
      issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 60_000).toISOString() });
    const signature = await signer.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    oldNode.allowInvocationProof(session.delegationCid);
    newNode.allowInvocationProof(session.delegationCid);
    oldNode.configureKv(space, { [key]: { value: "old" } });
    newNode.configureKv(space, {});
    const info = await (await realFetch(`${newNode.host}/info`)).json() as { nodeId: string };
    const payload = { version: 2 as const, subject: oldNode.ownerDid, sequence: 0,
      updated_at: new Date().toISOString(), nodes: [{ did: info.nodeId, url: newNode.host }],
      spaces: [{ space, nodes: [{ did: info.nodeId, mode: "read-write" as const }] }], encryptionNode: null };
    const registered = JSON.stringify({ record: await signLocationRecordV2(payload,
      { type: "did:pkh", signMessage: message => signer.signMessage(message) }) });
    const removed = JSON.stringify({ record: await signLocationRecordV2({ ...payload, sequence: 1, nodes: [], spaces: [] },
      { type: "did:pkh", signMessage: message => signer.signMessage(message) }) });
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "registry.test") {
        registryRequests++;
        return Promise.resolve(registryBody === undefined
          ? new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 }) : new Response(registryBody));
      }
      if (url.origin !== oldNode.host && url.origin !== newNode.host) throw new Error("Write fixture refused non-loopback fetch");
      return realFetch(input, init);
    }, { preconnect: realFetch.preconnect });
    const web = await TinyCloudWeb.create({ ui: false, autoBootstrapAccount: false,
      tinycloudHosts: [oldNode.host], tinycloudRegistryUrl: "https://registry.test", autoDiscoverLocalNode: false });
    await (web as unknown as { _node: { restoreSession(value: unknown): Promise<void> } })._node.restoreSession({
      ...session, address, chainId: 1, spaceId: space, jwk, siwe: prepared.siwe, signature,
      verificationMethod: manager.getDID("default"), tinycloudHosts: [oldNode.host],
    });
    expect((await web.kv.get(key)).ok).toBe(true);
    expect(registryRequests).toBe(2);
    const oldRequests = oldNode.requests().length;
    registryBody = registered;
    expect((await web.kv.put(key, { value: "new" })).ok).toBe(true);
    expect(registryRequests).toBe(3);
    expect(oldNode.requests().length).toBe(oldRequests);
    expect(newNode.nativeBearerStats().kvWrites).toBe(1);
    const requestsBeforeRemoval = newNode.requests().length;
    registryBody = removed;
    expect((await web.kv.get(key)).ok).toBe(false);
    expect(registryRequests).toBe(4);
    expect(newNode.requests().length).toBe(requestsBeforeRemoval);
  } finally {
    globalThis.fetch = realFetch;
    oldNode.stop(); newNode.stop();
  }
});
