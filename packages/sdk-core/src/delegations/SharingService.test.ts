import { describe, expect, mock, test } from "bun:test";
import type { ServiceSession } from "@tinycloud/sdk-services";
import { bases } from "multiformats/basics";
import { ed25519 } from "@noble/curves/ed25519";
import { CapabilityKeyRegistry } from "../authorization/CapabilityKeyRegistry";
import { SharingService, type EncodedShareData } from "./SharingService";
import type { CreateDelegationWasmParams, KeyProvider } from "./types";

const OWNER = "0xd559CCd9EB87c530A9a349262669386dE93cf412";
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:applications`;
const HOST = "https://node.tinycloud.xyz";
const PARENT_EXPIRY = new Date("2099-07-18T00:00:00.000Z");
const SHARE_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const SHARE_PUBLIC_KEY = ed25519.getPublicKey(SHARE_PRIVATE_KEY);
const SHARE_DID = `did:key:${bases.base58btc.encode(Uint8Array.from([0xed, 0x01, ...SHARE_PUBLIC_KEY]))}`;
const SHARE_X = Buffer.from(SHARE_PUBLIC_KEY).toString("base64url");
const SHARE_D = Buffer.from(SHARE_PRIVATE_KEY).toString("base64url");

function childToken(params: CreateDelegationWasmParams, actions = Object.values(params.abilities.kv)[0]): string {
  const path = Object.keys(params.abilities.kv)[0];
  const payload = {
    iss: SHARE_DID,
    aud: params.delegateDID,
    exp: params.expirationSecs,
    prf: ["bafy-parent"],
    att: {
      [`${params.spaceId}/kv/${path}`]: Object.fromEntries(actions.map((action) => [action, [{}]])),
    },
  };
  return [
    Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function makeService() {
  const createDelegationWasm = mock((params: CreateDelegationWasmParams) => ({
    delegation: childToken(params),
    cid: "bafy-child",
    delegateDID: params.delegateDID,
    expiry: new Date(params.expirationSecs * 1000),
    resources: [{
      service: "kv",
      space: params.spaceId,
      path: Object.keys(params.abilities.kv)[0],
      actions: Object.values(params.abilities.kv)[0],
    }],
  }));
  const fetch = mock(async () => new Response(null, { status: 200 }));
  const service = new SharingService({
    hosts: [HOST],
    invoke: mock(async () => ({ ok: true, data: undefined })) as never,
    fetch,
    keyProvider: {} as KeyProvider,
    registry: new CapabilityKeyRegistry(),
    createKVService: mock(() => ({})) as never,
    createDelegationWasm,
    computeCid: () => "bafy-child",
  });
  return { service, createDelegationWasm, fetch };
}

function shareLink(service: SharingService, overrides: Partial<EncodedShareData["delegation"]> = {}): string {
  return service.encodeLink({
    version: 1,
    host: HOST,
    spaceId: SPACE,
    path: "xyz.tinycloud.artifacts/artifacts/listen-import",
    keyDid: `${SHARE_DID}#${SHARE_DID.slice("did:key:".length)}`,
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: SHARE_X,
      d: SHARE_D,
    },
    delegation: {
      cid: "bafy-parent",
      delegateDID: SHARE_DID,
      spaceId: SPACE,
      path: "xyz.tinycloud.artifacts/artifacts/listen-import",
      actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
      expiry: PARENT_EXPIRY,
      isRevoked: false,
      allowSubDelegation: true,
      authHeader: "parent.header.signature",
      ...overrides,
    },
  });
}

