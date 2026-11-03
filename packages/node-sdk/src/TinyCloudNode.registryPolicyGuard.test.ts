/**
 * TinyCloudNode hosting paths use the default v2 registry verdict and require
 * the requested full space to be listed before activation.
 */
import { afterEach, expect, test } from "bun:test";
import {
  NodeNotFoundError,
  REGISTRY_NOT_FOUND_BODY,
  RegistryUnavailableError,
  bootstrapSteps,
  pkhDid,
  signLocationRecordV2,
  type ISessionManager,
  type IWasmBindings,
  type LocationRecordV2Payload,
} from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";
import type { NodeUserAuthorization } from "./authorization/NodeUserAuthorization";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";

const ownerKey = new PrivateKeySigner(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const REGISTRY = "https://registry.test";
const HOST = "https://tinycloud.test";
const NODE_DID = "did:key:z6MkixsGj3MVGKMug2VMC2JbtzX3UjaAcfRs7G1RjbSnZJaH";

type RegistrySpace = LocationRecordV2Payload["spaces"][number];
interface V2Answer {
  spaces?: RegistrySpace[];
  nodes?: LocationRecordV2Payload["nodes"];
  encryptionNode?: string | null;
}
type RegistryAnswer = "not-found" | "down" | V2Answer;

interface Owner {
  node: TinyCloudNode;
  address: string;
  spaceId(name: string): string;
  requests: string[];
  hostDelegations: string[];
  signatures: string[];
}

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function spaceId(address: string, name: string): string {
  return `tinycloud:pkh:eip155:1:${address}:${name}`;
}

function sessionSpelling(signedSpace: string, address: string): string {
  const match = /^(tinycloud:pkh:eip155:1:)0x[0-9a-f]{40}(:[^/?#\s]+)$/.exec(signedSpace);
  return match === null ? signedSpace : `${match[1]}${address}${match[2]}`;
}

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
    prepareSession: (params: Record<string, unknown>) => ({ ...params, siwe: "public session siwe" }),
    completeSessionSetup: () => ({
      delegationCid: "bafy-public-session",
      delegationHeader: { Authorization: "Bearer public session" },
    }),
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

function registryPayload(address: string, answer: V2Answer): LocationRecordV2Payload {
  const nodes = answer.nodes ?? [{ did: NODE_DID, url: HOST }];
  const defaultSpaces = bootstrapSteps(address, 1)
    .filter((step) => step.kind === "host")
    .map((step) => step.spaceId.toLowerCase());
  for (const name of ["default", "secrets", "account", "public"]) {
    defaultSpaces.push(spaceId(address, name).toLowerCase());
  }
  const spaces = answer.spaces ?? [...new Set(defaultSpaces)].map((space) => ({
    space,
    nodes: [{ did: nodes[0]!.did, mode: "read-write" as const }],
  }));
  return {
    version: 2,
    subject: pkhDid(address, 1),
    nodes,
    spaces,
    encryptionNode: answer.encryptionNode === undefined ? nodes[0]?.did ?? null : answer.encryptionNode,
    updated_at: "2026-10-18T00:00:00.000Z",
    sequence: 1,
  };
}

async function signedInOwner(registry: RegistryAnswer): Promise<Owner> {
  const address = await ownerKey.getAddress();
  const primarySpaceId = spaceId(address, "default");
  const requests: string[] = [];
  const hostDelegations: string[] = [];
  const signatures: string[] = [];
  const hostedByOrigin = new Map<string, Set<string>>();
  const pendingHostSpace: Record<string, string> = {};
  const original = globalThis.fetch;
  const nodeDidByOrigin: Record<string, string> = { [HOST]: NODE_DID };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    const parsed = new URL(url);
    const v2Prefix = `${REGISTRY}/v2/locations/`;
    if (url.startsWith(v2Prefix)) {
      if (registry === "down") return new Response("down", { status: 503 });
      if (registry === "not-found") return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
      const ownerAddress = decodeURIComponent(url.slice(v2Prefix.length));
      const payload = registryPayload(ownerAddress, registry);
      const record = await signLocationRecordV2(payload, {
        type: "did:pkh",
        signMessage: (message) => ownerKey.signMessage(message),
      });
      for (const space of payload.spaces) {
        for (const membership of space.nodes) {
          const node = payload.nodes.find((candidate) => candidate.did === membership.did);
          if (!node) continue;
          const origin = new URL(node.url).origin;
          const hosted = hostedByOrigin.get(origin) ?? new Set<string>();
          hosted.add(sessionSpelling(space.space, ownerAddress));
          hostedByOrigin.set(origin, hosted);
        }
      }
      return Response.json({ record });
    }
    if (url.startsWith(`${REGISTRY}/v1/locations/`)) {
      return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
    }
    const origin = parsed.origin;
    const nodeDid = nodeDidByOrigin[origin] ?? NODE_DID;
    if (parsed.pathname === "/info") {
      return Response.json({ protocol: 1, version: "1.0.0", features: [], nodeId: nodeDid });
    }
    if (parsed.pathname === "/.well-known/tinycloud/node-keys") {
      return Response.json({ nodeDid, shareInvitationPublicKey: "A".repeat(43) });
    }
    if (parsed.pathname.startsWith("/peer/generate/")) {
      pendingHostSpace[origin] = decodeURIComponent(parsed.pathname.slice("/peer/generate/".length));
      return new Response("peer-id");
    }
    if (parsed.pathname === "/delegate" && init?.method === "POST") {
      const authorization = new Headers(init.headers).get("authorization");
      const hosted = hostedByOrigin.get(origin) ?? new Set<string>();
      if (authorization === "Bearer host") {
        hostDelegations.push(origin);
        hosted.add(pendingHostSpace[origin] ?? primarySpaceId);
        hostedByOrigin.set(origin, hosted);
      }
      return Response.json({
        activated: [...hosted],
        skipped: hosted.has(primarySpaceId) ? [] : [primarySpaceId],
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };

  const node = new TinyCloudNode({
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
  });
  const auth: NodeUserAuthorization = Reflect.get(node, "auth");
  auth.setRestoredTinyCloudSession(
    {
      address,
      chainId: 1,
      sessionKey: "session-key",
      spaceId: primarySpaceId,
      spaces: { public: spaceId(address, "public") },
      delegationCid: "bafy-restored",
      delegationHeader: { Authorization: "Bearer restored" },
      verificationMethod: "did:key:restored#restored",
      jwk: { kty: "OKP", kid: "session-key" },
      siwe: "example.com wants you to sign in...",
      signature: "0xrestored",
    },
    [HOST],
  );
  Reflect.set(node, "_address", address);
  Reflect.set(node, "_chainId", 1);
  Reflect.set(node, "isOwnedSpaceRegistered", async () => false);
  return {
    node,
    address,
    spaceId: (name: string) => spaceId(address, name),
    requests,
    hostDelegations,
    signatures,
  };
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
  ["ensurePublicSpace", (owner) => owner.node.ensurePublicSpace()],
];

for (const [site, create] of sites) {
  test(`${site} uses the signed full-space route and validates node identity before activation`, async () => {
    const owner = await signedInOwner({});

    await create(owner);

    const activation = owner.requests.indexOf(`${HOST}/delegate`);
    expect(owner.requests.some((url) => url.startsWith(`${REGISTRY}/v2/locations/`))).toBe(true);
    expect(owner.requests.some((url) => url.startsWith(`${REGISTRY}/v1/locations/`))).toBe(false);
    expect(owner.requests.indexOf(`${HOST}/info`)).toBeGreaterThanOrEqual(0);
    expect(owner.requests.indexOf(`${HOST}/.well-known/tinycloud/node-keys`)).toBeGreaterThanOrEqual(0);
    expect(owner.requests.indexOf(`${HOST}/info`)).toBeLessThan(activation);
    expect(owner.requests.indexOf(`${HOST}/.well-known/tinycloud/node-keys`)).toBeLessThan(activation);
    expect(owner.hostDelegations).toEqual([]);
    expect(owner.signatures).not.toContain("host siwe");
  });
}

test("a true no-entry result retains host-SIWE onboarding", async () => {
  const owner = await signedInOwner("not-found");

  await owner.node.ensureOwnedSpaceHosted("secrets");

  expect(owner.requests.some((url) => url.startsWith(`${REGISTRY}/v2/locations/`))).toBe(true);
  expect(owner.requests.some((url) => url.startsWith(`${REGISTRY}/v1/locations/`))).toBe(true);
  expect(owner.hostDelegations).toContain(HOST);
  expect(owner.signatures).toContain("host siwe");
});

test("a listed owner node cannot host a full space missing from the signed membership", async () => {
  const address = await ownerKey.getAddress();
  const owner = await signedInOwner({
    spaces: [{
      space: spaceId(address, "default").toLowerCase(),
      nodes: [{ did: NODE_DID, mode: "read-write" }],
    }],
  });

  await expect(owner.node.ensureOwnedSpaceHosted("secrets")).rejects.toBeInstanceOf(NodeNotFoundError);

  expect(owner.requests.some((url) => url === `${HOST}/delegate`)).toBe(false);
  expect(owner.hostDelegations).toEqual([]);
  expect(owner.signatures).not.toContain("host siwe");
});

test("an unavailable registry refuses hosting without using the configured host", async () => {
  const owner = await signedInOwner("down");

  await expect(owner.node.ensureOwnedSpaceHosted("secrets")).rejects.toBeInstanceOf(RegistryUnavailableError);

  expect(owner.requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
  expect(owner.hostDelegations).toEqual([]);
  expect(owner.signatures).not.toContain("host siwe");
});
