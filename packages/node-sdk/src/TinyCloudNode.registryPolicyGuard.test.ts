/**
 * The space-creation guard at TinyCloudNode's automatic hosting paths (TC-1443):
 * account bootstrap, `ensureOwnedSpaceHostedById` (sign-in's secrets space,
 * the account registry) and `ensureOwnedSpaceHosted`.
 *
 * The owner is a real EOA so the fake registry serves owner-signed records.
 * A host delegation reaching the node is a created space.
 */
import { afterEach, expect, test } from "bun:test";
import {
  NodeRegistryEntryExistsError,
  REGISTRY_NOT_FOUND_BODY,
  RegistryUnavailableError,
  bootstrapSteps,
  signLocationRecord,
  type ISessionManager,
  type IWasmBindings,
  type RegistryPolicy,
} from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";
import type { NodeUserAuthorization } from "./authorization/NodeUserAuthorization";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";

// Test-only key.
const ownerKey = new PrivateKeySigner(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const REGISTRY = "https://registry.test";
const HOST = "https://tinycloud.test";

type RegistryAnswer = "not-found" | "down" | { multiaddrs: string[] };

interface Owner {
  node: TinyCloudNode;
  address: string;
  spaceId(name: string): string;
  hostDelegations: string[];
  registryLookups: string[];
  signatures: string[];
}

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function wasmBindings(): IWasmBindings {
  const sessionManager: ISessionManager = {
    createSessionKey: (id: string) => id,
    replaceSessionKey: (_jwk: object, keyId: string) => keyId,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
  return {
    invoke: async () => undefined,
    prepareSession: () => {
      throw new Error("not used");
    },
    completeSessionSetup: () => {
      throw new Error("not used");
    },
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    createDelegation: async () => {
      throw new Error("not used");
    },
    generateHostSIWEMessage: () => "host siwe",
    siweToDelegationHeaders: () => ({ Authorization: "Bearer host" }),
    protocolVersion: () => 1,
    vault_encrypt: () => new Uint8Array(),
    vault_decrypt: () => new Uint8Array(),
    vault_derive_key: () => new Uint8Array(),
    vault_x25519_from_seed: () => ({ publicKey: new Uint8Array(), privateKey: new Uint8Array() }),
    vault_x25519_dh: () => new Uint8Array(),
    vault_random_bytes: () => new Uint8Array(),
    vault_sha256: () => new Uint8Array(),
    createSessionManager: () => sessionManager,
  };
}

/** A signed-in owner on HOST whose owned spaces do not exist until a host delegation arrives. */
async function signedInOwner(policy: RegistryPolicy | undefined, registry: RegistryAnswer): Promise<Owner> {
  const address = await ownerKey.getAddress();
  const spaceId = (name: string) => `tinycloud:pkh:eip155:1:${address}:${name}`;
  const signatures: string[] = [];
  const owner: Owner = {
    node: new TinyCloudNode({
      host: HOST,
      signer: {
        getAddress: () => ownerKey.getAddress(),
        getChainId: async () => 1,
        signMessage: async (message: string) => {
          signatures.push(message);
          return "0xsigned";
        },
      },
      wasmBindings: wasmBindings(),
      tinycloudRegistryUrl: REGISTRY,
      autoDiscoverLocalNode: false,
      ...(policy === undefined ? {} : { registryPolicy: policy }),
    }),
    address,
    spaceId,
    hostDelegations: [],
    registryLookups: [],
    signatures,
  };

  const hosted = new Set<string>();
  const original = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${REGISTRY}/v1/locations/`)) {
      owner.registryLookups.push(url);
      if (registry === "not-found") return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
      if (registry === "down") return new Response("down", { status: 503 });
      const subject = decodeURIComponent(url.slice(`${REGISTRY}/v1/locations/`.length));
      const record = await signLocationRecord(
        { version: 1, subject, multiaddrs: registry.multiaddrs, updated_at: "2026-10-18T00:00:00.000Z", sequence: 1 },
        { type: "did:pkh", signMessage: (message) => ownerKey.signMessage(message) },
      );
      return Response.json({ record });
    }
    const peer = /\/peer\/generate\/(.+)$/.exec(url);
    if (peer) {
      hosted.add(decodeURIComponent(peer[1]!));
      return new Response("peer-id");
    }
    if (url === `${HOST}/delegate` && init?.method === "POST") {
      if (new Headers(init.headers).get("authorization") === "Bearer host") {
        owner.hostDelegations.push(HOST);
        return Response.json({ activated: [...hosted], skipped: [] });
      }
      const missing = ["default", "secrets", "account"].map(spaceId).filter((id) => !hosted.has(id));
      return Response.json({ activated: [], skipped: missing });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const auth: NodeUserAuthorization = Reflect.get(owner.node, "auth");
  auth.setRestoredTinyCloudSession(
    {
      address,
      chainId: 1,
      sessionKey: "session-key",
      spaceId: spaceId("default"),
      spaces: { public: spaceId("public") },
      delegationCid: "bafy-restored",
      delegationHeader: { Authorization: "Bearer restored" },
      verificationMethod: "did:key:restored#restored",
      jwk: { kty: "OKP", kid: "session-key" },
      siwe: "example.com wants you to sign in...",
      signature: "0xrestored",
    },
    [HOST],
  );
  Reflect.set(owner.node, "_address", address);
  Reflect.set(owner.node, "_chainId", 1);
  // Not under test: the account-registry lookup that can short-circuit hosting.
  Reflect.set(owner.node, "isOwnedSpaceRegistered", async () => false);
  return owner;
}

const sites: Array<[string, (owner: Owner) => Promise<unknown>]> = [
  [
    "account bootstrap",
    (owner) =>
      Reflect.get(owner.node, "runAccountBootstrap").call(
        owner.node,
        bootstrapSteps(owner.address, 1).filter((step) => step.kind === "host"),
      ),
  ],
  [
    "ensureOwnedSpaceHostedById",
    (owner) => Reflect.get(owner.node, "ensureOwnedSpaceHostedById").call(owner.node, owner.spaceId("secrets")),
  ],
  ["ensureOwnedSpaceHosted", (owner) => owner.node.ensureOwnedSpaceHosted("secrets")],
  [
    // The vault's unlock path. Only the host delegation is under test, not the
    // session delegation for the public space that follows it.
    "ensurePublicSpace",
    async (owner) => {
      try {
        await owner.node.ensurePublicSpace();
      } catch (error) {
        if (error instanceof NodeRegistryEntryExistsError || error instanceof RegistryUnavailableError) throw error;
      }
    },
  ],
];

for (const [site, create] of sites) {
  test(`${site}: the default policy creates spaces without consulting the registry`, async () => {
    const owner = await signedInOwner(undefined, { multiaddrs: ["/dns4/elsewhere.example/tcp/443/https"] });

    await create(owner);

    expect(owner.hostDelegations.length).toBeGreaterThan(0);
    expect(owner.registryLookups).toEqual([]);
  });

  test(`${site}: fail-closed creates spaces for an unregistered owner or on a listed host`, async () => {
    for (const registry of ["not-found", { multiaddrs: ["/dns4/tinycloud.test/tcp/443/https"] }] as const) {
      const owner = await signedInOwner("fail-closed", registry);

      await create(owner);

      expect(owner.hostDelegations.length).toBeGreaterThan(0);
      restoreFetch?.();
    }
  });

  test(`${site}: fail-closed refuses a host the owner's record does not list, or an unavailable registry`, async () => {
    for (const [registry, refusal] of [
      [{ multiaddrs: ["/dns4/elsewhere.example/tcp/443/https"] }, NodeRegistryEntryExistsError],
      [{ multiaddrs: [] }, NodeRegistryEntryExistsError],
      ["down", RegistryUnavailableError],
    ] as const) {
      const owner = await signedInOwner("fail-closed", registry);

      await expect(create(owner)).rejects.toBeInstanceOf(refusal);

      expect(owner.hostDelegations).toEqual([]);
      expect(owner.signatures).toEqual([]);
      expect(owner.registryLookups).toHaveLength(1);
      restoreFetch?.();
    }
  });
}
