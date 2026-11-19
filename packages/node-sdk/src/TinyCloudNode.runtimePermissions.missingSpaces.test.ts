import { expect, test } from "bun:test";
import { createInMemoryRegistryCacheStore, type LocationRecordV2, type PermissionEntry } from "@tinycloud/sdk-core";
import { MissingSpacesError } from "./delegation";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";

// Owner, nodes and signed v2 record from the shared registry vectors.
const vectors = await Bun.file(`${import.meta.dir}/../../sdk-core/test-vectors/registry-v2/registry-v2.json`).json() as {
  records: Array<{ id: string; record: LocationRecordV2 }>;
};
const record = vectors.records.find(({ id }) => id === "split-data-and-encryption")!.record;
const ownerKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const registry = "https://registry.fixture.invalid";
const box = record.nodes.find(({ did }) => did === record.spaces[0]!.nodes[0]!.did)!;
const encryption = record.nodes.find(({ did }) => did === record.encryptionNode)!;
const routedSpace = record.spaces[0]!.space;
// A space of the same owner the signed record does not list: never set up.
const unlistedSpace = routedSpace.replace(/:[^:]+$/, ":credentials");
const otherUnlistedSpace = routedSpace.replace(/:[^:]+$/, ":agents");

const kv = (space: string): PermissionEntry => ({
  service: "tinycloud.kv", space, path: "missing-spaces/", actions: ["tinycloud.kv/get"],
});
const network = `urn:tinycloud:encryption:${record.subject}:default`;
const decrypt: PermissionEntry = {
  service: "tinycloud.encryption", path: network, actions: ["tinycloud.encryption/decrypt"], skipPrefix: true,
};

/**
 * A signed-in client whose nodes always skip the unlisted space; the data node
 * activates the routed space, skips it (`true`) or answers 404 (`"404-routed"`).
 */
