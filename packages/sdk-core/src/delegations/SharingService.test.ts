import { describe, expect, mock, test } from "bun:test";
import type { ResourceTransport, ServiceSession } from "@tinycloud/sdk-services";
import { PartialNodeWriteError, routeResourceRequest } from "@tinycloud/sdk-services";
import { bases } from "multiformats/basics";
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { CapabilityKeyRegistry } from "../authorization/CapabilityKeyRegistry";
import { CaveatedDelegationUnsupportedError } from "../capabilities";
import { SharingService, type EncodedShareData } from "./SharingService";
import type { CreateDelegationWasmParams, Delegation, DelegationError, KeyProvider } from "./types";
import type { CreateDelegationParams, Result } from "./types";

const OWNER = "0xd559CCd9EB87c530A9a349262669386dE93cf412";
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:applications`;
const HOST = "https://node.tinycloud.xyz";
const PARENT_EXPIRY = new Date("2099-07-18T00:00:00.000Z");
const SHARE_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const SHARE_PUBLIC_KEY = ed25519.getPublicKey(SHARE_PRIVATE_KEY);
const SHARE_DID = `did:key:${bases.base58btc.encode(Uint8Array.from([0xed, 0x01, ...SHARE_PUBLIC_KEY]))}`;
const SHARE_X = Buffer.from(SHARE_PUBLIC_KEY).toString("base64url");
const SHARE_D = Buffer.from(SHARE_PRIVATE_KEY).toString("base64url");
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

function resourceTransportFor(fetchFn: typeof globalThis.fetch, host = HOST): ResourceTransport {
  return async (_resources, send) => send({
    url: host, nodeDid: SHARE_DID, nodeInfo: { nodeId: SHARE_DID }, fetch: fetchFn,
    bindAudience: async (authorization) => authorization,
  });
}

function childToken(params: CreateDelegationWasmParams, actions = Object.values(params.abilities.kv)[0]): string {
  const path = Object.keys(params.abilities.kv)[0];
  const payload = {
    iss: SHARE_DID,
    aud: params.delegateDID,
    exp: params.expirationSecs,
    prf: [params.session.delegationCid],
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

function makeService(options: {
  assertActive?: () => void;
  fetch?: typeof globalThis.fetch;
  routing?: boolean;
  resourceTransport?: ResourceTransport;
  session?: ServiceSession;
} = {}) {
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
  const fetch = options.fetch ?? mock(async () => new Response(null, { status: 200 }));
  const service = new SharingService({
    hosts: [HOST],
    invoke: mock(async () => ({ ok: true, data: undefined })) as never,
    fetch,
    resourceTransport: options.resourceTransport ?? (options.routing === false ? undefined : resourceTransportFor(fetch)),
    session: options.session,
    keyProvider: {} as KeyProvider,
    registry: new CapabilityKeyRegistry(),
    createKVService: mock(() => ({})) as never,
    createDelegationWasm,
    computeCid: () => "bafy-child",
    assertActive: options.assertActive,
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
      cid: PARENT_CID,
      delegateDID: SHARE_DID,
      spaceId: SPACE,
      path: "xyz.tinycloud.artifacts/artifacts/listen-import",
      actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
      expiry: PARENT_EXPIRY,
      isRevoked: false,
      allowSubDelegation: true,
      authHeader: PARENT_AUTHORIZATION,
      ...overrides,
    },
  });
}

describe("SharingService authority space comparison", () => {
  test("matches owner addresses without relaxing chain or namespace identity", () => {
    const { service } = makeService();
    const matching = {
      spaceId: SPACE.replace(OWNER, OWNER.toLowerCase()),
      path: "shared",
      actions: ["tinycloud.kv/get"],
      expiry: PARENT_EXPIRY,
      allowSubDelegation: true,
      caveats: [],
    };
    const internal = service as unknown as {
      session: { readonly spaceId: string };
      registry: {
        getAllKeys: () => { readonly id: string }[];
        getDelegationsForKey: () => typeof matching[];
        isDelegationValid: () => boolean;
      };
      classifyDelegationAuthority: (path: string, actions: string[], expiry: Date) => string;
    };
    internal.session = { spaceId: SPACE };
    internal.registry = {
      getAllKeys: () => [{ id: "session-key" }],
      getDelegationsForKey: () => [matching],
      isDelegationValid: () => true,
    };

    expect(internal.classifyDelegationAuthority("shared", ["tinycloud.kv/get"], PARENT_EXPIRY)).toBe("ok");
    for (const spaceId of [
      `${matching.spaceId}:other`,
      matching.spaceId.replace("eip155:1:", "eip155:2:"),
    ]) {
      internal.registry.getDelegationsForKey = () => [{ ...matching, spaceId }];
      expect(internal.classifyDelegationAuthority("shared", ["tinycloud.kv/get"], PARENT_EXPIRY)).toBe("not-covered");
    }
  });
});

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
      delegationCid: PARENT_CID,
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
      parentCid: PARENT_CID,
      ownerAddress: OWNER,
      chainId: 1,
      disableSubDelegation: true,
    });
    const transported = JSON.stringify(result.data);
    expect(transported).not.toContain("tc1:");
    expect(transported).not.toContain(SHARE_D);
    expect(transported).not.toContain(PARENT_AUTHORIZATION);
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

  test("rejects every meaningful parent caveat branch before signing or network access", async () => {
    const unconstrained: Array<Record<string, unknown>[] | undefined> = [undefined, [], [{}]];
    for (const caveats of unconstrained) {
      const { service, createDelegationWasm, fetch } = makeService();
      const result = await service.delegateReceivedShare(
        shareLink(service, { caveats }),
        { delegateDID: "did:key:z6MkFeedHost" },
      );
      expect(result.ok).toBe(true);
      expect(createDelegationWasm).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    }

    const constrained: Record<string, unknown>[][] = [
      [{ tenant: "alpha" }],
      [{}, { tenant: "alpha" }],
    ];
    for (const caveats of constrained) {
      const { service, createDelegationWasm, fetch } = makeService();
      const result = service.delegateReceivedShare(
        shareLink(service, { caveats }),
        { delegateDID: "did:key:z6MkFeedHost" },
      );
      await expect(result).rejects.toBeInstanceOf(CaveatedDelegationUnsupportedError);
      await expect(result).rejects.toMatchObject({
        code: "CAVEATED_DELEGATION_UNSUPPORTED",
        entries: [{ caveats }],
      });
      expect(createDelegationWasm).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  test("does not report a registered child after its service graph retires", async () => {
    let active = true;
    let releaseRegistration!: (response: Response) => void;
    let markRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      markRegistrationStarted = resolve;
    });
    const fetch = mock(() => new Promise<Response>((resolve) => {
      releaseRegistration = resolve;
      markRegistrationStarted();
    })) as unknown as typeof globalThis.fetch;
    const { service } = makeService({
      fetch,
      assertActive: () => {
        if (!active) throw new Error("retired");
      },
    });

    const result = service.delegateReceivedShare(shareLink(service), {
      delegateDID: "did:key:z6MkFeedHost",
    });
    await registrationStarted;
    active = false;
    releaseRegistration(new Response(null, { status: 200 }));

    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_INITIALIZED" },
    });
  });

  test("does not report a generated share after its service graph retires during registration", async () => {
    let active = true;
    let releaseRegistration!: (response: Response) => void;
    let markRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      markRegistrationStarted = resolve;
    });
    const fetch = mock(() => new Promise<Response>((resolve) => {
      releaseRegistration = resolve;
      markRegistrationStarted();
    })) as unknown as typeof globalThis.fetch;
    const registry = new CapabilityKeyRegistry();
    registry.registerKey({
      id: "parent-key",
      did: "did:key:z6MkParent",
      type: "session",
      priority: 0,
    }, [{
      cid: "bafy-parent",
      delegateDID: "did:key:z6MkParent",
      spaceId: SPACE,
      path: "shared",
      actions: ["tinycloud.kv/get"],
      expiry: PARENT_EXPIRY,
      isRevoked: false,
      allowSubDelegation: true,
    }]);
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
      keyProvider: {
        createSessionKey: mock(async () => "share-key"),
        getDID: mock(async () => "did:key:z6MkShare#z6MkShare"),
        getJWK: mock(() => ({ kty: "OKP", crv: "Ed25519", x: "share-x", d: "share-d" })),
      },
      registry,
      createKVService: mock(() => ({})) as never,
      createDelegationWasm: mock((params: CreateDelegationWasmParams) => ({
        delegation: "child.header.signature",
        cid: "bafy-child",
        delegateDID: params.delegateDID,
        expiry: new Date(params.expirationSecs * 1000),
        resources: [{
          service: "kv",
          space: params.spaceId,
          path: Object.keys(params.abilities.kv)[0]!,
          actions: Object.values(params.abilities.kv)[0]!,
        }],
      })),
      assertActive: () => {
        if (!active) throw new Error("retired");
      },
    });

    const result = service.generate({ path: "shared", actions: ["tinycloud.kv/get"] });
    await registrationStarted;
    active = false;
    releaseRegistration(new Response(null, { status: 200 }));

    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_INITIALIZED" },
    });
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
        resourceTransport: resourceTransportFor(globalThis.fetch, host),
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
      throw new Error(`tc1:secret ${SHARE_D} ${PARENT_AUTHORIZATION}`);
    });
    const result = await service.delegateReceivedShare(shareLink(service), {
      delegateDID: "did:key:z6MkFeedHost",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Failed to create or register the child delegation");
    expect(result.error.cause).toBeUndefined();
    expect(JSON.stringify(result.error)).not.toContain(SHARE_D);
    expect(JSON.stringify(result.error)).not.toContain(PARENT_AUTHORIZATION);
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
    const fetch = mock(async () => new Response(null, { status: 200 }));
    const service = new SharingService({
      hosts: [HOST],
      session: currentSession,
      invoke: mock(async () => ({ ok: true, data: undefined })) as never,
      fetch,
      resourceTransport: resourceTransportFor(fetch),
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

describe("SharingService.generate root-delegation signing failures", () => {
  // TC-362 follow-on: the owner-policy path re-opens the wallet/OpenKey signing
  // surface mid-compose. An unanswered prompt and a genuine authorization
  // refusal used to collapse into the same PERMISSION_DENIED message, so a
  // user who simply missed a signing popup was told they lacked permission.
  type SharingFetch = NonNullable<ConstructorParameters<typeof SharingService>[0]["fetch"]>;
  function makeGeneratingService(
    onRootDelegationNeeded: NonNullable<
      ConstructorParameters<typeof SharingService>[0]["onRootDelegationNeeded"]
    >,
    fetcher?: SharingFetch,
    registry = new CapabilityKeyRegistry(),
    transport?: ResourceTransport,
    host = HOST,
  ): SharingService {
    const shareJwk = { kty: "OKP", crv: "Ed25519", x: SHARE_X, d: SHARE_D };
    return new SharingService({
      hosts: [host],
      resourceTransport: transport,
      invoke: mock(async () => ({ ok: true, data: undefined })) as never,
      fetch: fetcher ?? (async () => new Response(null, { status: 200 })),
      keyProvider: {
        createSessionKey: (name: string) => name,
        getDID: () => `${SHARE_DID}#${SHARE_DID.slice("did:key:".length)}`,
        getJWK: () => shareJwk,
      } as unknown as KeyProvider,
      registry,
      createKVService: mock(() => ({})) as never,
      createDelegationWasm: mock((params: CreateDelegationWasmParams) => ({
        delegation: childToken(params),
        cid: "bafy-child",
        delegateDID: params.delegateDID,
        expiry: new Date(params.expirationSecs * 1000),
        resources: [{
          service: "kv",
          space: params.spaceId,
          path: Object.keys(params.abilities.kv)[0]!,
          actions: Object.values(params.abilities.kv)[0]!,
        }],
      })),
      computeCid: () => "bafy-child",
      session: {
        spaceId: SPACE,
        delegationCid: "bafy-session",
        verificationMethod: "did:key:zSession#zSession",
        jwk: shareJwk,
      } as unknown as ServiceSession,
      onRootDelegationNeeded,
    });
  }

  test("generate preserves real partial registration receipts and cause", async () => {
    const boundary = partialRegistrationTransport();
    try {
      const registry = new CapabilityKeyRegistry();
      registry.registerKey({ id: "parent", did: SHARE_DID, type: "session", priority: 0 }, [{
        cid: PARENT_CID, delegateDID: SHARE_DID, spaceId: SPACE, path: "shared",
        actions: ["tinycloud.kv/get"], expiry: PARENT_EXPIRY, isRevoked: false, allowSubDelegation: true,
      }]);
      const service = makeGeneratingService(async () => undefined, undefined, registry, boundary.transport);
      const result = await service.generate({ path: "shared", actions: ["tinycloud.kv/get"], expiry: PARENT_EXPIRY });
      assertPartialRegistration(result, boundary);
    } finally { boundary.server.stop(true); }
  });

  test("generate retains partial receipts when its graph retires during registration", async () => {
    const boundary = partialRegistrationTransport();
    try {
      const registry = new CapabilityKeyRegistry();
      registry.registerKey({ id: "parent", did: SHARE_DID, type: "session", priority: 0 }, [{
        cid: PARENT_CID, delegateDID: SHARE_DID, spaceId: SPACE, path: "shared",
        actions: ["tinycloud.kv/get"], expiry: PARENT_EXPIRY, isRevoked: false, allowSubDelegation: true,
      }]);
      const service = makeGeneratingService(async () => undefined, undefined, registry, boundary.transport);
      service.updateConfig({ assertActive: () => {
        if (boundary.failure) throw new Error("retired graph");
      } });
      const result = await service.generate({ path: "shared", actions: ["tinycloud.kv/get"], expiry: PARENT_EXPIRY });
      assertPartialRegistration(result, boundary);
    } finally { boundary.server.stop(true); }
  });

  for (const adapter of ["root callback", "fallback result"] as const) {
    test(`generate preserves real partial registration through its ${adapter}`, async () => {
      const boundary = partialRegistrationTransport();
      try {
        const register = () => boundary.transport([{ resource: SPACE, access: "write" }], (target) =>
          target.fetch(`${target.url}/delegate`, { method: "POST", redirect: "error" }));
        const registry = new CapabilityKeyRegistry();
        if (adapter === "fallback result") {
          registry.registerKey({ id: "parent", did: SHARE_DID, type: "session", priority: 0 }, [{
            cid: PARENT_CID, delegateDID: SHARE_DID, spaceId: SPACE, path: "shared",
            actions: ["tinycloud.kv/get"], expiry: PARENT_EXPIRY, isRevoked: false, allowSubDelegation: true,
          }]);
        }
        const service = new SharingService({
          hosts: [HOST], session: { spaceId: SPACE } as ServiceSession,
          invoke: () => ({}), registry, createKVService: () => ({}) as never,
          keyProvider: {
            createSessionKey: (name: string) => name,
            getDID: () => SHARE_DID,
            getJWK: () => ({ kty: "OKP", crv: "Ed25519", x: SHARE_X, d: SHARE_D }),
          } as unknown as KeyProvider,
          createDelegation: async () => {
            try { await register(); throw new Error("expected partial registration"); }
            catch (error) {
              if (!(error instanceof PartialNodeWriteError)) throw error;
              return { ok: false, error: { code: error.code, message: error.message, service: "delegation",
                cause: error, meta: { succeeded: error.succeeded, failed: error.failed } } };
            }
          },
          onRootDelegationNeeded: async () => { await register(); return undefined; },
        });
        const result = await service.generate({ path: "shared", actions: ["tinycloud.kv/get"], expiry: PARENT_EXPIRY });
        assertPartialRegistration(result, boundary);
      } finally { boundary.server.stop(true); }
    });
  }

  test("generate refuses a native same-origin 307 before forwarding the delegation bearer", async () => {
    let observed = 0;
    let sends = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/observer") { observed++; return new Response(null); }
      sends++;
      return new Response(null, { status: 307, headers: { location: "/observer" } });
    } });
    try {
      const registry = new CapabilityKeyRegistry();
      registry.registerKey({ id: "parent", did: SHARE_DID, type: "session", priority: 0 }, [{
        cid: PARENT_CID, delegateDID: SHARE_DID, spaceId: SPACE, path: "shared",
        actions: ["tinycloud.kv/get"], expiry: PARENT_EXPIRY, isRevoked: false, allowSubDelegation: true,
      }]);
      const service = makeGeneratingService(async () => undefined, globalThis.fetch.bind(globalThis), registry, undefined, server.url.origin);
      await service.generate({ path: "shared", actions: ["tinycloud.kv/get"], expiry: PARENT_EXPIRY });
      expect(sends).toBe(1);
      expect(observed).toBe(0);
    } finally { server.stop(true); }
  });

  test("preserves registration 403 as a typed authorization failure through generate", async () => {
    const registry = new CapabilityKeyRegistry();
    registry.registerKey({
      id: "parent-key",
      did: "did:key:z6MkParent",
      type: "session",
      priority: 0,
    }, [{
      cid: "bafy-parent",
      delegateDID: "did:key:z6MkParent",
      spaceId: SPACE,
      path: "shared",
      actions: ["tinycloud.kv/get"],
      expiry: PARENT_EXPIRY,
      isRevoked: false,
      allowSubDelegation: true,
    }]);
    const fetcher: SharingFetch = async () => new Response("secret upstream body", { status: 403 });
    const service = makeGeneratingService(async () => undefined, fetcher, registry);

    const result = await service.generate({
      path: "shared",
      actions: ["tinycloud.kv/get"],
      expiry: PARENT_EXPIRY,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected authorization failure");
    expect(result.error.code).toBe("AUTH_UNAUTHORIZED");
    expect(result.error.meta).toEqual({ status: 403 });
    expect(result.error.message).toContain("Failed to register delegation with server: 403 secret upstream body");
  });

  test("reports an unanswered signing prompt as TIMEOUT, not PERMISSION_DENIED", async () => {
    const service = makeGeneratingService(async () => {
      throw Object.assign(new Error("Request timed out."), { code: "TIMEOUT" });
    });

    const result = await service.generate({
      path: "shared",
      actions: ["tinycloud.kv/get"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TIMEOUT");
    expect(result.error.message).toContain("Timed out waiting for the signature");
    expect(result.error.cause).toBeInstanceOf(Error);
  });

  test("reports a cancelled signing prompt as ABORTED", async () => {
    const service = makeGeneratingService(async () => {
      throw Object.assign(new Error("User rejected the request"), {
        name: "AbortError",
      });
    });

    const result = await service.generate({
      path: "shared",
      actions: ["tinycloud.kv/get"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ABORTED");
  });

  test("still reports a genuine authorization failure as PERMISSION_DENIED", async () => {
    const service = makeGeneratingService(async () => {
      throw Object.assign(new Error("Request failed"), { code: "403" });
    });

    const result = await service.generate({
      path: "shared",
      actions: ["tinycloud.kv/get"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PERMISSION_DENIED");
    expect(result.error.message).toContain(
      "The active session ReCap does not authorize",
    );
  });

  describe("preflightGenerate", () => {
    const SHARE_PATH = "xyz.tinycloud.share/shares/abc/report.md";
    function registryWith(entries: Array<{ path: string; actions: string[]; caveats?: Record<string, unknown>[] }>): CapabilityKeyRegistry {
      const registry = new CapabilityKeyRegistry();
      registry.registerKey({ id: "session-key", did: "did:key:z6MkSession", type: "session", priority: 0 }, entries.map((entry, index) => ({
        cid: `bafy-session-${index}`,
        delegateDID: "did:key:z6MkSession",
        spaceId: SPACE,
        expiry: PARENT_EXPIRY,
        isRevoked: false,
        allowSubDelegation: true,
        ...entry,
      })));
      return registry;
    }
    const request = { path: SHARE_PATH, actions: ["tinycloud.kv/get"], expiry: PARENT_EXPIRY };

    test("is ok when an uncaveated entry covers the share, even beside caveated ones", async () => {
      const service = makeGeneratingService(async () => undefined, undefined, registryWith([
        { path: "", actions: ["tinycloud.capabilities/read"], caveats: [{ tenant: "alpha" }] },
        { path: "shares/", actions: ["tinycloud.kv/get"], caveats: [{ tenant: "alpha" }] },
        { path: "xyz.tinycloud.share/shares/", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] },
      ]));
      expect(service.preflightGenerate(request)).toBe("ok");
      expect((await service.generate(request)).ok).toBe(true);
    });

    test("is caveated when only caveated entries cover the share, matching generate's refusal", async () => {
      const service = makeGeneratingService(async () => undefined, undefined, registryWith([
        { path: "xyz.tinycloud.share/shares/", actions: ["tinycloud.kv/get", "tinycloud.kv/put"], caveats: [{ tenant: "alpha" }] },
      ]));
      expect(service.preflightGenerate(request)).toBe("caveated");
      const generated = await service.generate(request);
      expect(generated.ok).toBe(false);
      if (generated.ok) return;
      expect(generated.error.code).toBe("PERMISSION_DENIED");
    });

    test("is not-covered when no entry grants the path, action or lifetime", () => {
      const caveatedElsewhere = makeGeneratingService(async () => undefined, undefined, registryWith([
        { path: "shares/", actions: ["tinycloud.kv/get"], caveats: [{ tenant: "alpha" }] },
        { path: "xyz.tinycloud.share/shares/", actions: ["tinycloud.kv/put"] },
      ]));
      expect(caveatedElsewhere.preflightGenerate(request)).toBe("not-covered");
      const covering = makeGeneratingService(async () => undefined, undefined, registryWith([
        { path: "xyz.tinycloud.share/shares/", actions: ["tinycloud.kv/get"] },
      ]));
      expect(covering.preflightGenerate({ ...request, expiry: new Date(PARENT_EXPIRY.getTime() + 1000) })).toBe("not-covered");
    });

    test.each(["tinycloud.kv/sync", "tinycloud.kv/retain"])("a * or tinycloud.kv/* entry never covers %s, so generate asks for a root delegation", async (action) => {
      const explicitRequest = { ...request, actions: [action] };
      for (const wildcard of ["*", "tinycloud.kv/*"]) {
        const onRoot = mock(async () => undefined);
        const service = makeGeneratingService(onRoot, undefined, registryWith([
          { path: "", actions: [wildcard] },
        ]));
        expect(service.preflightGenerate(request)).toBe("ok");
        expect(service.preflightGenerate(explicitRequest)).toBe("not-covered");
        const generated = await service.generate(explicitRequest);
        expect(generated.ok).toBe(false);
        expect(onRoot).toHaveBeenCalledTimes(1);
      }

      const named = makeGeneratingService(mock(async () => undefined), undefined, registryWith([
        { path: "", actions: [action] },
      ]));
      expect(named.preflightGenerate(explicitRequest)).toBe("ok");
    });
  });
});

describe("SharingService non-transferable shares", () => {
  const PATH = "shared";
  const ACTIONS = ["tinycloud.kv/get"];

  function makeGenerateService(options: { wasm?: boolean; registryCoverage?: boolean } = {}) {
    const registry = new CapabilityKeyRegistry();
    if (options.registryCoverage !== false) {
      registry.registerKey({
        id: "parent-key",
        did: "did:key:z6MkParent",
        type: "session",
        priority: 0,
      }, [{
        cid: "bafy-parent",
        delegateDID: "did:key:z6MkParent",
        spaceId: SPACE,
        path: PATH,
        actions: ACTIONS,
        expiry: PARENT_EXPIRY,
        isRevoked: false,
        allowSubDelegation: true,
      }]);
    }
    const session: ServiceSession = {
      delegationHeader: { Authorization: "parent.header.signature" },
      delegationCid: "bafy-parent",
      spaceId: SPACE,
      verificationMethod: "did:key:z6MkParent#z6MkParent",
      jwk: { kty: "OKP", crv: "Ed25519", x: "parent-x", d: "parent-d" },
    };
    const createDelegationWasm = mock((params: CreateDelegationWasmParams) => ({
      delegation: childToken(params, ACTIONS),
      cid: "bafy-child",
      delegateDID: params.delegateDID,
      expiry: new Date(params.expirationSecs * 1000),
      resources: [{ service: "kv", space: params.spaceId, path: PATH, actions: ACTIONS }],
    }));
    const createDelegation = mock(async (params: CreateDelegationParams): Promise<Result<Delegation, DelegationError>> => ({
      ok: true as const,
      data: {
        cid: "bafy-fallback",
        delegateDID: params.delegateDID,
        spaceId: SPACE,
        path: params.path,
        actions: params.actions,
        expiry: params.expiry ?? PARENT_EXPIRY,
        isRevoked: false,
        authHeader: "fallback.header.signature",
        allowSubDelegation: !params.disableSubDelegation,
        createdAt: new Date(),
      },
    }));
    const onRootDelegationNeeded = mock(async () => {
      throw new Error("root delegation path must not run for a non-transferable share");
    });
    const service = new SharingService({
      hosts: [HOST],
      session,
      invoke: mock(async () => ({ ok: true, data: undefined })) as never,
      fetch: mock(async () => new Response(null, { status: 200 })) as unknown as typeof globalThis.fetch,
      keyProvider: {
        createSessionKey: mock(async () => "share-key"),
        getDID: mock(async () => "did:key:z6MkShare#z6MkShare"),
        getJWK: mock(() => ({ kty: "OKP", crv: "Ed25519", x: "share-x", d: "share-d" })),
      } as unknown as KeyProvider,
      registry,
      createKVService: mock(() => ({})) as never,
      createDelegationWasm: options.wasm === false ? undefined : createDelegationWasm,
      createDelegation,
      onRootDelegationNeeded,
      computeCid: () => "bafy-child",
    });
    return { service, createDelegationWasm, createDelegation, onRootDelegationNeeded };
  }

  test("defaults to a transferable share with the terminal fact absent", async () => {
    const { service, createDelegationWasm } = makeGenerateService();

    const result = await service.generate({ path: PATH, actions: ACTIONS });

    expect(result.ok).toBe(true);
    expect(createDelegationWasm.mock.calls[0]?.[0].disableSubDelegation).toBe(false);
    if (!result.ok) throw new Error("expected share");
    expect(result.data.delegation.allowSubDelegation).toBe(true);
  });

  test("mints a terminal delegation through the WASM path when allowSubDelegation is false", async () => {
    const { service, createDelegationWasm } = makeGenerateService();

    const result = await service.generate({ path: PATH, actions: ACTIONS, allowSubDelegation: false });

    expect(result.ok).toBe(true);
    expect(createDelegationWasm.mock.calls[0]?.[0].disableSubDelegation).toBe(true);
    if (!result.ok) throw new Error("expected share");
    expect(result.data.delegation.allowSubDelegation).toBe(false);
  });

  test("mints a terminal delegation through the fallback path when allowSubDelegation is false", async () => {
    const { service, createDelegation } = makeGenerateService({ wasm: false });

    const result = await service.generate({ path: PATH, actions: ACTIONS, allowSubDelegation: false });

    expect(result.ok).toBe(true);
    expect(createDelegation.mock.calls[0]?.[0].disableSubDelegation).toBe(true);
    if (!result.ok) throw new Error("expected share");
    expect(result.data.delegation.allowSubDelegation).toBe(false);
  });

  test("keeps the fallback delegation transferable by default", async () => {
    const { service, createDelegation } = makeGenerateService({ wasm: false });

    const result = await service.generate({ path: PATH, actions: ACTIONS });

    expect(result.ok).toBe(true);
    expect(createDelegation.mock.calls[0]?.[0].disableSubDelegation).toBe(false);
  });

  test("refuses a non-transferable share the session key registry does not cover, without the wallet root path", async () => {
    const { service, createDelegationWasm, onRootDelegationNeeded } = makeGenerateService({ registryCoverage: false });

    const result = await service.generate({ path: PATH, actions: ACTIONS, allowSubDelegation: false });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message: "The active session ReCap does not authorize this sharing delegation.",
      },
    });
    expect(createDelegationWasm).not.toHaveBeenCalled();
    expect(onRootDelegationNeeded).not.toHaveBeenCalled();
  });

  test("round-trips allowSubDelegation through the encoded link", () => {
    const { service } = makeService();

    const terminal = service.decodeLink(shareLink(service, { allowSubDelegation: false }));
    const transferable = service.decodeLink(shareLink(service, { allowSubDelegation: true }));

    expect(terminal.delegation.allowSubDelegation).toBe(false);
    expect(transferable.delegation.allowSubDelegation).toBe(true);
  });

  test("viewer refuses to onward-delegate a link issued as non-transferable", async () => {
    const { service } = makeService();

    const result = await service.delegateReceivedShare(
      shareLink(service, { allowSubDelegation: false }),
      { delegateDID: "did:key:z6MkFeedHost", actions: ["tinycloud.kv/get"] },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED", message: "Sharing link does not allow delegation" },
    });
  });

  test("keeps allowSubDelegation:false through encodeLink/decodeLink and refuses the re-encoded link", async () => {
    const { service } = makeService();

    const decoded = service.decodeLink(shareLink(service, { allowSubDelegation: false }));
    const reencoded = service.encodeLink(decoded);

    expect(service.decodeLink(reencoded)).toEqual(decoded);
    expect(service.decodeLink(reencoded).delegation.allowSubDelegation).toBe(false);
    expect(await service.delegateReceivedShare(reencoded, {
      delegateDID: "did:key:z6MkFeedHost",
      actions: ["tinycloud.kv/get"],
    })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED", message: "Sharing link does not allow delegation" },
    });
  });

  test("receives a non-transferable share with autoSubdelegate:false", async () => {
    const { service } = makeService();

    const result = await service.receive(shareLink(service, { allowSubDelegation: false }), {
      autoSubdelegate: false,
    });

    expect(result.ok).toBe(true);
  });
});

for (const operation of ["delegate", "receive"] as const) {
  test(`standalone ${operation} refuses a recorded-host link without resource routing`, async () => {
    const { service, createDelegationWasm, fetch } = makeService({ routing: false });
    const link = shareLink(service);
    const result = operation === "delegate"
      ? await service.delegateReceivedShare(link, { delegateDID: SHARE_DID })
      : await service.receive(link, { autoSubdelegate: false });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_INITIALIZED" } });
    expect(createDelegationWasm).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
}

function partialRegistrationTransport() {
  const writes: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    writes.push(path);
    return path === "/first/delegate" ? Response.json({ activated: [SPACE] }) : new Response("refused", { status: 403 });
  } });
  let failure: unknown;
  const transport: ResourceTransport = async (resources, send, options) => {
    try {
      return await routeResourceRequest(resources, {
        resolveResource: async () => [{ url: `${server.url.origin}/first` }, { url: `${server.url.origin}/second` }],
      }, (target) => send({
        ...target, nodeDid: SHARE_DID, nodeInfo: { nodeId: SHARE_DID },
        fetch: globalThis.fetch.bind(globalThis), bindAudience: async (authorization) => authorization,
      }), options);
    } catch (error) { failure = error; throw error; }
  };
  return { server, transport, writes, get failure() { return failure; } };
}

function assertPartialRegistration(
  result: { ok: boolean; error?: DelegationError },
  boundary: { writes: string[]; readonly failure: unknown },
) {
  expect(boundary.writes).toEqual(["/first/delegate", "/second/delegate"]);
  expect(boundary.failure).toBeInstanceOf(PartialNodeWriteError);
  const partial = boundary.failure as PartialNodeWriteError;
  expect(result).toMatchObject({ ok: false, error: {
    code: "PARTIAL_NODE_WRITE", meta: { succeeded: partial.succeeded, failed: partial.failed },
  } });
  expect(result.error?.cause).toBe(partial);
}

for (const operation of ["delegateReceivedShare", "receive"] as const) {
  test(`${operation} preserves real partial registration receipts and cause`, async () => {
    const boundary = partialRegistrationTransport();
    try {
      const { service } = makeService({ resourceTransport: boundary.transport, session: {
        spaceId: SPACE, verificationMethod: "did:key:z6MkFeedHost",
      } as ServiceSession });
      const link = shareLink(service);
      const result = operation === "receive"
        ? await service.receive(link)
        : await service.delegateReceivedShare(link, { delegateDID: "did:key:z6MkFeedHost" });
      assertPartialRegistration(result, boundary);
    } finally { boundary.server.stop(true); }
  });
}
