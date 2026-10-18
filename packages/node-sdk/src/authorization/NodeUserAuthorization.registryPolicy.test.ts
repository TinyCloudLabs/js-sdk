/**
 * Registry policy at sign-in routing and the space-creation guard (TC-1443).
 *
 * The owner is a real EOA so the fake registry can serve owner-signed records.
 * Every request is recorded: the assertions are about which hosts the SDK
 * talks to and whether a host delegation (space creation) is ever signed.
 */
import { afterEach, expect, test } from "bun:test";
import {
  DEFAULT_TINYCLOUD_FALLBACK_HOST,
  NodeNotFoundError,
  NodeRegistryEntryExistsError,
  REGISTRY_NOT_FOUND_BODY,
  RegistryUnavailableError,
  pkhDid,
  signLocationRecord,
  type ISessionManager,
  type ISigner,
  type IWasmBindings,
  type RegistryPolicy,
  type SpaceCreationContext,
  type TinyCloudSession,
} from "@tinycloud/sdk-core";

import { MemorySessionStorage } from "../storage/MemorySessionStorage";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { NodeUserAuthorization, type NodeUserAuthorizationConfig } from "./NodeUserAuthorization";

// Test-only key.
const ownerKey = new PrivateKeySigner(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const REGISTRY = "https://registry.test";
const HOST = "https://tinycloud.test";
const HOST_MULTIADDR = "/dns4/tinycloud.test/tcp/443/https";
const OTHER_MULTIADDR = "/dns4/elsewhere.example/tcp/443/https";

type RegistryAnswer = "not-found" | "down" | { multiaddrs: string[]; sequence?: number };

interface FakeNetwork {
  requests: string[];
  /** Host delegations submitted, i.e. spaces created. */
  hostDelegations: string[];
  registryLookups(): string[];
}

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

async function ownerAddress(): Promise<string> {
  return ownerKey.getAddress();
}

async function recordBody(subject: string, multiaddrs: string[], sequence: number): Promise<string> {
  const record = await signLocationRecord(
    { version: 1, subject, multiaddrs, updated_at: "2026-10-18T00:00:00.000Z", sequence },
    { type: "did:pkh", signMessage: (message) => ownerKey.signMessage(message) },
  );
  return JSON.stringify({ record });
}

/**
 * Registry plus TinyCloud nodes. The owner's primary space is missing until a
 * host delegation arrives. `answers` are served in order, the last one repeats.
 */
function installNetwork(answers: RegistryAnswer[], primarySpaceId: string): FakeNetwork {
  const network: FakeNetwork = {
    requests: [],
    hostDelegations: [],
    registryLookups: () => network.requests.filter((url) => url.startsWith(`${REGISTRY}/`)),
  };
  const hosted = new Set<string>();
  const original = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    network.requests.push(url);
    if (url.startsWith(`${REGISTRY}/v1/locations/`)) {
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (answer === "not-found") return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
      if (answer === "down") return new Response("down", { status: 503 });
      const subject = decodeURIComponent(url.slice(`${REGISTRY}/v1/locations/`.length));
      return new Response(await recordBody(subject, answer.multiaddrs, answer.sequence ?? 1));
    }
    const origin = new URL(url).origin;
    if (url.includes("/peer/generate/")) return new Response("peer-id");
    if (url.endsWith("/delegate") && init?.method === "POST") {
      const authorization = new Headers(init.headers).get("authorization");
      if (authorization === "Bearer host") {
        network.hostDelegations.push(origin);
        hosted.add(origin);
        return Response.json({ activated: [primarySpaceId], skipped: [] });
      }
      return hosted.has(origin)
        ? Response.json({ activated: [primarySpaceId], skipped: [] })
        : Response.json({ activated: [], skipped: [primarySpaceId] });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return network;
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
      `tinycloud:pkh:eip155:${chainId}:${address}:${prefix}`,
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

/** The owner's wallet, recording every signature it is asked for. */
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
    spaceId: `tinycloud:pkh:eip155:${chainId}:${address}:default`,
    delegationCid: "bafy-restored",
    delegationHeader: { Authorization: "Bearer restored" },
    verificationMethod: "did:key:restored#restored",
    jwk: { kty: "OKP", kid: "session-key" },
    siwe: "example.com wants you to sign in...",
    signature: "0xrestored",
  };
}

interface Scenario {
  policy?: RegistryPolicy;
  registry: RegistryAnswer[];
  /** Pinned host; omit to resolve one at sign-in. */
  host?: string;
  chainId?: number;
  config?: Partial<NodeUserAuthorizationConfig>;
}

async function restoredOwner(scenario: Scenario) {
  const address = await ownerAddress();
  const session = restoredSession(address, scenario.chainId);
  const network = installNetwork([...scenario.registry], session.spaceId);
  const signatures: string[] = [];
  const confirmations: SpaceCreationContext[] = [];
  const failures: Error[] = [];
  const auth = new NodeUserAuthorization({
    signer: wallet(signatures, scenario.chainId),
    wasmBindings: wasmBindings(),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    sessionStorage: new MemorySessionStorage(),
    tinycloudRegistryUrl: REGISTRY,
    autoDiscoverLocalNode: false,
    ...(scenario.host === undefined ? {} : { tinycloudHosts: [scenario.host] }),
    ...(scenario.policy === undefined ? {} : { registryPolicy: scenario.policy }),
    spaceCreationHandler: {
      confirmSpaceCreation: async (context) => {
        confirmations.push(context);
        return true;
      },
      onSpaceCreationFailed: (_context, error) => {
        failures.push(error);
      },
    },
    ...scenario.config,
  });
  auth.setRestoredTinyCloudSession(session);
  return { auth, address, network, signatures, confirmations, failures };
}

test("default policy: an unregistered owner still falls back and gets a space, with one registry lookup", async () => {
  const owner = await restoredOwner({ registry: ["not-found"] });

  await owner.auth.ensureSpaceExists();

  expect(owner.auth.hosts).toEqual([DEFAULT_TINYCLOUD_FALLBACK_HOST]);
  expect(owner.network.hostDelegations).toEqual([DEFAULT_TINYCLOUD_FALLBACK_HOST]);
  expect(owner.network.registryLookups()).toEqual([
    `${REGISTRY}/v1/locations/${encodeURIComponent(pkhDid(owner.address, 1))}`,
  ]);
});

test("default policy: a pinned host creates spaces with no registry lookup at all", async () => {
  // Registered elsewhere, but the default policy never consults the registry here.
  const owner = await restoredOwner({ registry: [{ multiaddrs: [OTHER_MULTIADDR] }], host: HOST });

  await owner.auth.ensureSpaceExists();

  expect(owner.network.hostDelegations).toEqual([HOST]);
  expect(owner.network.registryLookups()).toEqual([]);
});

test("fail-closed: routing looks up the signer address on the configured chain, never the session chain", async () => {
  const owner = await restoredOwner({
    policy: "fail-closed",
    registry: [{ multiaddrs: [HOST_MULTIADDR] }],
    chainId: 137,
  });

  await owner.auth.ensureSpaceExists();

  expect(owner.network.registryLookups()).toEqual([
    `${REGISTRY}/v1/locations/${encodeURIComponent(pkhDid(owner.address, 1))}`,
  ]);
  expect(owner.auth.hosts).toEqual([HOST]);
  // The record lists the host, so creation went ahead after confirmation, reusing the sign-in verdict.
  expect(owner.confirmations).toHaveLength(1);
  expect(owner.network.hostDelegations).toEqual([HOST]);
});

test("fail-closed: an unregistered owner goes to newUserHost and may create a space there", async () => {
  const owner = await restoredOwner({
    policy: "fail-closed",
    registry: ["not-found"],
    config: { newUserHost: HOST },
  });

  await owner.auth.ensureSpaceExists();

  expect(owner.auth.hosts).toEqual([HOST]);
  expect(owner.network.hostDelegations).toEqual([HOST]);
});

test("fail-closed: an unavailable registry fails sign-in instead of using any host", async () => {
  const owner = await restoredOwner({ policy: "fail-closed", registry: ["down"] });

  await expect(owner.auth.ensureSpaceExists()).rejects.toBeInstanceOf(RegistryUnavailableError);

  expect(owner.network.requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
  expect(owner.signatures).toEqual([]);
});

test("fail-closed: a registered owner whose record lists no usable host gets NodeNotFoundError", async () => {
  const owner = await restoredOwner({ policy: "fail-closed", registry: [{ multiaddrs: [] }] });

  await expect(owner.auth.ensureSpaceExists()).rejects.toBeInstanceOf(NodeNotFoundError);

  expect(owner.network.requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
});

test("fail-closed: a plaintext host from a signed record is used neither for routing nor for creation", async () => {
  const plaintext = "/dns4/plain.example/tcp/80/http";
  const routed = await restoredOwner({ policy: "fail-closed", registry: [{ multiaddrs: [plaintext] }] });

  await expect(routed.auth.ensureSpaceExists()).rejects.toBeInstanceOf(NodeNotFoundError);
  expect(routed.network.requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
  restoreFetch?.();

  const pinned = await restoredOwner({
    policy: "fail-closed",
    registry: [{ multiaddrs: [plaintext] }],
    host: "http://plain.example",
  });
  await expect(pinned.auth.ensureSpaceExists()).rejects.toBeInstanceOf(NodeRegistryEntryExistsError);
  expect(pinned.network.hostDelegations).toEqual([]);
  expect(pinned.signatures).toEqual([]);
});

test("fail-closed: onNodeNotFound can retry the lookup", async () => {
  const attempts: number[] = [];
  const owner = await restoredOwner({
    policy: "fail-closed",
    registry: ["down", { multiaddrs: [HOST_MULTIADDR] }],
    config: {
      onNodeNotFound: ({ attempt }) => {
        attempts.push(attempt);
        return { action: "retry" };
      },
    },
  });

  await owner.auth.ensureSpaceExists();

  expect(attempts).toEqual([1]);
  expect(owner.auth.hosts).toEqual([HOST]);
  expect(owner.network.hostDelegations).toEqual([HOST]);
});

test("fail-closed: onNodeNotFound can connect to another host, where creation is still guarded", async () => {
  const owner = await restoredOwner({
    policy: "fail-closed",
    registry: ["down"],
    config: { onNodeNotFound: () => ({ action: "use-host", host: HOST }) },
  });

  await expect(owner.auth.ensureSpaceExists()).rejects.toBeInstanceOf(RegistryUnavailableError);

  expect(owner.auth.hosts).toEqual([HOST]);
  expect(owner.failures[0]).toBeInstanceOf(RegistryUnavailableError);
  expect(owner.confirmations).toEqual([]);
  expect(owner.network.hostDelegations).toEqual([]);
  expect(owner.signatures).toEqual([]);
});

test("fail-closed: onNodeNotFound can abort", async () => {
  const owner = await restoredOwner({
    policy: "fail-closed",
    registry: ["not-found"],
    config: { newUserHost: null, onNodeNotFound: () => ({ action: "abort" }) },
  });

  await expect(owner.auth.ensureSpaceExists()).rejects.toBeInstanceOf(NodeNotFoundError);
  expect(owner.network.requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
});

for (const [label, activation] of [
  ["a skipped primary space", "skipped"],
  ["an older node's 404", "404"],
] as const) {
  test(`fail-closed guard on ensureSpaceExists (${label}): pinned host vs. registry verdict`, async () => {
    const cases: Array<{
      registry: RegistryAnswer;
      refusal?: typeof NodeRegistryEntryExistsError | typeof RegistryUnavailableError;
    }> = [
      { registry: "not-found" },
      { registry: { multiaddrs: [HOST_MULTIADDR] } },
      { registry: { multiaddrs: [OTHER_MULTIADDR] }, refusal: NodeRegistryEntryExistsError },
      { registry: { multiaddrs: [] }, refusal: NodeRegistryEntryExistsError },
      { registry: "down", refusal: RegistryUnavailableError },
    ];
    for (const { registry, refusal } of cases) {
      const owner = await restoredOwner({ policy: "fail-closed", registry: [registry], host: HOST });
      if (activation === "404") {
        const fakeNode = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
          String(input) === `${HOST}/delegate` &&
          new Headers(init?.headers).get("authorization") === "Bearer restored" &&
          owner.network.hostDelegations.length === 0
            ? new Response("not found", { status: 404 })
            : fakeNode(input, init)) as typeof fetch;
      }

      if (refusal) {
        await expect(owner.auth.ensureSpaceExists()).rejects.toBeInstanceOf(refusal);
        expect(owner.failures[0]).toBeInstanceOf(refusal);
        expect(owner.confirmations).toEqual([]);
        expect(owner.network.hostDelegations).toEqual([]);
        expect(owner.signatures).toEqual([]);
      } else {
        await owner.auth.ensureSpaceExists();
        expect(owner.network.hostDelegations).toEqual([HOST]);
      }
      // Pinned hosts look the verdict up lazily, once, at creation time.
      expect(owner.network.registryLookups()).toHaveLength(1);
      restoreFetch?.();
    }
  });
}
