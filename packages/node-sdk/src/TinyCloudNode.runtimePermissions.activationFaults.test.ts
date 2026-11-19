import { expect, test } from "bun:test";
import {
  createInMemoryRegistryCacheStore,
  REGISTRY_NOT_FOUND_BODY,
  type LocationRecordV2,
  type PermissionEntry,
} from "@tinycloud/sdk-core";
import { routingFailure } from "@tinycloud/sdk-services";
import { activateValidatedRuntimeDelegation, MissingSpacesError, RuntimeDelegationRejectedError } from "./delegation";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";

/**
 * How a node's 404 to activation reads, per caller: a runtime grant whose
 * spaces turn out missing installs nothing (not even its raw decrypt), and a
 * stored grant replayed onto a registry-routed node answering 404 is a
 * rejected activation the replay skips, not a routing fault that aborts it.
 */
const vectors = await Bun.file(`${import.meta.dir}/../../sdk-core/test-vectors/registry-v2/registry-v2.json`).json() as {
  records: Array<{ id: string; record: LocationRecordV2 }>;
};
const record = vectors.records.find(({ id }) => id === "split-data-and-encryption")!.record;
const ownerKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const registry = "https://registry.fixture.invalid";
const newUserNode = "https://new-user.fixture.invalid";
const box = record.nodes.find(({ did }) => did === record.spaces[0]!.nodes[0]!.did)!;
const encryption = record.nodes.find(({ did }) => did === record.encryptionNode)!;
const routedSpace = record.spaces[0]!.space;
const missingSpace = routedSpace.replace(/:[^:]+$/, ":credentials");

const kv = (space: string): PermissionEntry => ({
  service: "tinycloud.kv", space, path: "activation-faults/", actions: ["tinycloud.kv/get"],
});
const decrypt: PermissionEntry = {
  service: "tinycloud.encryption",
  path: `urn:tinycloud:encryption:${record.subject}:default`,
  actions: ["tinycloud.encryption/decrypt"],
  skipPrefix: true,
};

/**
 * A signed-in client. `registered` serves the signed record (data and
 * encryption nodes); otherwise the registry has no record and everything goes
 * to the new-user node. Once `state.delegate404` is set, every `/delegate`
 * answers 404.
 */
async function withClient(
  registered: boolean,
  run: (node: TinyCloudNode, state: { delegate404: boolean }) => Promise<void>,
) {
  const original = globalThis.fetch;
  const bindings = new NodeWasmBindings();
  const state = { delegate404: false };
  const nodes = registered ? [box, encryption] : [{ did: "did:key:z6MkNewUserFixture", url: newUserNode }];
  let node!: TinyCloudNode;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.origin === registry) {
      return registered
        ? Response.json({ record })
        : new Response(REGISTRY_NOT_FOUND_BODY, { status: 404, headers: { "content-type": "application/json" } });
    }
    const target = nodes.find(({ url: origin }) => origin === url.origin);
    if (!target) throw new Error(`Fixture forbids non-fixture network requests: ${url.href}`);
    if (url.pathname === "/info") return Response.json({ nodeId: target.did, protocol: bindings.protocolVersion(), version: "fixture", features: [] });
    if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: target.did, shareInvitationPublicKey: "A".repeat(43) });
    if (method === "POST" && url.pathname === "/delegate") {
      if (state.delegate404) return new Response("Space not found", { status: 404 });
      const cid = node.computeDelegationCid(new Headers(init?.headers).get("authorization")!);
      return Response.json({ cid, activated: registered ? [routedSpace] : [], skipped: [] });
    }
    throw new Error(`Unexpected fixture endpoint: ${method} ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  try {
    node = new TinyCloudNode({
      signer: new PrivateKeySigner(ownerKey),
      wasmBindings: bindings,
      host: registered ? box.url : newUserNode,
      newUserHost: newUserNode,
      tinycloudRegistryUrl: registry,
      autoDiscoverLocalNode: false,
      registryCacheStore: createInMemoryRegistryCacheStore(),
      autoCreateSpace: false,
      autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false,
      enablePublicSpace: false,
      prefix: "secrets",
      manifest: {
        app_id: "com.tc3338.activation-faults", name: "Activation faults fixture",
        defaults: false, includePublicSpace: false, space: "secrets",
        permissions: [{ service: "tinycloud.kv", path: "vault/secrets/", actions: ["get"], skipPrefix: true }],
      },
    });
    await node.signIn();
    await run(node, state);
  } finally {
    globalThis.fetch = original;
  }
}

test("an unregistered owner's 404 for a missing space installs no decrypt grant and returns no delegation", async () => {
  await withClient(false, async (node, state) => {
    state.delegate404 = true;
    const error = await node.grantRuntimePermissions([kv(missingSpace), decrypt])
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(MissingSpacesError);
    expect((error as MissingSpacesError).missingSpaceIds).toEqual([missingSpace]);
    expect((error as MissingSpacesError).delegations).toEqual([]);
    expect(node.hasRuntimePermissions([decrypt])).toBe(false);
    expect(node.hasRuntimePermissions([kv(missingSpace)])).toBe(false);
  });
});

test("replaying a stored grant onto a registry-routed node answering 404 is a rejected activation, not a routing fault", async () => {
  await withClient(true, async (node, state) => {
    const [delegation] = await node.grantRuntimePermissions([kv(routedSpace)]);
    state.delegate404 = true;
    const error = await activateValidatedRuntimeDelegation(node, delegation!, { host: box.url })
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeDelegationRejectedError);
    expect((error as RuntimeDelegationRejectedError).reason).toBe("activation_rejected");
    expect(routingFailure(error)).toBeUndefined();
  });
});
