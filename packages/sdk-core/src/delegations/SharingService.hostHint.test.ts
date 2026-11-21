import { describe, expect, mock, test } from "bun:test";
import type { ResourceTransport, ServiceSession } from "@tinycloud/sdk-services";
import { bases } from "multiformats/basics";
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { CapabilityKeyRegistry } from "../authorization/CapabilityKeyRegistry";
import type { SharePlacement } from "../share-placement";
import { SharingService, type EncodedShareData, type SharingServiceConfig } from "./SharingService";
import type { CreateDelegationWasmParams, KeyProvider } from "./types";

const OWNER = "0xd559CCd9EB87c530A9a349262669386dE93cf412";
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:applications`;
const LINK_HOST = "https://link-host.example";
const PATH = "xyz.tinycloud.artifacts/artifacts/listen-import";
const PARENT_EXPIRY = new Date("2099-07-18T00:00:00.000Z");
const SHARE_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const SHARE_PUBLIC_KEY = ed25519.getPublicKey(SHARE_PRIVATE_KEY);
const SHARE_DID = `did:key:${bases.base58btc.encode(Uint8Array.from([0xed, 0x01, ...SHARE_PUBLIC_KEY]))}`;
const PARENT_SEED = new Uint8Array(32).fill(19);
const PARENT_PUBLIC = ed25519.getPublicKey(PARENT_SEED);
const PARENT_DID = `did:key:${bases.base58btc.encode(Uint8Array.from([0xed, 0x01, ...PARENT_PUBLIC]))}`;
const parentHeader = Buffer.from(JSON.stringify({
  alg: "EdDSA", typ: "JWT", ucv: "0.10.0",
  jwk: { kty: "OKP", crv: "Ed25519", x: Buffer.from(PARENT_PUBLIC).toString("base64url") },
})).toString("base64url");
const parentPayload = Buffer.from(JSON.stringify({
  iss: PARENT_DID, aud: SHARE_DID, exp: PARENT_EXPIRY.getTime() / 1000, prf: [],
  att: { [`${SPACE}/kv/`]: { "tinycloud.kv/*": [{}] } },
})).toString("base64url");
const parentSigningInput = `${parentHeader}.${parentPayload}`;
const PARENT_AUTHORIZATION = `${parentSigningInput}.${Buffer.from(ed25519.sign(new TextEncoder().encode(parentSigningInput), PARENT_SEED)).toString("base64url")}`;
const PARENT_CID = CID.createV1(0x55, createDigest(0x1e, blake3(new TextEncoder().encode(PARENT_AUTHORIZATION)))).toString();

const PLACEMENT: SharePlacement = {
  type: "tinycloud/share-placement/v1", ownerDid: `did:pkh:eip155:1:${OWNER}`, parentCid: PARENT_CID, spaceId: SPACE,
  nodeDid: "did:key:z6MkPlacedNode", nodeUrl: "https://placed.example",
  issuedAt: "2026-01-01T00:00:00.000Z", notAfter: "2099-01-01T00:00:00.000Z", signature: `0x${"00".repeat(65)}`,
};

const transportNamed = (label: string): ResourceTransport => async () => {
  throw new Error(`${label} transport must not be called`);
};
const acceptingTransport: ResourceTransport = async (_resources, send) => send({
  url: LINK_HOST, nodeDid: SHARE_DID, nodeInfo: { nodeId: SHARE_DID },
  fetch: async () => new Response(null, { status: 200 }), bindAudience: async (authorization) => authorization,
});

const SESSION: ServiceSession = {
  delegationHeader: { Authorization: "current.parent" },
  delegationCid: "current-parent",
  spaceId: SPACE,
  verificationMethod: "did:key:z6MkCurrentSession#z6MkCurrentSession",
  jwk: { kty: "OKP", crv: "Ed25519", x: "current-x", d: "current-private" },
};

function childToken(params: CreateDelegationWasmParams): string {
  const path = Object.keys(params.abilities.kv)[0];
  const payload = {
    iss: SHARE_DID, aud: params.delegateDID, exp: params.expirationSecs, prf: [params.session.delegationCid],
    att: { [`${params.spaceId}/kv/${path}`]: Object.fromEntries(Object.values(params.abilities.kv)[0].map((action) => [action, [{}]])) },
  };
  return [
    Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function setup(overrides: Partial<SharingServiceConfig> = {}) {
  const defaultTransport = acceptingTransport;
  const hintTransport = transportNamed("hint");
  const placementTransport = transportNamed("placement");
  const receivedHostHintTransport = mock((_host: string): ResourceTransport | undefined => hintTransport);
  const receivedPlacementTransport = mock(async () => placementTransport);
  const service = new SharingService({
    hosts: [LINK_HOST],
    invoke: mock(async () => ({ ok: true, data: undefined })) as never,
    fetch: mock(async () => new Response(null, { status: 200 })) as unknown as typeof globalThis.fetch,
    resourceTransport: defaultTransport,
    keyProvider: {} as KeyProvider,
    registry: new CapabilityKeyRegistry(),
    createKVService: mock(() => ({})) as never,
    createDelegationWasm: mock((params: CreateDelegationWasmParams) => ({
      delegation: childToken(params), cid: "bafy-child", delegateDID: params.delegateDID, expiry: new Date(params.expirationSecs * 1000),
      resources: [{
        service: "kv", space: params.spaceId, path: Object.keys(params.abilities.kv)[0], actions: Object.values(params.abilities.kv)[0],
      }],
    })),
    computeCid: () => "bafy-child",
    receivedHostHintTransport,
    receivedPlacementTransport,
    ...overrides,
  });
  return { service, defaultTransport, hintTransport, placementTransport, receivedHostHintTransport, receivedPlacementTransport };
}

function link(service: SharingService, version: 1 | 2 = 1): string {
  const share = {
    host: LINK_HOST, spaceId: SPACE, path: PATH,
    keyDid: `${SHARE_DID}#${SHARE_DID.slice("did:key:".length)}`,
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(SHARE_PUBLIC_KEY).toString("base64url"), d: Buffer.from(SHARE_PRIVATE_KEY).toString("base64url") },
    delegation: {
      cid: PARENT_CID, delegateDID: SHARE_DID, spaceId: SPACE, path: PATH, actions: ["tinycloud.kv/get"],
      expiry: PARENT_EXPIRY, isRevoked: false, allowSubDelegation: true, authHeader: PARENT_AUTHORIZATION,
    },
  };
  const encoded: EncodedShareData = version === 2 ? { ...share, version: 2, placement: PLACEMENT } : { ...share, version: 1 };
  return service.encodeLink(encoded);
}

