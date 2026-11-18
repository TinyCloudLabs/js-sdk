import { describe, expect, mock, test } from "bun:test";
import type { ServiceSession } from "@tinycloud/sdk-services";
import { bases } from "multiformats/basics";
import { ed25519 } from "@noble/curves/ed25519";
import { CapabilityKeyRegistry } from "../authorization/CapabilityKeyRegistry";
import { SharingService } from "./SharingService";
import type { CreateDelegationWasmParams, KeyProvider } from "./types";

// TC-3286: a share link never carries a `tinycloud.delegation` action, so whoever holds the link can't
// revoke (or create, list or renew) delegations with it. A holder's own revoke is a separate grant.
const OWNER = "0xd559CCd9EB87c530A9a349262669386dE93cf412";
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:applications`;
const HOST = "https://node.tinycloud.xyz";
const PATH = "shared";
const EXPIRY = new Date("2099-07-18T00:00:00.000Z");
const DELEGATION_ACTIONS = ["tinycloud.delegation/revoke", "tinycloud.delegation/*"];

const didFor = (publicKey: Uint8Array) => `did:key:${bases.base58btc.encode(Uint8Array.from([0xed, 0x01, ...publicKey]))}`;
const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");
const LINK_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const LINK_PUBLIC = ed25519.getPublicKey(LINK_SEED);
const LINK_DID = didFor(LINK_PUBLIC);
const PARENT_SEED = new Uint8Array(32).fill(19);
const PARENT_PUBLIC = ed25519.getPublicKey(PARENT_SEED);

/** A link delegation minted outside this SDK, signed for `actions` on the delegation service. */
function signedParent(actions: readonly string[]): string {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", ucv: "0.10.0", jwk: { kty: "OKP", crv: "Ed25519", x: b64url(PARENT_PUBLIC) } }));
  const payload = b64url(JSON.stringify({
    iss: didFor(PARENT_PUBLIC), aud: LINK_DID, exp: EXPIRY.getTime() / 1000, prf: [],
    att: { [`${SPACE}/delegation/${PATH}`]: Object.fromEntries(actions.map((action) => [action, [{}]])) },
  }));
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${b64url(ed25519.sign(new TextEncoder().encode(signingInput), PARENT_SEED))}`;
}

function makeService(registry = new CapabilityKeyRegistry()) {
  const createDelegationWasm = mock((params: CreateDelegationWasmParams) => ({
    delegation: "child.token.signature",
    cid: "bafy-child",
    delegateDID: params.delegateDID,
    expiry: new Date(params.expirationSecs * 1000),
    resources: [],
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

function expectDelegationActionRefused(result: { ok: boolean; error?: { code: string; message: string } }): void {
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe("INVALID_INPUT");
  expect(result.error?.message).toContain("tinycloud.delegation");
}

describe("SharingService.generate refuses delegation actions", () => {
  const requests = [
    ...DELEGATION_ACTIONS.map((action) => ({ label: action, params: { path: PATH, actions: [action] } })),
    {
      label: "one delegation resource among kv resources",
      params: { resources: [{ path: `${PATH}/a`, actions: ["tinycloud.kv/get"] }, { path: `${PATH}/b`, actions: ["tinycloud.delegation/revoke"] }] },
    },
  ];
  for (const { label, params } of requests) {
    test(`${label}: refused before any signing, root request or network call`, async () => {
      const { service, createDelegationWasm, fetch, onRootDelegationNeeded } = makeService();

      expectDelegationActionRefused(await service.generate(params));
      expect(createDelegationWasm).not.toHaveBeenCalled();
      expect(onRootDelegationNeeded).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });
  }
});

test("preflightGenerate never reports a delegation-action link as ok, even when the session's authority covers it", () => {
  const registry = new CapabilityKeyRegistry();
  registry.registerKey({ id: "parent-key", did: "did:key:z6MkParent", type: "session", priority: 0 }, [{
    cid: "bafy-parent",
    delegateDID: "did:key:z6MkParent",
    spaceId: SPACE,
    path: PATH,
    actions: ["tinycloud.kv/get", ...DELEGATION_ACTIONS],
    expiry: EXPIRY,
    isRevoked: false,
    allowSubDelegation: true,
  }]);
  const { service } = makeService(registry);

  // The same authority covers a read link, so only the delegation action decides the answer.
  expect(service.preflightGenerate({ path: PATH, actions: ["tinycloud.kv/get"], expiry: new Date("2099-07-17T00:00:00.000Z") })).toBe("ok");
  for (const action of DELEGATION_ACTIONS) {
    expect(service.preflightGenerate({ path: PATH, actions: [action], expiry: new Date("2099-07-17T00:00:00.000Z") })).toBe("not-covered");
  }
});

describe("SharingService.delegateReceivedShare refuses delegation actions in the recipient's child", () => {
  function linkCarrying(service: SharingService, actions: string[]): string {
    return service.encodeLink({
      version: 1,
      host: HOST,
      spaceId: SPACE,
      path: PATH,
      keyDid: `${LINK_DID}#${LINK_DID.slice("did:key:".length)}`,
      key: { kty: "OKP", crv: "Ed25519", x: b64url(LINK_PUBLIC), d: b64url(LINK_SEED) },
      delegation: {
        cid: "bafy-link",
        delegateDID: LINK_DID,
        spaceId: SPACE,
        path: PATH,
        actions,
        expiry: EXPIRY,
        isRevoked: false,
        allowSubDelegation: true,
        authHeader: signedParent(actions),
      },
    });
  }

  for (const action of DELEGATION_ACTIONS) {
    for (const requested of [undefined, ["tinycloud.delegation/revoke"]]) {
      test(`a link carrying ${action}, child ${requested === undefined ? "inheriting its actions" : "asking for revoke"}: refused before signing`, async () => {
        const { service, createDelegationWasm, fetch } = makeService();

        const result = await service.delegateReceivedShare(linkCarrying(service, [action]), {
          delegateDID: "did:key:z6MkFeedHost",
          ...(requested === undefined ? {} : { actions: requested }),
          expiry: new Date("2099-07-17T00:00:00.000Z"),
          expectedHost: HOST,
        });

        expectDelegationActionRefused(result);
        expect(createDelegationWasm).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      });
    }
  }
});
