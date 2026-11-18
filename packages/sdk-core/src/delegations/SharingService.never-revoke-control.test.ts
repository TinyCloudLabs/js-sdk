import { describe, expect, mock, test } from "bun:test";
import type { ServiceSession } from "@tinycloud/sdk-services";
import { bases } from "multiformats/basics";
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { CapabilityKeyRegistry } from "../authorization/CapabilityKeyRegistry";
import { SharingService } from "./SharingService";
import type { CreateDelegationWasmParams, KeyProvider } from "./types";

// TC-3150: a revoke-only grant for the holder (`holderMayRevoke`) is never issued with a share link. Every SharingService entry point that
// signs a delegation is exercised with its options, and what it signs and sends carries no `tinycloud.delegation` ability and no
// `revokeControl`. (The refusal of a requested delegation action is covered in SharingService.no-delegation-actions.test.ts.)
const OWNER = "0xd559CCd9EB87c530A9a349262669386dE93cf412";
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:applications`;
const HOST = "https://node.tinycloud.xyz";
const PATH = "shared";
const EXPIRY = new Date("2099-07-18T00:00:00.000Z");

const didFor = (publicKey: Uint8Array) => `did:key:${bases.base58btc.encode(Uint8Array.from([0xed, 0x01, ...publicKey]))}`;
const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");
const LINK_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const LINK_PUBLIC = ed25519.getPublicKey(LINK_SEED);
const LINK_DID = didFor(LINK_PUBLIC);
const PARENT_SEED = new Uint8Array(32).fill(19);
const PARENT_PUBLIC = ed25519.getPublicKey(PARENT_SEED);

/** A link delegation minted outside this SDK, signed for `actions` on the kv service. */
function signedParent(actions: readonly string[]): string {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", ucv: "0.10.0", jwk: { kty: "OKP", crv: "Ed25519", x: b64url(PARENT_PUBLIC) } }));
  const payload = b64url(JSON.stringify({
    iss: didFor(PARENT_PUBLIC), aud: LINK_DID, exp: EXPIRY.getTime() / 1000, prf: [],
    att: { [`${SPACE}/kv/${PATH}`]: Object.fromEntries(actions.map((action) => [action, [{}]])) },
  }));
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${b64url(ed25519.sign(new TextEncoder().encode(signingInput), PARENT_SEED))}`;
}

/** A child token that names exactly what was asked, the way the real signer's does. */
function childToken(params: CreateDelegationWasmParams): string {
  const att = Object.fromEntries(Object.entries(params.abilities).flatMap(([service, paths]) =>
    Object.entries(paths as Record<string, string[]>).map(([path, actions]) => [
      `${params.spaceId}/${service}/${path}`, Object.fromEntries(actions.map((action) => [action, [{}]])),
    ])));
  return [
    b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" })),
    b64url(JSON.stringify({ iss: LINK_DID, aud: params.delegateDID, exp: params.expirationSecs, prf: [params.session.delegationCid], att })),
    "signature",
  ].join(".");
}

function makeService(registry = new CapabilityKeyRegistry()) {
  const createDelegationWasm = mock((params: CreateDelegationWasmParams) => ({
    delegation: childToken(params),
    cid: "bafy-child",
    delegateDID: params.delegateDID,
    expiry: new Date(params.expirationSecs * 1000),
    resources: Object.entries(params.abilities).flatMap(([service, paths]) =>
      Object.entries(paths as Record<string, string[]>).map(([path, actions]) => ({ service, space: params.spaceId, path, actions }))),
  }));
  const fetch = mock(async () => new Response(null, { status: 200 })) as unknown as typeof globalThis.fetch;
  const onRootDelegationNeeded = mock(async () => {
    throw new Error("a refused share must not ask for a root delegation");
  });
  const session: ServiceSession = {
    delegationHeader: { Authorization: "parent.header.signature" },
    delegationCid: "bafy-parent",
    spaceId: SPACE,
    verificationMethod: "did:key:z6MkParent#z6MkParent",
    jwk: { kty: "OKP", crv: "Ed25519", x: "parent-x", d: "parent-d" },
  };
  const service = new SharingService({
    hosts: [HOST],
    session,
    invoke: mock(async () => ({ ok: true, data: undefined })) as never,
    fetch,
    resourceTransport: async (_resources, send) => send({
      url: HOST, nodeDid: LINK_DID, nodeInfo: { nodeId: LINK_DID }, fetch,
      bindAudience: async (authorization) => authorization,
    }),
    keyProvider: {
      createSessionKey: mock(async () => "share-key"),
      getDID: mock(async () => `${LINK_DID}#${LINK_DID.slice("did:key:".length)}`),
      getJWK: mock(() => ({ kty: "OKP", crv: "Ed25519", x: b64url(LINK_PUBLIC), d: b64url(LINK_SEED) })),
    } as unknown as KeyProvider,
    registry,
    createKVService: mock(() => ({})) as never,
    createDelegationWasm,
    onRootDelegationNeeded,
    computeCid: () => "bafy-child",
  });
  return { service, createDelegationWasm, fetch, onRootDelegationNeeded };
}


