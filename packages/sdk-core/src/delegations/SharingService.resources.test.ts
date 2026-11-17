// TC-3194: one share carrying several resources (a recording's transcript key
// and its audio prefix), and the recipient's view of an owner who stopped sharing.
import { describe, expect, mock, test } from "bun:test";
import type { ResourceTransport, ServiceSession } from "@tinycloud/sdk-services";
import { bases } from "multiformats/basics";
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { CapabilityKeyRegistry } from "../authorization/CapabilityKeyRegistry";
import { SharingService, type EncodedShareData } from "./SharingService";
import type { CreateDelegationWasmParams, CreateDelegationWasmResult, Delegation, KeyProvider } from "./types";
import { DelegationErrorCodes } from "./types";

const OWNER = "0xd559CCd9EB87c530A9a349262669386dE93cf412";
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:applications`;
const HOST = "https://node.tinycloud.xyz";
const PARENT_EXPIRY = new Date("2099-07-18T00:00:00.000Z");
const SHARE_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const SHARE_PUBLIC_KEY = ed25519.getPublicKey(SHARE_PRIVATE_KEY);
const SHARE_DID = `did:key:${bases.base58btc.encode(Uint8Array.from([0xed, 0x01, ...SHARE_PUBLIC_KEY]))}`;
const SHARE_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: Buffer.from(SHARE_PUBLIC_KEY).toString("base64url"),
  d: Buffer.from(SHARE_PRIVATE_KEY).toString("base64url"),
};
const TRANSCRIPT = "xyz.tinycloud.recordings/rec-1/transcript.json";
const AUDIO = "xyz.tinycloud.recordings/rec-1/audio/";
const READ = ["tinycloud.kv/get", "tinycloud.kv/metadata"];
const RECIPIENT = "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1";

// The owner's root to the share key, signed over both resources.
const ROOT_SEED = new Uint8Array(32).fill(19);
const ROOT_PUBLIC = ed25519.getPublicKey(ROOT_SEED);
const ROOT_DID = `did:key:${bases.base58btc.encode(Uint8Array.from([0xed, 0x01, ...ROOT_PUBLIC]))}`;
const rootSigningInput = [
  { alg: "EdDSA", typ: "JWT", ucv: "0.10.0", jwk: { kty: "OKP", crv: "Ed25519", x: Buffer.from(ROOT_PUBLIC).toString("base64url") } },
  {
    iss: ROOT_DID, aud: SHARE_DID, exp: PARENT_EXPIRY.getTime() / 1000, prf: [],
    att: Object.fromEntries([TRANSCRIPT, AUDIO].map((path) => [`${SPACE}/kv/${path}`, Object.fromEntries(READ.map((action) => [action, [{}]]))])),
  },
].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
const ROOT_AUTHORIZATION = `${rootSigningInput}.${Buffer.from(ed25519.sign(new TextEncoder().encode(rootSigningInput), ROOT_SEED)).toString("base64url")}`;
const ROOT_CID = CID.createV1(0x55, createDigest(0x1e, blake3(new TextEncoder().encode(ROOT_AUTHORIZATION)))).toString();

/** A child UCAN carrying exactly the requested abilities, as the WASM signer would. */
function childToken(params: CreateDelegationWasmParams): string {
  const att: Record<string, Record<string, unknown[]>> = {};
  for (const [service, paths] of Object.entries(params.abilities)) {
    for (const [path, actions] of Object.entries(paths)) {
      att[`${params.spaceId}/${service}/${path}`] = Object.fromEntries(actions.map((action) => [action, [{}]]));
    }
  }
  const payload = { iss: SHARE_DID, aud: params.delegateDID, exp: params.expirationSecs, prf: [params.session.delegationCid], att };
  return [
    Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function signed(params: CreateDelegationWasmParams): CreateDelegationWasmResult {
  return {
    delegation: childToken(params),
    cid: "bafy-child",
    delegateDID: params.delegateDID,
    expiry: new Date(params.expirationSecs * 1000),
    resources: Object.entries(params.abilities).flatMap(([service, paths]) =>
      Object.entries(paths).map(([path, actions]) => ({ service, space: params.spaceId, path, actions }))),
  };
}

function makeService(options: {
  fetch?: typeof globalThis.fetch;
  sign?: (params: CreateDelegationWasmParams) => CreateDelegationWasmResult;
  onRootDelegationNeeded?: ConstructorParameters<typeof SharingService>[0]["onRootDelegationNeeded"];
  registry?: CapabilityKeyRegistry;
} = {}) {
  const createDelegationWasm = mock(options.sign ?? signed);
  const fetch = mock(options.fetch ?? (async () => new Response(null, { status: 200 })));
  const resourceTransport: ResourceTransport = async (_resources, send) => send({
    url: HOST, nodeDid: SHARE_DID, nodeInfo: { nodeId: SHARE_DID }, fetch,
    bindAudience: async (authorization) => authorization,
  });
  const service = new SharingService({
    hosts: [HOST],
    invoke: mock(async () => ({ ok: true, data: undefined })) as never,
    fetch,
    resourceTransport,
    keyProvider: {
      createSessionKey: (name: string) => name,
      getDID: () => `${SHARE_DID}#${SHARE_DID.slice("did:key:".length)}`,
      getJWK: () => SHARE_JWK,
    } as unknown as KeyProvider,
    registry: options.registry ?? new CapabilityKeyRegistry(),
    createKVService: mock(() => ({})) as never,
    createDelegationWasm,
    computeCid: () => "bafy-child",
    session: {
      spaceId: SPACE,
      delegationCid: "bafy-session",
      verificationMethod: "did:key:zSession#zSession",
      jwk: SHARE_JWK,
    } as unknown as ServiceSession,
    onRootDelegationNeeded: options.onRootDelegationNeeded,
  });
  return { service, createDelegationWasm, fetch };
}