async function withClient(mode: boolean | "404-routed", run: (node: TinyCloudNode) => Promise<void>) {
  const skipRouted = mode === true;
  const original = globalThis.fetch;
  const bindings = new NodeWasmBindings();
  const signer = new PrivateKeySigner(ownerKey);
  let signedIn = false;
  let node!: TinyCloudNode;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.origin === registry) return Response.json({ record });
    const target = [box, encryption].find(({ url: origin }) => origin === url.origin);
    if (!target) throw new Error(`Fixture forbids non-fixture network requests: ${url.href}`);
    if (url.pathname === "/info") return Response.json({ nodeId: target.did, protocol: bindings.protocolVersion(), version: "fixture", features: [] });
    if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: target.did, shareInvitationPublicKey: "A".repeat(43) });
    if (method === "POST" && url.pathname === "/delegate") {
      const cid = node.computeDelegationCid(new Headers(init?.headers).get("authorization")!);
      if (!signedIn) return Response.json({ cid, activated: [], skipped: [] });
      if (mode === "404-routed" && target.did === box.did) return new Response("Space not found", { status: 404 });
      const skipped = [unlistedSpace, ...(skipRouted ? [routedSpace] : [])];
      return Response.json({ cid, activated: skipRouted ? [] : [routedSpace], skipped });
    }
    throw new Error(`Unexpected fixture endpoint: ${method} ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  try {
    node = new TinyCloudNode({
      signer,
      wasmBindings: bindings,
      host: box.url,
      tinycloudRegistryUrl: registry,
      autoDiscoverLocalNode: false,
      registryCacheStore: createInMemoryRegistryCacheStore(),
      autoCreateSpace: false,
      autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false,
      enablePublicSpace: false,
      prefix: "secrets",
      manifest: {
        app_id: "com.tc3338.missing-spaces", name: "Missing spaces fixture",
        defaults: false, includePublicSpace: false, space: "secrets",
        permissions: [{ service: "tinycloud.kv", path: "vault/secrets/", actions: ["get"], skipPrefix: true }],
      },
    });
    await node.signIn();
    signedIn = true;
    await run(node);
  } finally {
    globalThis.fetch = original;
  }
}

const signMessageCounter = (signer: PrivateKeySigner, onSign: () => void) => (siwe: string) => {
  onSign();
  return signer.signMessage(siwe);
};

test("a space with no location record is reported missing; the routed space's grant is installed", async () => {
  await withClient(false, async (node) => {
    let approvals = 0;
    const signMessage = signMessageCounter(new PrivateKeySigner(ownerKey), () => { approvals += 1; });
    const error = await node.grantRuntimePermissions([kv(routedSpace), kv(unlistedSpace)], { signMessage })
      .then(() => undefined, (caught: unknown) => caught);
    expect(approvals).toBe(1);
    expect(error).toBeInstanceOf(MissingSpacesError);
    expect((error as MissingSpacesError).code).toBe("SPACE_NOT_FOUND");
    expect((error as MissingSpacesError).missingSpaceIds).toEqual([unlistedSpace]);
    expect((error as MissingSpacesError).delegations.map(({ spaceId }) => spaceId)).toEqual([routedSpace]);
    expect(node.hasRuntimePermissions([kv(routedSpace)])).toBe(true);
    expect(node.hasRuntimePermissions([kv(unlistedSpace)])).toBe(false);
  });
});

test("a routed space its node skips stays RESOURCE_NOT_ROUTED and installs nothing", async () => {
  await withClient(true, async (node) => {
    const signMessage = signMessageCounter(new PrivateKeySigner(ownerKey), () => {});
    await expect(node.grantRuntimePermissions([kv(routedSpace), kv(unlistedSpace)], { signMessage }))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_ROUTED" });
    expect(node.hasRuntimePermissions([kv(routedSpace)])).toBe(false);
    expect(node.hasRuntimePermissions([kv(unlistedSpace)])).toBe(false);
  });
});

test("a registered owner whose record lists none of the requested spaces gets MissingSpacesError for all of them", async () => {
  await withClient(false, async (node) => {
    let approvals = 0;
    const signMessage = signMessageCounter(new PrivateKeySigner(ownerKey), () => { approvals += 1; });
    for (const requested of [[unlistedSpace], [unlistedSpace, otherUnlistedSpace]]) {
      approvals = 0;
      const error = await node.grantRuntimePermissions(requested.map(kv), { signMessage })
        .then(() => undefined, (caught: unknown) => caught);
      expect(approvals).toBe(1);
      expect(error).toBeInstanceOf(MissingSpacesError);
      expect((error as MissingSpacesError).missingSpaceIds).toEqual(requested);
      expect((error as MissingSpacesError).delegations).toEqual([]);
      for (const space of requested) expect(node.hasRuntimePermissions([kv(space)])).toBe(false);
    }
  });
});

test("a registry-routed node answering 404 is RESOURCE_NOT_ROUTED, not a missing space", async () => {
  await withClient("404-routed", async (node) => {
    const signMessage = signMessageCounter(new PrivateKeySigner(ownerKey), () => {});
    await expect(node.grantRuntimePermissions([kv(routedSpace)], { signMessage }))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_ROUTED" });
    expect(node.hasRuntimePermissions([kv(routedSpace)])).toBe(false);
  });
});

test("a decrypt grant still installs when the first requested space is missing", async () => {
  await withClient(false, async (node) => {
    const signMessage = signMessageCounter(new PrivateKeySigner(ownerKey), () => {});
    const error = await node.grantRuntimePermissions([kv(unlistedSpace), kv(routedSpace), decrypt], { signMessage })
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(MissingSpacesError);
    const missing = error as MissingSpacesError;
    expect(missing.missingSpaceIds).toEqual([unlistedSpace]);
    expect(missing.delegations.map(({ spaceId }) => spaceId)).toEqual([routedSpace]);
    expect(missing.delegations[0]!.resources?.some(({ path }) => path === network)).toBe(true);
    expect(node.hasRuntimePermissions([decrypt])).toBe(true);
    expect(node.hasRuntimePermissions([kv(routedSpace)])).toBe(true);
  });
});

test("a routed skip across the data and encryption nodes stays RESOURCE_NOT_ROUTED", async () => {
  await withClient(true, async (node) => {
    const signMessage = signMessageCounter(new PrivateKeySigner(ownerKey), () => {});
    await expect(node.grantRuntimePermissions([kv(routedSpace), decrypt], { signMessage }))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_ROUTED" });
    expect(node.hasRuntimePermissions([kv(routedSpace)])).toBe(false);
    expect(node.hasRuntimePermissions([decrypt])).toBe(false);
  });
});