describe("SharingService.delegateReceivedShare", () => {
  test("creates and registers a strict child without returning parent key material", async () => {
    const { service, createDelegationWasm, fetch } = makeService();
    const result = await service.delegateReceivedShare(shareLink(service), {
      delegateDID: "did:key:z6MkFeedHost#z6MkFeedHost",
      actions: ["tinycloud.kv/get"],
      expiry: new Date("2099-07-17T00:00:00.000Z"),
      expectedHost: HOST,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(createDelegationWasm).toHaveBeenCalledTimes(1);
    const params = createDelegationWasm.mock.calls[0][0];
    expect(params.delegateDID).toBe("did:key:z6MkFeedHost");
    expect(params.session).toMatchObject({
      delegationCid: "bafy-parent",
      spaceId: SPACE,
      verificationMethod: `${SHARE_DID}#${SHARE_DID.slice("did:key:".length)}`,
      jwk: { d: SHARE_D },
    } satisfies Partial<ServiceSession>);
    expect(params.abilities).toEqual({
      kv: {
        "xyz.tinycloud.artifacts/artifacts/listen-import": ["tinycloud.kv/get"],
      },
    });
    expect(fetch).toHaveBeenCalledWith(`${HOST}/delegate`, {
      method: "POST",
      headers: { Authorization: expect.any(String) },
      redirect: "error",
    });
    expect(result.data.delegation).toMatchObject({
      delegateDID: "did:key:z6MkFeedHost",
      parentCid: "bafy-parent",
      ownerAddress: OWNER,
      chainId: 1,
      disableSubDelegation: true,
    });
    const transported = JSON.stringify(result.data);
    expect(transported).not.toContain("tc1:");
    expect(transported).not.toContain(SHARE_D);
    expect(transported).not.toContain("parent.header.signature");
  });

  test("rejects capability broadening before signing or network access", async () => {
    const cases = [
      { path: "xyz.tinycloud.artifacts/artifacts" },
      { actions: ["tinycloud.kv/put"] },
      { expiry: new Date("2099-07-19T00:00:00.000Z") },
    ];
    for (const requested of cases) {
      const { service, createDelegationWasm, fetch } = makeService();
      const result = await service.delegateReceivedShare(shareLink(service), {
        delegateDID: "did:key:z6MkFeedHost",
        ...requested,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("PERMISSION_DENIED");
      expect(createDelegationWasm).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  test("narrows a service wildcard while rejecting cross-service actions", async () => {
    const allowedService = makeService();
    const allowed = await allowedService.service.delegateReceivedShare(
      shareLink(allowedService.service, { actions: ["tinycloud.kv/*"] }),
      {
        delegateDID: "did:key:z6MkFeedHost",
        actions: ["tinycloud.kv/get"],
      },
    );
    expect(allowed.ok).toBe(true);
    expect(allowedService.createDelegationWasm).toHaveBeenCalledTimes(1);
    if (allowed.ok) {
      const token = allowed.data.delegation.delegationHeader.Authorization;
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      const signedActions = Object.keys(Object.values(payload.att)[0] as object);
      expect(signedActions).toEqual(["tinycloud.kv/get"]);
    }

    const rejectedService = makeService();
    const rejected = await rejectedService.service.delegateReceivedShare(
      shareLink(rejectedService.service, { actions: ["tinycloud.kv/*"] }),
      {
        delegateDID: "did:key:z6MkFeedHost",
        actions: ["tinycloud.sql/read"],
      },
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("PERMISSION_DENIED");
    expect(rejectedService.createDelegationWasm).not.toHaveBeenCalled();

    const wildcardChildService = makeService();
    const wildcardChild = await wildcardChildService.service.delegateReceivedShare(
      shareLink(wildcardChildService.service, { actions: ["tinycloud.kv/get"] }),
      {
        delegateDID: "did:key:z6MkFeedHost",
        actions: ["tinycloud.kv/*"],
      },
    );
    expect(wildcardChild.ok).toBe(false);
    expect(wildcardChildService.createDelegationWasm).not.toHaveBeenCalled();

    const mixedService = makeService();
    const mixed = await mixedService.service.delegateReceivedShare(
      shareLink(mixedService.service, {
        actions: ["tinycloud.kv/get", "tinycloud.kv/*"],
      }),
      {
        delegateDID: "did:key:z6MkFeedHost",
        actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
      },
    );
    expect(mixed.ok).toBe(true);
    expect(mixedService.createDelegationWasm).toHaveBeenCalledTimes(1);
  });

  test("rejects a parent that forbids sub-delegation", async () => {
    const { service, createDelegationWasm } = makeService();
    const result = await service.delegateReceivedShare(
      shareLink(service, { allowSubDelegation: false }),
      { delegateDID: "did:key:z6MkFeedHost" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION_DENIED");
    expect(createDelegationWasm).not.toHaveBeenCalled();
  });

  test("rejects a link for a different host or inconsistent parent metadata", async () => {
    const { service, createDelegationWasm, fetch } = makeService();
    const wrongHost = await service.delegateReceivedShare(shareLink(service), {
      delegateDID: "did:key:z6MkFeedHost",
      expectedHost: "https://other.tinycloud.xyz",
    });
    expect(wrongHost.ok).toBe(false);
    if (!wrongHost.ok) expect(wrongHost.error.code).toBe("PERMISSION_DENIED");

    const inconsistent = await service.delegateReceivedShare(
      shareLink(service, { spaceId: `${SPACE}:other` }),
      { delegateDID: "did:key:z6MkFeedHost" },
    );
    expect(inconsistent.ok).toBe(false);
    if (!inconsistent.ok) expect(inconsistent.error.code).toBe("INVALID_TOKEN");
    expect(createDelegationWasm).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("rejects a private JWK that does not correspond to its public key", async () => {
    const { service, createDelegationWasm, fetch } = makeService();
    const decoded = service.decodeLink(shareLink(service));
    decoded.key.d = Buffer.from(Uint8Array.from({ length: 32 }, () => 99)).toString("base64url");
    const result = await service.delegateReceivedShare(service.encodeLink(decoded), {
      delegateDID: "did:key:z6MkFeedHost",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_TOKEN");
    expect(createDelegationWasm).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("decodes JWK public and private material through the browser atob path", async () => {
    const originalAtob = globalThis.atob;
    let decodeCalls = 0;
    globalThis.atob = (value: string) => {
      decodeCalls += 1;
      return originalAtob(value);
    };
    try {
      const { service } = makeService();
      const result = await service.delegateReceivedShare(shareLink(service), {
        delegateDID: "did:key:z6MkFeedHost",
      });
      expect(result.ok).toBe(true);
      expect(decodeCalls).toBeGreaterThan(0);
    } finally {
      globalThis.atob = originalAtob;
    }
  });

  test("real fetch refuses registration redirects without forwarding the child credential", async () => {
    let targetHits = 0;
    let targetAuthorization: string | null = null;
    const target = Bun.serve({
      port: 0,
      fetch(request) {
        targetHits += 1;
        targetAuthorization = request.headers.get("authorization");
        return new Response(null, { status: 200 });
      },
    });
    const redirect = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { Location: new URL("/capture", target.url).toString() },
        });
      },
    });

    try {
      const host = new URL(redirect.url).origin;
      const createDelegationWasm = mock((params: CreateDelegationWasmParams) => ({
        delegation: childToken(params),
        cid: "bafy-child",
        delegateDID: params.delegateDID,
        expiry: new Date(params.expirationSecs * 1000),
        resources: [{
          service: "kv",
          space: params.spaceId,
          path: Object.keys(params.abilities.kv)[0],
          actions: Object.values(params.abilities.kv)[0],
        }],
      }));
      const service = new SharingService({
        hosts: [host],
        invoke: mock(async () => ({ ok: true, data: undefined })) as never,
        keyProvider: {} as KeyProvider,
        registry: new CapabilityKeyRegistry(),
        createKVService: mock(() => ({})) as never,
        createDelegationWasm,
        computeCid: () => "bafy-child",
      });
      const decoded = service.decodeLink(shareLink(service));
      decoded.host = host;
      const result = await service.delegateReceivedShare(service.encodeLink(decoded), {
        delegateDID: "did:key:z6MkFeedHost",
      });
      expect(result.ok).toBe(false);
      expect(createDelegationWasm).toHaveBeenCalledTimes(1);
      expect(targetHits).toBe(0);
      expect(targetAuthorization).toBeNull();
    } finally {
      redirect.stop(true);
      target.stop(true);
    }
  });

  test("rejects non-canonical paths and hostile configured hosts", async () => {
    for (const path of ["xyz/data/../secret", "xyz//data", "xyz/%2fsecret", "xyz\\secret", "xyz/*"]) {
      const { service, createDelegationWasm } = makeService();
      const result = await service.delegateReceivedShare(
        shareLink(service),
        { delegateDID: "did:key:z6MkFeedHost", path },
      );
      expect(result.ok).toBe(false);
      expect(createDelegationWasm).not.toHaveBeenCalled();
    }

    const fetch = mock(async () => new Response(null, { status: 200 }));
    const service = new SharingService({
      hosts: ["file:///tmp/secret"],
      invoke: mock(async () => ({ ok: true, data: undefined })) as never,
      fetch,
      keyProvider: {} as KeyProvider,
      registry: new CapabilityKeyRegistry(),
      createKVService: mock(() => ({})) as never,
      createDelegationWasm: mock(() => { throw new Error("must not sign"); }),
      computeCid: () => "bafy-child",
    });
    const result = await service.delegateReceivedShare(shareLink(service), {
      delegateDID: "did:key:z6MkFeedHost",
    });
    expect(result.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("preserves exact, subtree, root, and wildcard capability semantics", async () => {
    const cases = [
      { parent: "exact", child: "exact", allowed: true },
      { parent: "exact", child: "exact/child", allowed: false },
      { parent: "folder/", child: "folder/child/deep", allowed: true },
      { parent: "/", child: "any/depth", allowed: true },
      { parent: "folder/*", child: "folder/child", allowed: true },
      { parent: "folder/*", child: "folder/child/deep", allowed: false },
      { parent: "folder/**", child: "folder/child/deep", allowed: true },
      { parent: "folder/", child: "folders/sibling", allowed: false },
    ];

    for (const { parent, child, allowed } of cases) {
      const { service, createDelegationWasm, fetch } = makeService();
      const decoded = service.decodeLink(shareLink(service));
      decoded.path = parent;
      decoded.delegation.path = parent;
      const result = await service.delegateReceivedShare(service.encodeLink(decoded), {
        delegateDID: "did:key:z6MkFeedHost",
        path: child,
      });
      expect(result.ok).toBe(allowed);
      expect(createDelegationWasm).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(fetch).toHaveBeenCalledTimes(allowed ? 1 : 0);
    }
  });

  test("rejects a signer result that differs from the requested child", async () => {
    const { service, createDelegationWasm, fetch } = makeService();
    createDelegationWasm.mockImplementationOnce((params) => ({
      delegation: childToken(params),
      cid: "bafy-bad-child",
      delegateDID: params.delegateDID,
      expiry: new Date(params.expirationSecs * 1000),
      resources: [{
        service: "kv",
        space: params.spaceId,
        path: "xyz.tinycloud.artifacts/artifacts/listen-import",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      }],
    }));
    const result = await service.delegateReceivedShare(shareLink(service), {
      delegateDID: "did:key:z6MkFeedHost",
      actions: ["tinycloud.kv/get"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CREATION_FAILED");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("scrubs lower-level errors instead of returning credential-bearing causes", async () => {
    const { service, createDelegationWasm } = makeService();
    createDelegationWasm.mockImplementationOnce(() => {
      throw new Error(`tc1:secret ${SHARE_D} parent.header.signature`);
    });
    const result = await service.delegateReceivedShare(shareLink(service), {
      delegateDID: "did:key:z6MkFeedHost",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Failed to create or register the child delegation");
    expect(result.error.cause).toBeUndefined();
    expect(JSON.stringify(result.error)).not.toContain(SHARE_D);
    expect(JSON.stringify(result.error)).not.toContain("parent.header.signature");
  });

  test("receive auto-subdelegates to the current session and uses its key", async () => {
    const createDelegationWasm = mock((params: CreateDelegationWasmParams) => ({
      delegation: childToken(params),
      cid: "bafy-child",
      delegateDID: params.delegateDID,
      expiry: new Date(params.expirationSecs * 1000),
      resources: [{
        service: "kv",
        space: params.spaceId,
        path: Object.keys(params.abilities.kv)[0],
        actions: Object.values(params.abilities.kv)[0],
      }],
    }));
    const createKVService = mock(() => ({ shared: true }));
    const currentSession: ServiceSession = {
      delegationHeader: { Authorization: "current.parent" },
      delegationCid: "current-parent",
      spaceId: SPACE,
      verificationMethod: "did:key:z6MkCurrentSession#z6MkCurrentSession",
      jwk: { kty: "OKP", crv: "Ed25519", x: "current-x", d: "current-private" },
    };
    const service = new SharingService({
      hosts: [HOST],
      session: currentSession,
      invoke: mock(async () => ({ ok: true, data: undefined })) as never,
      fetch: mock(async () => new Response(null, { status: 200 })),
      keyProvider: {} as KeyProvider,
      registry: new CapabilityKeyRegistry(),
      createKVService: createKVService as never,
      createDelegationWasm,
      computeCid: () => "bafy-child",
    });

    const result = await service.receive(shareLink(service));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.delegation.cid).toBe("bafy-child");
    expect(result.data.key.type).toBe("session");
    expect(createDelegationWasm.mock.calls[0][0].delegateDID).toBe("did:key:z6MkCurrentSession");
    expect(createKVService.mock.calls[0][0].session).toMatchObject({
      delegationCid: "bafy-child",
      verificationMethod: currentSession.verificationMethod,
      jwk: { d: "current-private" },
    });
    expect(JSON.stringify(result.data.key)).not.toContain("current-private");
  });

  test("rejects a bearer token whose signed claims are broader than signer metadata", async () => {
    const { service, createDelegationWasm, fetch } = makeService();
    createDelegationWasm.mockImplementationOnce((params) => ({
      delegation: childToken(params, ["tinycloud.kv/get", "tinycloud.kv/put"]),
      cid: "bafy-child",
      delegateDID: params.delegateDID,
      expiry: new Date(params.expirationSecs * 1000),
      resources: [{
        service: "kv",
        space: params.spaceId,
        path: Object.keys(params.abilities.kv)[0],
        actions: ["tinycloud.kv/get"],
      }],
    }));
    const result = await service.delegateReceivedShare(shareLink(service), {
      delegateDID: "did:key:z6MkFeedHost",
      actions: ["tinycloud.kv/get"],
    });
    expect(result.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
