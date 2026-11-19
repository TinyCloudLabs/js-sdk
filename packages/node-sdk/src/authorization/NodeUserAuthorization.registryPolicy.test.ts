import { HOST_SIWE } from "../test-support/host-siwe";
/**
 * Default registry-first routing at sign-in and space hosting.
 *
 * The owner is a real EOA so each fixture serves a signed v2 location record.
 * Host identity and node-key endpoints are recorded before any activation.
 */
import { afterEach, expect, test } from "bun:test";
import {
  DEFAULT_TINYCLOUD_FALLBACK_HOST,
  NodeNotFoundError,
  REGISTRY_NOT_FOUND_BODY,
  RegistryUnavailableError,
  pkhDid,
  createInMemoryRegistrySequenceStore,
  signLocationRecord,
  signLocationRecordV2,
  type ISessionManager,
  type ISigner,
  type IWasmBindings,
  type LocationRecordV2Payload,
  type TinyCloudSession,
} from "@tinycloud/sdk-core";

import { MemorySessionStorage } from "../storage/MemorySessionStorage";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { NodeUserAuthorization, type NodeUserAuthorizationConfig } from "./NodeUserAuthorization";

const ownerKey = new PrivateKeySigner(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const REGISTRY = "https://registry.test";
const HOST = "https://tinycloud.test";
const OTHER_HOST = "https://elsewhere.example";
const STALE_HOST = "https://stale.example";
const HOST_NODE_DID = "did:key:z6MkixsGj3MVGKMug2VMC2JbtzX3UjaAcfRs7G1RjbSnZJaH";
const OTHER_NODE_DID = "did:key:z6MkjkxcrsuBXGxVYAZFC1hPUViiRXLC5Kup4G9aBkFoPimV";

type RegistryNode = { did: string; url: string };
type RegistrySpace = {
  space: string;
  nodes: Array<{ did: string; mode: "read-write" | "read-only" }>;
};
interface V2Answer {
  nodes?: RegistryNode[];
  spaces?: RegistrySpace[];
  encryptionNode?: string | null;
  sequence?: number;
}
type RegistryAnswer = "not-found" | "down" | "v1-only" | V2Answer;

interface FakeNetwork {
  requests: string[];
  hostDelegations: string[];
  v2Lookups(): string[];
  v1Lookups(): string[];
}

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function spaceId(address: string, chainId: number, name: string): string {
  return `tinycloud:pkh:eip155:${chainId}:${address}:${name}`;
}

function signedSpaceId(spaceIdValue: string): string {
  return spaceIdValue.toLowerCase();
}

function sessionSpelling(signedSpace: string, address: string): string {
  const match = /^(tinycloud:pkh:eip155:[1-9][0-9]*:)0x[0-9a-f]{40}(:[^/?#\s]+)$/.exec(signedSpace);
  return match === null ? signedSpace : `${match[1]}${address}${match[2]}`;
}

function wasmBindings(): IWasmBindings {
  const sessionManager: ISessionManager = {
    createSessionKey: (id: string) => id,
    replaceSessionKey: (_jwk: object, keyId: string) => keyId,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", kid: "session-key" }),
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
    makeSpaceId: (address: string, chainId: number, prefix: string) =>
      spaceId(address, chainId, prefix),
    createDelegation: async () => {
      throw new Error("not used");
    },
    generateHostSIWEMessage: () => HOST_SIWE,
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

function wallet(signatures: string[], chainId = 1): ISigner {
  return {
    getAddress: () => ownerKey.getAddress(),
    getChainId: async () => chainId,
    signMessage: async (message: string) => {
      signatures.push(message);
      return "0xsigned";
    },
  };
}

function restoredSession(address: string, chainId = 1): TinyCloudSession {
  return {
    address,
    chainId,
    sessionKey: "session-key",
    spaceId: spaceId(address, chainId, "default"),
    delegationCid: "bafy-restored",
    delegationHeader: { Authorization: "Bearer restored" },
    verificationMethod: "did:key:restored#restored",
    jwk: { kty: "OKP", kid: "session-key" },
    siwe: "example.com wants you to sign in...",
    signature: "0xrestored",
  };
}

function signedV2Payload(
  subject: string,
  primarySpaceId: string,
  answer: V2Answer,
): LocationRecordV2Payload {
  const nodes = answer.nodes ?? [{ did: HOST_NODE_DID, url: HOST }];
  const spaces = answer.spaces ?? (nodes[0] === undefined
    ? []
    : [{
      space: signedSpaceId(primarySpaceId),
      nodes: [{ did: nodes[0].did, mode: "read-write" as const }],
    }]);
  const encryptionNode = answer.encryptionNode === undefined
    ? nodes[0]?.did ?? null
    : answer.encryptionNode;
  return {
    version: 2,
    subject,
    nodes,
    spaces,
    encryptionNode,
    updated_at: "2026-10-18T00:00:00.000Z",
    sequence: answer.sequence ?? 1,
  };
}

interface Scenario {
  registry: RegistryAnswer[];
  host?: string;
  persistedHosts?: string[];
  chainId?: number;
  sessionActivation?: "skipped" | "not-found";
  config?: Partial<NodeUserAuthorizationConfig>;
}

async function restoredOwner(scenario: Scenario) {
  const address = await ownerKey.getAddress();
  const chainId = scenario.chainId ?? 1;
  const session = restoredSession(address, chainId);
  const primarySpaceId = session.spaceId;
  const answers = [...scenario.registry];
  const network: FakeNetwork = {
    requests: [],
    hostDelegations: [],
    v2Lookups: () => network.requests.filter((url) => url.startsWith(`${REGISTRY}/v2/locations/`)),
    v1Lookups: () => network.requests.filter((url) => url.startsWith(`${REGISTRY}/v1/locations/`)),
  };
  const hostedByOrigin = new Map<string, Set<string>>();
  const identityByOrigin: Record<string, string> = {
    [HOST]: HOST_NODE_DID,
    [OTHER_HOST]: OTHER_NODE_DID,
  };
  const original = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    network.requests.push(url);
    const v2Prefix = `${REGISTRY}/v2/locations/`;
    if (url.startsWith(v2Prefix)) {
      const answer = answers.length > 1 ? answers.shift()! : answers[0] ?? "not-found";
      if (answer === "down") return new Response("down", { status: 503 });
      if (answer === "not-found" || answer === "v1-only") {
        return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
      }
      const registryAddress = decodeURIComponent(url.slice(v2Prefix.length));
      const payload = signedV2Payload(pkhDid(registryAddress, 1), primarySpaceId, answer);
      const record = await signLocationRecordV2(payload, {
        type: "did:pkh",
        signMessage: (message) => ownerKey.signMessage(message),
      });
      for (const signedSpace of payload.spaces) {
        for (const membership of signedSpace.nodes) {
          const node = payload.nodes.find((candidate) => candidate.did === membership.did);
          if (!node) continue;
          const origin = new URL(node.url).origin;
          const hosted = hostedByOrigin.get(origin) ?? new Set<string>();
          hosted.add(sessionSpelling(signedSpace.space, address));
          hostedByOrigin.set(origin, hosted);
        }
      }
      return Response.json({ record });
    }
    const v1Prefix = `${REGISTRY}/v1/locations/`;
    if (url.startsWith(v1Prefix)) {
      const answer = answers[0] ?? "not-found";
      if (answer === "down") return new Response("down", { status: 503 });
      if (answer !== "v1-only") return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
      const subject = decodeURIComponent(url.slice(v1Prefix.length));
      const record = await signLocationRecord(
        {
          version: 1,
          subject,
          multiaddrs: ["/dns4/stale.example/tcp/443/https"],
          updated_at: "2026-10-18T00:00:00.000Z",
          sequence: 1,
        },
        { type: "did:pkh", signMessage: (message) => ownerKey.signMessage(message) },
      );
      return Response.json({ record });
    }

    const parsed = new URL(url);
    const origin = parsed.origin;
    const nodeDid = identityByOrigin[origin] ?? HOST_NODE_DID;
    if (parsed.pathname === "/info") {
      return Response.json({ protocol: 1, version: "1.0.0", features: [], nodeId: nodeDid });
    }
    if (parsed.pathname === "/.well-known/tinycloud/node-keys") {
      return Response.json({ nodeDid, shareInvitationPublicKey: "A".repeat(43) });
    }
    if (parsed.pathname.startsWith("/peer/generate/")) return new Response("peer-id");
    if (parsed.pathname === "/delegate" && init?.method === "POST") {
      const authorization = new Headers(init.headers).get("authorization");
      const hosted = hostedByOrigin.get(origin) ?? new Set<string>();
      if (authorization === "Bearer host") {
        network.hostDelegations.push(origin);
        hosted.add(primarySpaceId);
        hostedByOrigin.set(origin, hosted);
        return Response.json({ activated: [...hosted], skipped: [] });
      }
      if (scenario.sessionActivation === "not-found") {
        return new Response("not found", { status: 404 });
      }
      if (scenario.sessionActivation === "skipped") {
        return Response.json({ activated: [], skipped: [primarySpaceId] });
      }
      return hosted.has(primarySpaceId)
        ? Response.json({ activated: [...hosted], skipped: [] })
        : Response.json({ activated: [], skipped: [primarySpaceId] });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const signatures: string[] = [];
  const auth = new NodeUserAuthorization({
    signer: wallet(signatures, chainId),
    wasmBindings: wasmBindings(),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    sessionStorage: new MemorySessionStorage(),
    tinycloudRegistryUrl: REGISTRY,
    autoDiscoverLocalNode: false,
    ...(scenario.host === undefined ? {} : { tinycloudHosts: [scenario.host] }),
    spaceCreationHandler: {
      confirmSpaceCreation: async () => true,
      onSpaceCreationFailed: () => {},
    },
    ...scenario.config,
  });
  auth.setRestoredTinyCloudSession(session, scenario.persistedHosts);
  return {
    auth,
    address,
    spaceId: (name: string) => spaceId(address, chainId, name),
    network,
    signatures,
  };
}

test("default routing uses signed full-space membership and verifies both node identity surfaces", async () => {
  const owner = await restoredOwner({
    chainId: 137,
    host: STALE_HOST,
    persistedHosts: [STALE_HOST],
    registry: [{
      nodes: [
        { did: HOST_NODE_DID, url: HOST },
        { did: OTHER_NODE_DID, url: OTHER_HOST },
      ],
      spaces: [{
        space: signedSpaceId(spaceId(await ownerKey.getAddress(), 137, "default")),
        nodes: [
          { did: HOST_NODE_DID, mode: "read-write" },
          { did: OTHER_NODE_DID, mode: "read-write" },
        ],
      }],
      encryptionNode: OTHER_NODE_DID,
    }],
  });

  await owner.auth.ensureSpaceExists();

  const hostActivation = owner.network.requests.indexOf(`${HOST}/delegate`);
  const replicaActivation = owner.network.requests.indexOf(`${OTHER_HOST}/delegate`);
  expect(owner.auth.hosts).toEqual([HOST, OTHER_HOST]);
  expect(owner.network.v2Lookups()).toContain(
    `${REGISTRY}/v2/locations/${encodeURIComponent(owner.address)}`,
  );
  expect(owner.network.v1Lookups()).toEqual([]);
  for (const [url, activation] of [
    [`${HOST}/info`, hostActivation],
    [`${HOST}/.well-known/tinycloud/node-keys`, hostActivation],
    [`${OTHER_HOST}/info`, replicaActivation],
    [`${OTHER_HOST}/.well-known/tinycloud/node-keys`, replicaActivation],
  ] as const) {
    expect(owner.network.requests.indexOf(url)).toBeGreaterThanOrEqual(0);
    expect(owner.network.requests.indexOf(url)).toBeLessThan(activation);
  }
  expect(owner.network.requests.some((url) => url.startsWith(`${STALE_HOST}/`))).toBe(false);
  expect(owner.signatures).toEqual([]);
  expect(owner.network.hostDelegations).toEqual([]);
});

test("true absence in v2 and v1 keeps default onboarding and host-SIWE creation", async () => {
  const owner = await restoredOwner({ registry: ["not-found"] });

  await owner.auth.ensureSpaceExists();

  expect(owner.auth.hosts).toEqual([DEFAULT_TINYCLOUD_FALLBACK_HOST]);
  expect(owner.network.v2Lookups().length).toBeGreaterThan(0);
  expect(owner.network.v1Lookups().length).toBeGreaterThan(0);
  expect(owner.network.hostDelegations).toContain(DEFAULT_TINYCLOUD_FALLBACK_HOST);
  expect(owner.signatures.length).toBeGreaterThan(0);
});

test("true absence uses the explicit host hint only after both registry namespaces return not-found", async () => {
  const owner = await restoredOwner({ registry: ["not-found"], host: HOST });

  await owner.auth.ensureSpaceExists();

  expect(owner.auth.hosts).toEqual([HOST]);
  expect(owner.network.v2Lookups().length).toBeGreaterThan(0);
  expect(owner.network.v1Lookups().length).toBeGreaterThan(0);
  expect(owner.network.hostDelegations).toContain(HOST);
  expect(owner.signatures.length).toBeGreaterThan(0);
});

test("a v1-only entry is unavailable and cannot use explicit or persisted stale hosts", async () => {
  const owner = await restoredOwner({
    registry: ["v1-only"],
    host: STALE_HOST,
    persistedHosts: [STALE_HOST],
  });

  await expect(owner.auth.ensureSpaceExists()).rejects.toBeInstanceOf(RegistryUnavailableError);

  expect(owner.network.v2Lookups().length).toBeGreaterThan(0);
  expect(owner.network.v1Lookups().length).toBeGreaterThan(0);
  expect(owner.network.requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
  expect(owner.network.hostDelegations).toEqual([]);
  expect(owner.signatures).toEqual([]);
});

test("a known-owner registry outage cannot be bypassed with use-host", async () => {
  const sequenceStore = createInMemoryRegistrySequenceStore();
  await sequenceStore.set(await ownerKey.getAddress(), 0);
  const owner = await restoredOwner({
    registry: ["down"],
    host: STALE_HOST,
    persistedHosts: [STALE_HOST],
    config: { registrySequenceStore: sequenceStore, onNodeNotFound: () => ({ action: "use-host", host: HOST }) },
  });

  await expect(owner.auth.ensureSpaceExists()).rejects.toBeInstanceOf(RegistryUnavailableError);

  expect(owner.network.requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
  expect(owner.network.hostDelegations).toEqual([]);
  expect(owner.signatures).toEqual([]);
});

test("a known-owner unavailable callback can retry and resolve the current signed route", async () => {
  const attempts: number[] = [];
  const address = await ownerKey.getAddress();
  const defaultSpace = spaceId(address, 1, "default");
  const sequenceStore = createInMemoryRegistrySequenceStore();
  await sequenceStore.set(address, 0);
  const owner = await restoredOwner({
    registry: [
      "down",
      {
        nodes: [{ did: HOST_NODE_DID, url: HOST }],
        spaces: [{ space: signedSpaceId(defaultSpace), nodes: [{ did: HOST_NODE_DID, mode: "read-write" }] }],
      },
    ],
    config: {
      registrySequenceStore: sequenceStore,
      onNodeNotFound: ({ attempt }) => {
        attempts.push(attempt);
        return { action: "retry" };
      },
    },
  });

  await owner.auth.ensureSpaceExists();

  expect(attempts).toEqual([1]);
  expect(owner.auth.hosts).toEqual([HOST]);
  expect(owner.network.v2Lookups().length).toBeGreaterThan(1);
  expect(owner.signatures).toEqual([]);
});

test("registered resources without exact full-space membership are not routed for hosting or writes", async () => {
  const address = await ownerKey.getAddress();
  const defaultSpace = spaceId(address, 1, "default");
  const owner = await restoredOwner({
    registry: [{
      nodes: [{ did: HOST_NODE_DID, url: HOST }],
      spaces: [{
        space: signedSpaceId(defaultSpace),
        nodes: [{ did: HOST_NODE_DID, mode: "read-only" }],
      }],
    }],
    host: HOST,
  });

  await expect(owner.auth.resolveResourceDestinations(owner.spaceId("secrets"), "host"))
    .rejects.toBeInstanceOf(NodeNotFoundError);
  await expect(owner.auth.resolveResourceDestinations(defaultSpace, "write"))
    .rejects.toBeInstanceOf(NodeNotFoundError);
  expect(owner.network.hostDelegations).toEqual([]);
  expect(owner.signatures).toEqual([]);
});

test("a registered primary activation failure does not fall back to host-SIWE approval", async () => {
  const address = await ownerKey.getAddress();
  const defaultSpace = spaceId(address, 1, "default");
  const owner = await restoredOwner({
    registry: [{
      nodes: [{ did: HOST_NODE_DID, url: HOST }],
      spaces: [{ space: signedSpaceId(defaultSpace), nodes: [{ did: HOST_NODE_DID, mode: "read-write" }] }],
    }],
    host: HOST,
    sessionActivation: "skipped",
  });

  await expect(owner.auth.ensureSpaceExists()).rejects.toThrow();

  expect(owner.network.hostDelegations).toEqual([]);
  expect(owner.signatures).toEqual([]);
});

test("a registered 404 activation does not fall back to host-SIWE approval", async () => {
  const address = await ownerKey.getAddress();
  const defaultSpace = spaceId(address, 1, "default");
  const owner = await restoredOwner({
    registry: [{
      nodes: [{ did: HOST_NODE_DID, url: HOST }],
      spaces: [{ space: signedSpaceId(defaultSpace), nodes: [{ did: HOST_NODE_DID, mode: "read-write" }] }],
    }],
    host: HOST,
    sessionActivation: "not-found",
  });

  await expect(owner.auth.ensureSpaceExists()).rejects.toThrow();

  expect(owner.network.hostDelegations).toEqual([]);
  expect(owner.signatures).toEqual([]);
});
