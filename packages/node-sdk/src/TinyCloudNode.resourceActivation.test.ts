import { expect, test } from "bun:test";
import { REGISTRY_NOT_FOUND_BODY, httpUrlToMultiaddr, signLocationRecord, type LocationRecord, type LocationRecordV2, type PermissionEntry } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";

const vectors = await Bun.file(`${import.meta.dir}/../../sdk-core/test-vectors/registry-v2/registry-v2.json`).json() as {
  records: Array<{ id: string; record: LocationRecordV2 }>;
};
const record = vectors.records.find(({ id }) => id === "split-data-and-encryption")!.record;
const registry = "https://registry.fixture.invalid";
const stale = "https://stale.fixture.invalid";
const box = record.nodes.find(({ did }) => did === record.spaces[0]!.nodes[0]!.did)!;
const encryption = record.nodes.find(({ did }) => did === record.encryptionNode)!;
const network = `urn:tinycloud:encryption:${record.subject}:default`;
const ownerKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const decryptPermission: PermissionEntry = {
  service: "tinycloud.encryption", path: network, actions: ["tinycloud.encryption/decrypt"], skipPrefix: true,
};

type ActivationMode = "encryption-only" | "mixed-repeat" | "listed-skipped";
interface ScopedClientFixture {
  node: TinyCloudNode;
  staleRequests: string[];
  refuseEncryption(): void;
  setActivationMode(mode: ActivationMode): void;
  useV1OnlyRegistry(): Promise<void>;
  useAbsentRegistry(): void;
}
async function withScopedClient(run: (fixture: ScopedClientFixture) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const staleRequests: string[] = [];
  let signedIn = false;
  let encryptionRefused = false;
  let activationMode: ActivationMode = "encryption-only";
  let registryAbsent = false;
  let legacyRecord: LocationRecord | undefined;
  const signer = new PrivateKeySigner(ownerKey);
  const bindings = new NodeWasmBindings();
  const activeSpace = bindings.makeSpaceId(record.subject.slice(record.subject.lastIndexOf(":") + 1), 1, "secrets");
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.origin === registry) {
      if (!registryAbsent) return Response.json({ record });
      if (legacyRecord && url.pathname === `/v1/locations/${encodeURIComponent(legacyRecord.subject)}`) return Response.json({ record: legacyRecord });
      return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
    }
    if (url.origin === stale) {
      staleRequests.push(url.href);
      return new Response("registry_hosting_denied: unlisted node", { status: 403 });
    }
    const target = [box, encryption].find(({ url: origin }) => origin === url.origin);
    if (!target) throw new Error("Fixture forbids non-fixture network requests");
    if (url.pathname === "/info") return Response.json({ nodeId: target.did, protocol: bindings.protocolVersion(), version: "fixture", features: [] });
    if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: target.did, shareInvitationPublicKey: "A".repeat(43) });
    if (method === "GET" && url.pathname.startsWith("/encryption/networks/")) {
      return encryptionRefused
        ? new Response("registry_unavailable: fixture unavailable", { status: 503 })
        : new Response("", { status: 404 });
    }
    if (method === "POST" && url.pathname === "/delegate") {
      if (signedIn && target.did === box.did && activationMode === "encryption-only") return new Response("registry_hosting_denied: encryption-only grant", { status: 403 });
      if (encryptionRefused && target.did === encryption.did) return new Response("registry_unavailable: fixture unavailable", { status: 503 });
      const skipListed = signedIn && activationMode === "listed-skipped" && target.did === box.did;
      const repeated = signedIn && activationMode === "mixed-repeat";
      return Response.json({
        cid: "bafkqaaa",
        activated: target.did === box.did && !skipListed && !repeated ? [activeSpace] : [],
        skipped: target.did === encryption.did || skipListed ? [activeSpace] : [],
      });
    }
    throw new Error(`Unexpected fixture endpoint: ${method} ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  try {
    const node = new TinyCloudNode({
      signer,
      wasmBindings: bindings,
      host: stale,
      tinycloudRegistryUrl: registry,
      autoDiscoverLocalNode: false,
      autoCreateSpace: false,
      autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false,
      enablePublicSpace: false,
      prefix: "secrets",
      manifest: {
        app_id: "com.tc2481.resource-activation", name: "Resource activation fixture",
        defaults: false, includePublicSpace: false, space: "secrets",
        permissions: [{ service: "tinycloud.kv", path: "vault/secrets/", actions: ["get"], skipPrefix: true }],
      },
    });
    await node.signIn();
    signedIn = true;
    await run({
      node, staleRequests,
      refuseEncryption: () => { encryptionRefused = true; },
      setActivationMode: (mode) => { activationMode = mode; },
      useV1OnlyRegistry: async () => {
        legacyRecord = await signLocationRecord({
          version: 1, subject: record.subject.replace(":1:", ":137:"),
          multiaddrs: [httpUrlToMultiaddr(encryption.url)],
          updated_at: record.updated_at, sequence: 0,
        }, { type: "did:pkh", signMessage: (message) => signer.signMessage(message) });
        registryAbsent = true;
      },
      useAbsentRegistry: () => { legacyRecord = undefined; registryAbsent = true; },
    });
  } finally {
    globalThis.fetch = original;
  }
}

test("a scoped client installs a newly approved decrypt grant at its encryption node, ignoring stale profile hints", async () => {
  await withScopedClient(async ({ node, staleRequests }) => {
    expect(node.hasRuntimePermissions([decryptPermission])).toBe(false);
    const [delegation] = await node.grantRuntimePermissions([decryptPermission]);
    expect(node.hasRuntimePermissions([decryptPermission])).toBe(true);
    await node.useRuntimeDelegation({ ...delegation!, host: stale });
    expect(node.hasRuntimePermissions([decryptPermission])).toBe(true);
    expect(staleRequests).toEqual([]);
  });
});

test("a refused encryption activation never installs decrypt authority", async () => {
  await withScopedClient(async ({ node, refuseEncryption }) => {
    refuseEncryption();
    await expect(node.grantRuntimePermissions([decryptPermission])).rejects.toMatchObject({ cause: { status: 503 } });
    expect(node.hasRuntimePermissions([decryptPermission])).toBe(false);
  });
});

test("mixed registration does not report an already-active data space as skipped by its encryption-only node", async () => {
  await withScopedClient(async ({ node, setActivationMode }) => {
    setActivationMode("mixed-repeat");
    const receipt = await node.createOwnerDelegation({
      delegateDid: box.did,
      spaceId: record.spaces[0]!.space,
      expiresAt: new Date(Date.now() + 60_000),
      permissions: [
        { service: "tinycloud.kv", path: "vault/secrets/DUMMY", actions: ["tinycloud.kv/get"] },
        { service: "tinycloud.encryption", path: network, actions: ["tinycloud.encryption/decrypt"] },
      ],
    });
    expect(receipt.nodeReceipt.activated).toEqual([]);
    expect(receipt.nodeReceipt.skipped).toEqual([]);
  });
});

test("HTTP success that skips a listed data resource does not install its permission", async () => {
  await withScopedClient(async ({ node, setActivationMode }) => {
    setActivationMode("listed-skipped");
    const permission: PermissionEntry = {
      service: "tinycloud.kv", space: record.spaces[0]!.space,
      path: "vault/secrets/DUMMY", actions: ["tinycloud.kv/put"], skipPrefix: true,
    };
    await expect(node.grantRuntimePermissions([permission])).rejects.toMatchObject({ code: "RESOURCE_NOT_ROUTED" });
    expect(node.hasRuntimePermissions([permission])).toBe(false);
  });
});

function restoringClient(wallet: boolean, registryChainId?: number): TinyCloudNode {
  return new TinyCloudNode({
    ...(wallet ? { signer: new PrivateKeySigner(ownerKey) } : {}),
    wasmBindings: new NodeWasmBindings(), host: encryption.url, tinycloudRegistryUrl: registry, registryChainId,
    autoDiscoverLocalNode: false, autoCreateSpace: false, autoBootstrapAccount: false,
    includeAccountRegistryPermissions: false, enablePublicSpace: false,
  });
}

test("restored hosting uses the signed primary rather than its default constructor prefix", async () => {
  await withScopedClient(async ({ node, setActivationMode }) => {
    const saved = node.restorableSession!;
    const restored = restoringClient(true);
    setActivationMode("mixed-repeat");
    await restored.restoreSession({ ...saved, tinycloudHosts: [encryption.url] });
    expect(await restored.hostOwnedSpace("secrets")).toBe(saved.spaceId);
    expect(restored.restorableSession?.spaceId).toBe(saved.spaceId);
    expect(restored.hosts).toEqual([box.url]);
    // A genuinely fresh request still asks for the configured default space.
    await expect(restored.signIn()).rejects.toMatchObject({ code: "node_not_found" });
  });
});

test("a classified encryption registry refusal is not mislabeled as node unresponsiveness", async () => {
  await withScopedClient(async ({ node, refuseEncryption }) => {
    refuseEncryption();
    expect(await node.encryption.discoverNetwork(network)).toMatchObject({
      ok: false, error: { code: "registry_unavailable" },
    });
  });
});

test.each([false, true])("v1-only registration on configured chain137 fails closed at restore (wallet: %s)", async (wallet) => {
  await withScopedClient(async ({ node, useV1OnlyRegistry }) => {
    const saved = node.restorableSession!;
    await useV1OnlyRegistry();
    const restored = restoringClient(wallet, 137);
    await expect(restored.restoreSession({ ...saved, tinycloudHosts: [encryption.url] })).rejects.toMatchObject({
      code: "registry_unavailable", verdict: { reason: "unsupported-format" },
    });
    expect(restored.restorableSession === undefined).toBe(true);
  });
});

test("genuine absence on configured chain137 preserves explicit-host restore onboarding", async () => {
  await withScopedClient(async ({ node, useAbsentRegistry }) => {
    const saved = node.restorableSession!;
    useAbsentRegistry();
    const restored = restoringClient(true, 137);
    await restored.restoreSession({ ...saved, tinycloudHosts: [encryption.url] });
    expect(restored.restorableSession?.spaceId).toBe(saved.spaceId);
    expect(restored.hosts).toEqual([encryption.url]);
  });
});

test("genuine no-entry grants retain explicit deferred versus required activation semantics", async () => {
  await withScopedClient(async ({ node, useAbsentRegistry }) => {
    const saved = node.restorableSession!;
    useAbsentRegistry();
    const restored = restoringClient(true);
    await restored.restoreSession({ ...saved, tinycloudHosts: [encryption.url] });
    const permissions: PermissionEntry[] = [{
      service: "tinycloud.kv", space: saved.spaceId,
      path: "vault/secrets/DUMMY", actions: ["tinycloud.kv/get"], skipPrefix: true,
    }];
    const result = await restored.delegateTo(box.did, permissions, { requireActivation: false });
    expect(result.prompted).toBe(false);
    await expect(restored.delegateTo(box.did, permissions, { requireActivation: true })).rejects.toMatchObject({
      cause: { success: true, skipped: [saved.spaceId] },
    });
  });
});
