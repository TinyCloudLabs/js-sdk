import "./support/browserGlobalsShim";
import "../../operations/test-support/test-bootstrap.mjs";
import { expect, test } from "bun:test";
import { REGISTRY_NOT_FOUND_BODY, signLocationRecordV2 } from "@tinycloud/sdk-core";
import { TinyCloudWeb } from "../src/modules/tcw";
import { NodeWasmBindings } from "../../node-sdk/src/NodeWasmBindings";
import { PrivateKeySigner } from "../../node-sdk/src/signers/PrivateKeySigner";
import { createHermeticEncryptedNode } from "../../node-sdk/src/test-support/hermetic-encrypted-node";

type Sent = { origin: string; method: string; path: string; body: string };

/** A browser that kept a confirmed absence for its owner, whose owner then registered node B. */
async function absenceThenRegistered() {
  const oldNode = await createHermeticEncryptedNode();
  const newNode = await createHermeticEncryptedNode({ nodePrivateKey: new Uint8Array(32).fill(23) });
  const realFetch = globalThis.fetch;
  let registryBody: string | undefined;
  let registryRequests = 0;
  const sent: Sent[] = [];
  const key = "notes/non-read-refresh";
  const space = oldNode.ownerRestorableSession.spaceId;
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const signer = new PrivateKeySigner(oldNode.ownerPrivateKey);
  const address = await signer.getAddress();
  const jwk = JSON.parse(manager.jwk("default")!);
  const prepared = wasm.prepareSession({ address, chainId: 1, spaceId: space, jwk,
    domain: "registry-non-read.test", abilities: { kv: { [key]: ["tinycloud.kv/get", "tinycloud.kv/put"] } },
    issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 60_000).toISOString() });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  oldNode.allowInvocationProof(session.delegationCid);
  newNode.allowInvocationProof(session.delegationCid);
  oldNode.configureKv(space, { [key]: { value: "old" } });
  newNode.configureKv(space, {});
  const newInfo = await (await realFetch(`${newNode.host}/info`)).json() as { nodeId: string };
  const registered = JSON.stringify({ record: await signLocationRecordV2({
    version: 2, subject: oldNode.ownerDid, sequence: 0, updated_at: new Date().toISOString(),
    nodes: [{ did: newInfo.nodeId, url: newNode.host }],
    spaces: [{ space, nodes: [{ did: newInfo.nodeId, mode: "read-write" }] }], encryptionNode: null,
  }, { type: "did:pkh", signMessage: message => signer.signMessage(message) }) });
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "registry.test") {
      registryRequests++;
      return registryBody === undefined
        ? new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 }) : new Response(registryBody);
    }
    if (url.origin !== oldNode.host && url.origin !== newNode.host) throw new Error("Non-read fixture refused non-loopback fetch");
    sent.push({ origin: url.origin, method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      path: url.pathname, body: typeof init?.body === "string" ? init.body : "" });
    return realFetch(input, init);
  }, { preconnect: realFetch.preconnect });
  const web = await TinyCloudWeb.create({ ui: false, autoBootstrapAccount: false,
    tinycloudHosts: [oldNode.host], tinycloudRegistryUrl: "https://registry.test", autoDiscoverLocalNode: false });
  // The private node restores a session signed above; TinyCloudWeb exposes no public restore for it.
  const internals = web as unknown as { _node: { restoreSession(value: unknown): Promise<void> } };
  await internals._node.restoreSession({
    ...session, address, chainId: 1, spaceId: space, jwk, siwe: prepared.siwe, signature,
    verificationMethod: manager.getDID("default"), tinycloudHosts: [oldNode.host],
  });
  expect((await web.kv.get(key)).ok).toBe(true);
  const afterAbsence = registryRequests;
  registryBody = registered;
  sent.length = 0;
  return {
    web, oldNode, newNode, newInfo, key, session, sent, afterAbsence,
    registryRequests: () => registryRequests,
    stop() { globalThis.fetch = realFetch; oldNode.stop(); newNode.stop(); },
  };
}

test("a data read inside the absence window keeps the cached absence and asks the registry nothing", async () => {
  const f = await absenceThenRegistered();
  try {
    expect((await f.web.kv.get(f.key)).ok).toBe(true);
    expect(f.registryRequests()).toBe(f.afterAbsence);
    expect(f.sent.filter(s => s.path === "/invoke").map(s => s.origin)).toEqual([f.oldNode.host]);
  } finally { f.stop(); }
});

test("the active node identity after a cached absence is the newly registered node", async () => {
  const f = await absenceThenRegistered();
  try {
    const identity = await f.web.activeNodeIdentity();
    expect(identity).toEqual({ origin: f.newNode.host, nodeDid: f.newInfo.nodeId });
    expect(f.registryRequests()).toBeGreaterThan(f.afterAbsence);
    expect(f.sent.some(s => s.origin === f.oldNode.host)).toBe(false);
  } finally { f.stop(); }
});

test("share delivery after a cached absence sends the link and recipient only to the newly registered node", async () => {
  const f = await absenceThenRegistered();
  const shareKey = Buffer.alloc(32, 0x5a).toString("base64url");
  try {
    await f.web.authorizeShareDeliveryV3({
      envelope: { version: 3 }, resourcePath: f.key, recipientEmail: "recipient@example.test",
      shareUrl: `https://share.tinycloud.xyz/s/lqdw5iopqq2tkkvjj6gbbi5vbv#v=4&k=${shareKey}&c=bafkreiewixmt5nwgi3ych6durcsheaql3ybswbplpjmpbdhfkvdkidzt5u`,
      documentName: "readme.md", expiresAt: new Date(Date.now() + 30_000).toISOString(),
      deliveryAudience: "https://witness.credentials.org", idempotencyKey: "non-read-refresh",
    }).catch(() => undefined);
    const posts = f.sent.filter(s => s.method === "POST" && s.path === "/policy/v3/deliveries/authorize");
    expect(posts.map(s => s.origin)).toEqual([f.newNode.host]);
    expect(f.sent.some(s => s.origin === f.oldNode.host)).toBe(false);
  } finally { f.stop(); }
});

test("revoking the own session after a cached absence reaches only the newly registered node", async () => {
  const f = await absenceThenRegistered();
  try {
    expect((await f.web.revokeDelegation(f.session.delegationCid)).ok).toBe(true);
    expect(f.sent.filter(s => s.method === "POST" && s.path === "/revoke").map(s => s.origin)).toEqual([f.newNode.host]);
    expect(f.newNode.nativeBearerStats().revocations).toBe(1);
    expect(f.oldNode.nativeBearerStats().revocations).toBe(0);
  } finally { f.stop(); }
});