function rootDelegation(path = TRANSCRIPT, actions = READ): Delegation {
  return {
    cid: ROOT_CID,
    delegateDID: SHARE_DID,
    spaceId: SPACE,
    path,
    actions,
    expiry: PARENT_EXPIRY,
    isRevoked: false,
    allowSubDelegation: true,
    authHeader: ROOT_AUTHORIZATION,
  };
}

function recordingShare(service: SharingService, overrides: Partial<EncodedShareData> = {}): string {
  return service.encodeLink({
    version: 1,
    host: HOST,
    spaceId: SPACE,
    path: TRANSCRIPT,
    resources: [{ path: TRANSCRIPT, actions: READ }, { path: AUDIO, actions: READ }],
    keyDid: `${SHARE_DID}#${SHARE_DID.slice("did:key:".length)}`,
    key: SHARE_JWK,
    delegation: rootDelegation(),
    ...overrides,
  });
}

describe("SharingService.generate with several resources", () => {
  test("asks the owner once for every resource and carries them in the link", async () => {
    const onRootDelegationNeeded = mock(async (_params: unknown) => rootDelegation());
    const { service } = makeService({ onRootDelegationNeeded });
    const result = await service.generate({
      resources: [{ path: TRANSCRIPT }, { path: AUDIO, actions: ["tinycloud.kv/get"] }],
      expiry: PARENT_EXPIRY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(onRootDelegationNeeded).toHaveBeenCalledTimes(1);
    expect(onRootDelegationNeeded.mock.calls[0][0]).toMatchObject({
      spaceId: SPACE,
      path: TRANSCRIPT,
      actions: READ,
      resources: [{ path: TRANSCRIPT, actions: READ }, { path: AUDIO, actions: ["tinycloud.kv/get"] }],
    });
    const decoded = service.decodeLink(result.data.token);
    expect(decoded.path).toBe(TRANSCRIPT);
    expect(decoded.resources).toEqual([
      { path: TRANSCRIPT, actions: READ },
      { path: AUDIO, actions: ["tinycloud.kv/get"] },
    ]);
  });

  test("signs one session child over every resource when the session covers them", async () => {
    const registry = new CapabilityKeyRegistry();
    registry.registerKey({ id: "session", did: SHARE_DID, type: "session", priority: 0 }, [{
      cid: "bafy-session", delegateDID: SHARE_DID, spaceId: SPACE, path: "xyz.tinycloud.recordings/",
      actions: READ, expiry: PARENT_EXPIRY, isRevoked: false, allowSubDelegation: true,
    }]);
    const onRootDelegationNeeded = mock(async () => undefined);
    const { service, createDelegationWasm } = makeService({ registry, onRootDelegationNeeded });
    const result = await service.generate({ resources: [{ path: TRANSCRIPT }, { path: AUDIO }], expiry: PARENT_EXPIRY });

    expect(result.ok).toBe(true);
    expect(onRootDelegationNeeded).not.toHaveBeenCalled();
    expect(createDelegationWasm.mock.calls[0][0].abilities).toEqual({ kv: { [TRANSCRIPT]: READ, [AUDIO]: READ } });
    if (result.ok) expect(result.data.delegation.path).toBe(TRANSCRIPT);
  });

  test("refuses an ambiguous or unbounded resource list before creating a key", async () => {
    const cases = [
      { path: TRANSCRIPT, resources: [{ path: AUDIO }] },
      { resources: [{ path: AUDIO }], actions: READ },
      { resources: [] },
      { resources: Array.from({ length: 17 }, (_, index) => ({ path: `p/${index}` })) },
      { resources: [{ path: AUDIO }, { path: AUDIO }] },
      { resources: [{ path: AUDIO }, { path: "audio/*" }] },
      { resources: [{ path: TRANSCRIPT }, { path: AUDIO, actions: ["tinycloud.kv/get", "tinycloud.sql/read"] }] },
      { resources: [{ path: TRANSCRIPT }, { path: AUDIO }], includePlacement: true },
    ];
    for (const params of cases) {
      const onRootDelegationNeeded = mock(async () => rootDelegation());
      const { service, createDelegationWasm } = makeService({ onRootDelegationNeeded });
      (service as unknown as { createPlacement: unknown }).createPlacement = async () => ({});
      const result = await service.generate({ ...params, expiry: PARENT_EXPIRY });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(DelegationErrorCodes.INVALID_INPUT);
      expect(onRootDelegationNeeded).not.toHaveBeenCalled();
      expect(createDelegationWasm).not.toHaveBeenCalled();
    }
  });
});

describe("SharingService.decodeLink with several resources", () => {
  test("refuses a resource list that does not lead with the link's path and root actions", () => {
    const { service } = makeService();
    for (const overrides of [
      { resources: [{ path: AUDIO, actions: READ }, { path: TRANSCRIPT, actions: READ }] },
      { resources: [{ path: TRANSCRIPT, actions: ["tinycloud.kv/get"] }, { path: AUDIO, actions: READ }] },
      { resources: [{ path: TRANSCRIPT, actions: READ }, { path: TRANSCRIPT, actions: READ }] },
    ]) {
      expect(() => service.decodeLink(recordingShare(service, overrides))).toThrow("Sharing-link resources do not match its parent delegation");
    }
  });
});

describe("SharingService.delegateReceivedShare with several resources", () => {
  test("signs one child covering every resource for the recipient", async () => {
    const { service, createDelegationWasm } = makeService();
    const result = await service.delegateReceivedShare(recordingShare(service), { delegateDID: RECIPIENT });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(createDelegationWasm.mock.calls[0][0].abilities).toEqual({ kv: { [TRANSCRIPT]: READ, [AUDIO]: READ } });
    expect(result.data.delegation).toMatchObject({ path: TRANSCRIPT, actions: READ });
    expect(result.data.delegation.delegateDID.toLowerCase()).toBe(RECIPIENT);
    expect(result.data.delegation.resources?.map((resource) => resource.path)).toEqual([TRANSCRIPT, AUDIO]);
  });

  test("narrows to one resource by path, and refuses a path outside all of them", async () => {
    const narrowed = makeService();
    const part = `${AUDIO}part-0001`;
    const result = await narrowed.service.delegateReceivedShare(recordingShare(narrowed.service), { delegateDID: RECIPIENT, path: part });
    expect(result.ok).toBe(true);
    expect(narrowed.createDelegationWasm.mock.calls[0][0].abilities).toEqual({ kv: { [part]: READ } });

    const outside = makeService();
    const refused = await outside.service.delegateReceivedShare(recordingShare(outside.service), {
      delegateDID: RECIPIENT,
      path: "xyz.tinycloud.recordings/rec-2/transcript.json",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe(DelegationErrorCodes.PERMISSION_DENIED);
    expect(outside.createDelegationWasm).not.toHaveBeenCalled();
  });

  test("refuses a signed child that drops a resource", async () => {
    const { service, fetch } = makeService({
      sign: (params) => signed({ ...params, abilities: { kv: { [TRANSCRIPT]: READ } } }),
    });
    const result = await service.delegateReceivedShare(recordingShare(service), { delegateDID: RECIPIENT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(DelegationErrorCodes.CREATION_FAILED);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("SharingService.delegateReceivedShare refusals", () => {
  const refusal = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;
  for (const [label, status, body, code] of [
    [
      "a revoked chain as REVOKED",
      401,
      JSON.stringify({ code: "ancestor_revoked", error: "delegation-ancestor-revoked: ancestor=bafy-root parent=bafy-child" }),
      DelegationErrorCodes.REVOKED,
    ],
    ["an expired chain as AUTH_EXPIRED", 401, JSON.stringify({ code: "delegation_expired", error: "expired" }), DelegationErrorCodes.AUTH_EXPIRED],
    ["any other refusal as CREATION_FAILED", 401, JSON.stringify({ code: "unauthorized", error: "no" }), DelegationErrorCodes.CREATION_FAILED],
    ["a server failure as CREATION_FAILED", 500, "ancestor_revoked", DelegationErrorCodes.CREATION_FAILED],
  ] as const) {
    test(`reports ${label}`, async () => {
      const { service } = makeService({ fetch: refusal(status, body) });
      const result = await service.delegateReceivedShare(recordingShare(service), { delegateDID: RECIPIENT });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
        expect(result.error.meta).toEqual({ status });
      }
    });
  }
});