describe("SharingService received host hint", () => {
  test("a v1 share signed by the share key asks the hint callback with the link host", async () => {
    const { service, hintTransport, receivedHostHintTransport } = setup();
    const result = await service.receive(link(service), { autoSubdelegate: false, useSessionKey: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(receivedHostHintTransport.mock.calls).toEqual([[LINK_HOST]]);
    expect(result.data.resourceTransport).toBe(hintTransport);
  });

  test("a host the callback does not know leaves the configured transport in place", async () => {
    const { service, defaultTransport } = setup({ receivedHostHintTransport: () => undefined });
    const result = await service.receive(link(service), { autoSubdelegate: false, useSessionKey: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.resourceTransport).toBe(defaultTransport);
  });

  test("a v2 share routes by its placement and never asks the hint callback", async () => {
    const { service, placementTransport, receivedHostHintTransport, receivedPlacementTransport } = setup();
    const result = await service.receive(link(service, 2), { autoSubdelegate: false, useSessionKey: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(receivedPlacementTransport).toHaveBeenCalledTimes(1);
    expect(receivedHostHintTransport).not.toHaveBeenCalled();
    expect(result.data.resourceTransport).toBe(placementTransport);
  });

  test("a receive that delegates to the current session never asks the hint callback", async () => {
    const { service, defaultTransport, receivedHostHintTransport } = setup({ session: SESSION });
    const result = await service.receive(link(service));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.key.type).toBe("session");
    expect(receivedHostHintTransport).not.toHaveBeenCalled();
    expect(result.data.resourceTransport).toBe(defaultTransport);
  });

  test("a receive with a session that signs with the share key still asks the hint callback", async () => {
    const { service, receivedHostHintTransport } = setup({ session: SESSION });
    const result = await service.receive(link(service), { autoSubdelegate: false, useSessionKey: false });
    expect(result.ok).toBe(true);
    expect(receivedHostHintTransport).toHaveBeenCalledTimes(1);
  });
});
