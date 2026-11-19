import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  createInMemoryRegistryCacheStore,
  createInMemoryRegistrySequenceStore,
  pkhDid,
  signLocationRecordV2,
} from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { createHermeticEncryptedNode } from "./test-support/hermetic-encrypted-node";

const originalFetch = globalThis.fetch;
const cleanups: Array<() => void> = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function registeredOwner(options: { primary?: boolean; readOnly?: boolean } = {}) {
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  cleanups.push(() => warnings.mockRestore());
  const fixture = await createHermeticEncryptedNode({
    ownerPrivateKey: randomBytes(32).toString("hex"),
    delegatePrivateKey: randomBytes(32).toString("hex"),
    nodePrivateKey: Uint8Array.from(randomBytes(32)),
    networkSeed: Uint8Array.from(randomBytes(32)),
  });
  cleanups.push(() => fixture.stop());
  const signer = new PrivateKeySigner(fixture.ownerPrivateKey);
  const address = await signer.getAddress();
  const owner = pkhDid(address, 1);
  const space = `tinycloud:pkh:eip155:1:${address.toLowerCase()}:default`;
  const account = space.replace(/:default$/, ":account");
  fixture.configureKv(space, { "qa/value": "stored-default-value" });
  const info = await (await originalFetch(`${fixture.host}/info`)).json() as { nodeId: string };
  const record = await signLocationRecordV2({
    version: 2, subject: owner, sequence: 0, updated_at: new Date().toISOString(),
    nodes: [{ did: info.nodeId, url: fixture.host }],
    spaces: [{ space: options.primary === false ? account : space,
      nodes: [{ did: info.nodeId, mode: options.readOnly ? "read-only" : "read-write" }] }],
    encryptionNode: null,
  }, { type: "did:pkh", signMessage: (message) => signer.signMessage(message) });
  let unavailable = false;
  const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (unavailable) return Response.json({ error: "unavailable" }, { status: 503 });
    return new URL(request.url).pathname.startsWith("/v2/")
      ? Response.json({ record })
      : Response.json({ error: "location record not found" }, { status: 404 });
  } });
  cleanups.push(() => registry.stop(true));
  const origins = new Set([fixture.host, registry.url.origin]);
  const unexpectedOrigins: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!origins.has(url.origin)) {
      unexpectedOrigins.push(url.origin);
      throw new Error("Test refused a non-owned destination");
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
  const node = new TinyCloudNode({
    privateKey: fixture.ownerPrivateKey, signer, wasmBindings: new NodeWasmBindings(), host: fixture.host,
    tinycloudRegistryUrl: registry.url.origin, autoCreateSpace: true,
    autoDiscoverLocalNode: false,
    registryCacheStore: createInMemoryRegistryCacheStore(),
    registrySequenceStore: createInMemoryRegistrySequenceStore(),
  });
  return { node, fixture, space, unexpectedOrigins,
    setUnavailable(value: boolean) { unavailable = value; } };
}

test("a default-only published owner signs in and reuses its verified route without optional unlisted setup", async () => {
  const { node, fixture, space, unexpectedOrigins, setUnavailable } = await registeredOwner();
  const before = fixture.invocations().length;
  await node.signIn();
  await node.waitForAccountRegistrySync();
  const online = await node.kv.get<string>("qa/value");
  expect(online.ok).toBe(true);
  if (!online.ok) throw online.error;
  expect(online.data.data).toBe("stored-default-value");
  setUnavailable(true);
  const offline = await node.kv.get<string>("qa/value");
  expect(offline.ok).toBe(true);
  if (!offline.ok) throw offline.error;
  expect(offline.data.data).toBe("stored-default-value");
  expect(fixture.invocations().slice(before).every((invocation) => invocation.space.toLowerCase() === space)).toBe(true);
  expect(unexpectedOrigins).toEqual([]);

  setUnavailable(false);
  const requestsBefore = fixture.requests().length;
  await expect(node.hostOwnedSpace("secrets")).rejects.toMatchObject({ code: "node_not_found" });
  expect(fixture.requests().slice(requestsBefore).filter((request) => request.method === "POST")).toEqual([]);
}, 15_000);

test("an owner without its primary space published still refuses before credential dispatch", async () => {
  const { node, fixture, unexpectedOrigins } = await registeredOwner({ primary: false });
  const before = fixture.requests().length;
  await expect(node.signIn()).rejects.toMatchObject({ code: "node_not_found" });
  expect(fixture.requests().slice(before).filter((request) => request.authorizationSha256 !== undefined)).toEqual([]);
  expect(unexpectedOrigins).toEqual([]);
}, 15_000);

test("a read-only published primary signs in without automatic data writes", async () => {
  const { node, fixture, unexpectedOrigins } = await registeredOwner({ readOnly: true });
  const before = fixture.invocations().length;
  await node.signIn();
  await node.waitForAccountRegistrySync();
  const result = await node.kv.get<string>("qa/value");
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.data.data).toBe("stored-default-value");
  expect(fixture.invocations().slice(before).filter((invocation) => !["tinycloud.kv/get", "tinycloud.kv/list"].includes(invocation.action))).toEqual([]);
  expect(unexpectedOrigins).toEqual([]);
}, 15_000);