const READ = ["tinycloud.kv/get", "tinycloud.kv/list"];
const covering = () => {
  const registry = new CapabilityKeyRegistry();
  registry.registerKey({ id: "parent-key", did: "did:key:z6MkParent", type: "session", priority: 0 }, [{
    cid: "bafy-parent", delegateDID: "did:key:z6MkParent", spaceId: SPACE, path: PATH,
    actions: [...READ, "tinycloud.kv/put"], expiry: EXPIRY, isRevoked: false, allowSubDelegation: true,
  }]);
  return registry;
};
const noRoot = (service: ReturnType<typeof makeService>) => expect(service.onRootDelegationNeeded).not.toHaveBeenCalled();

/** Everything an entry point signed or sent: the abilities handed to the signer and every request body or header. */
function whatWasSigned(h: ReturnType<typeof makeService>): string {
  const abilities = h.createDelegationWasm.mock.calls.map(([params]) => JSON.stringify(params.abilities));
  const requests = (h.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => JSON.stringify(call));
  return [...abilities, ...requests].join("\n");
}

describe("share links never carry a revoke grant", () => {
  const options = [
    { label: "default options", params: { path: PATH, actions: READ } },
    { label: "an expiry", params: { path: PATH, actions: READ, expiry: new Date("2099-07-17T00:00:00.000Z") } },
    { label: "one resource", params: { resources: [{ path: PATH, actions: READ }] } },
    { label: "several resources", params: { resources: [{ path: `${PATH}/a`, actions: ["tinycloud.kv/get"] }, { path: `${PATH}/b`, actions: ["tinycloud.kv/list"] }] } },
  ];
  for (const { label, params } of options) {
    test(`generate with ${label}: no delegation ability is signed or sent, and no revokeControl is returned`, async () => {
      const h = makeService(covering());
      const result = await h.service.generate({ ...params, expiry: new Date("2099-07-17T00:00:00.000Z") } as never);
      expect(result.ok ? "ok" : JSON.stringify(result.error)).toBe("ok");
      expect(h.createDelegationWasm).toHaveBeenCalled();
      noRoot(h);
      expect(whatWasSigned(h)).not.toContain("delegation/");
      expect(JSON.stringify(result)).not.toContain("revokeControl");
      expect(JSON.stringify(result)).not.toContain("tinycloud.delegation");
    });
  }

  function receivedLink(h: ReturnType<typeof makeService>) {
    const authHeader = signedParent(READ);
    const linkCid = CID.createV1(0x55, createDigest(0x1e, blake3(new TextEncoder().encode(authHeader)))).toString();
    return h.service.encodeLink({
      version: 1, host: HOST, spaceId: SPACE, path: PATH,
      keyDid: `${LINK_DID}#${LINK_DID.slice("did:key:".length)}`,
      key: { kty: "OKP", crv: "Ed25519", x: b64url(LINK_PUBLIC), d: b64url(LINK_SEED) },
      delegation: {
        cid: linkCid, delegateDID: LINK_DID, spaceId: SPACE, path: PATH, actions: READ, expiry: EXPIRY,
        isRevoked: false, allowSubDelegation: true, authHeader,
      },
    });
  }

  for (const options of [{}, { autoSubdelegate: false }, { useSessionKey: false }]) {
    test(`receive with ${JSON.stringify(options)}: nothing signed or sent carries a delegation ability, and no revokeControl comes back`, async () => {
      const h = makeService();
      const result = await h.service.receive(receivedLink(h), options);
      expect(whatWasSigned(h)).not.toContain("delegation/");
      expect(JSON.stringify(result)).not.toContain("revokeControl");
    });
  }

  test("delegateReceivedShare (the recipient's child of a link): no delegation ability is signed or sent, and no revokeControl is returned", async () => {
    const h = makeService();
    const authHeader = signedParent(READ);
    const linkCid = CID.createV1(0x55, createDigest(0x1e, blake3(new TextEncoder().encode(authHeader)))).toString();
    const link = h.service.encodeLink({
      version: 1, host: HOST, spaceId: SPACE, path: PATH,
      keyDid: `${LINK_DID}#${LINK_DID.slice("did:key:".length)}`,
      key: { kty: "OKP", crv: "Ed25519", x: b64url(LINK_PUBLIC), d: b64url(LINK_SEED) },
      delegation: {
        cid: linkCid, delegateDID: LINK_DID, spaceId: SPACE, path: PATH, actions: READ, expiry: EXPIRY,
        isRevoked: false, allowSubDelegation: true, authHeader,
      },
    });
    const result = await h.service.delegateReceivedShare(link, {
      delegateDID: "did:key:z6MkFeedHost", expiry: new Date("2099-07-17T00:00:00.000Z"), expectedHost: HOST,
    });
    expect(result.ok ? "ok" : JSON.stringify(result.error)).toBe("ok");
    expect(h.createDelegationWasm).toHaveBeenCalled();
    expect(whatWasSigned(h)).not.toContain("delegation/");
    expect(JSON.stringify(result)).not.toContain("revokeControl");
  });
});
