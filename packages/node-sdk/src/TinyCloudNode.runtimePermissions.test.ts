import { describe, expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";

import {
  authorizationVerdictOf,
  CaveatedDelegationUnsupportedError,
  ErrorCodes,
  canonicalHashHex,
  hexEncode,
  encryptionBase64Decode,
  encryptionBase64Encode,
  encryptionUtf8Encode,
  type DecryptRequestBody,
  type DecryptResponseBody,
  type EncryptionCrypto,
  type ISessionManager,
  type IWasmBindings,
  type NetworkDescriptor,
  type PermissionEntry,
  ServiceContext,
  PermissionNotInManifestError,
} from "@tinycloud/sdk-core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";
import { DEFAULT_DELEGATION_EXPIRY_MS } from "./delegateToHelpers";
const revokeTargetCid = "bafkr4id4zlugcezsh7a5op53hdbepyi2buq5wx6s2czglg2xchvxeqqmn4";

function makeFakeSessionManager(): ISessionManager {
  return {
    createSessionKey: (id: string) => id,
    replaceSessionKey: (_jwk: object, keyId: string) => keyId,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
}

function makeFakeWasmBindings(
  invoke: IWasmBindings["invoke"],
): IWasmBindings {
  return {
    invoke,
    invokeAny: mock(() => ({})) as any,
    prepareSession: mock((cfg: any) => ({
      siwe: "runtime-siwe",
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: "did:key:runtime",
    })),
    completeSessionSetup: mock((cfg: any) => ({
      delegationHeader: { Authorization: "runtime-token" },
      delegationCid: "runtime-cid",
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: cfg.verificationMethod,
    })),
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    createDelegation: mock((_session, delegateDID, spaceId, abilities) => {
      const resources = Object.entries(abilities).flatMap(
        ([service, paths]: [string, any]) =>
          Object.entries(paths).map(([path, actions]) => ({
            service,
            space: service === "encryption" ? "encryption" : spaceId,
            path,
            actions: actions as string[],
          })),
      ).sort((a, b) =>
        a.service.localeCompare(b.service) || a.path.localeCompare(b.path)
      );
      return {
        delegation: "child-runtime-token",
        cid: "child-runtime-cid",
        delegateDid: delegateDID,
        expiry: Math.floor((Date.now() + 3600_000) / 1000),
        resources,
      };
    }),
    parseRecapFromSiwe: mock(() => []),
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    vault_encrypt: mock(() => new Uint8Array()),
    vault_decrypt: mock(() => new Uint8Array()),
    vault_derive_key: mock(() => new Uint8Array()),
    vault_x25519_from_seed: mock(() => ({
      publicKey: new Uint8Array(),
      privateKey: new Uint8Array(),
    })),
    vault_x25519_dh: mock(() => new Uint8Array()),
    vault_random_bytes: mock(() => new Uint8Array()),
    vault_sha256: mock(() => new Uint8Array()),
    createSessionManager: makeFakeSessionManager,
    computeCid: () => "bafy-node-secret-read",
  };
}

function xor(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(right.length);
  for (let i = 0; i < right.length; i++) {
    out[i] = left[i % left.length] ^ right[i % right.length];
  }
  return out;
}

function deterministicSha256(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  for (let i = 0; i < bytes.length; i++) {
    h0 = ((h0 + bytes[i] * 31) ^ ((h0 << 5) | (h0 >>> 27))) >>> 0;
    h1 = ((h1 ^ (bytes[i] + 17)) + ((h1 << 7) | (h1 >>> 25))) >>> 0;
  }
  for (let i = 0; i < 16; i++) {
    out[i] = (h0 >>> ((i % 4) * 8)) & 0xff;
    out[i + 16] = (h1 >>> ((i % 4) * 8)) & 0xff;
    h0 = (h0 * 1103515245 + 12345) >>> 0;
    h1 = (h1 * 1664525 + 1013904223) >>> 0;
  }
  return out;
}

function makeEncryptionCrypto(): EncryptionCrypto {
  let seed = 0xdeadbeef;
  const randomBytes = (length: number): Uint8Array => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      out[i] = seed & 0xff;
    }
    return out;
  };

  return {
    sha256: deterministicSha256,
    randomBytes,
    x25519FromSeed: (seedBytes) => ({
      publicKey: seedBytes,
      privateKey: seedBytes,
    }),
    x25519Dh: (priv, pub) => deterministicSha256(xor(priv, pub)),
    authEncrypt: (key, plaintext, aad) => {
      const mixedKey = aad === undefined ? key : deterministicSha256(xor(key, aad));
      return xor(mixedKey, plaintext);
    },
    authDecrypt: (key, ciphertext, aad) => {
      const mixedKey = aad === undefined ? key : deterministicSha256(xor(key, aad));
      return xor(mixedKey, ciphertext);
    },
    sealToNetworkKey: (networkPublicKey, symmetricKey) => xor(networkPublicKey, symmetricKey),
    openWithReceiverKey: (receiverPrivateKey, wrappedKey) => xor(receiverPrivateKey, wrappedKey),
    verifyNodeSignature: () => true,
  };
}

function makeEncryptionDescriptor(networkId: string, nodeDid: string): NetworkDescriptor {
  return {
    networkId,
    ownerDid: nodeDid,
    name: "default",
    members: [{ nodeId: nodeDid, role: "primary" }],
    threshold: { n: 1, t: 1 },
    state: "active",
    publicEncryptionKey: encryptionBase64Encode(new Uint8Array(32).fill(11)),
    alg: "x25519-aes256gcm/v1",
    keyVersion: 1,
    keyBackend: "local-one-of-one",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
}

function makeNode(invoke: IWasmBindings["invoke"]): TinyCloudNode {
  const signer = {
    getAddress: async () => "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    getChainId: async () => 1,
    signMessage: mock(async () => "0xsig"),
  };
  const node = new TinyCloudNode({
    host: "https://tinycloud.test",
    signer: signer as any,
    wasmBindings: makeFakeWasmBindings(invoke),
  });
  const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
  const siwe = `tinycloud.test wants you to sign in with your Ethereum account:
${address}

Sign in.

URI: https://tinycloud.test
Version: 1
Chain ID: 1
Nonce: 32891756
Issued At: 2026-05-05T00:00:00.000Z
Expiration Time: 2999-01-01T00:00:00.000Z`;
  (node as any).auth = {
    tinyCloudSession: {
      address,
      chainId: 1,
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
      sessionKey: "default",
      siwe,
      spaceId: `tinycloud:pkh:eip155:1:${address}:default`,
      verificationMethod: "did:key:default",
    },
  };
  return node;
}


async function withActivatedDelegations(fn: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ activated: ["runtime-cid"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as any;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("TinyCloudNode runtime permission delegations", () => {
  test("routes an explicit secret read through activated KV and decrypt delegations", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const secretsSpaceId = `tinycloud:pkh:eip155:1:${address}:delegated-secrets`;
    (node as any)._address = address;
    const networkId = node.getEncryptionNetworkIdForSpace(secretsSpaceId);
    const descriptor = makeEncryptionDescriptor(networkId, node.did);
    const crypto = makeEncryptionCrypto();
    (node as any).createEncryptionCrypto = () => crypto;
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    (node as any).auth.tinyCloudSession.jwk = jwk;

    const permissions: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: secretsSpaceId,
        path: "vault/secrets/ANTHROPIC_API_KEY",
        actions: ["tinycloud.kv/get"],
      },
      {
        service: "tinycloud.encryption",
        path: networkId,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ];

    await withActivatedDelegations(async () => {
      await node.grantRuntimePermissions(permissions);
    });

    const encryptionInvocations: string[] = [];
    const unsignedAuthorization = [
      Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url"),
      Buffer.from(JSON.stringify({ aud: "placeholder" })).toString("base64url"),
      "signature",
    ].join(".");
    (node as any).wasmBindings.invokeAny = mock((session: any) => {
      encryptionInvocations.push(session.delegationHeader.Authorization);
      return { Authorization: unsignedAuthorization };
    });

    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ method: string; url: string; body?: string }> = [];
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : undefined;
      fetchCalls.push({ method, url, body });
      const networkUrl =
        `https://tinycloud.test/encryption/networks/${encodeURIComponent(networkId)}`;
      if (method === "GET" && url === networkUrl) {
        return new Response(JSON.stringify({ descriptor }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && url === `${networkUrl}/decrypt`) {
        if (!body) throw new Error("missing decrypt body");
        const request = JSON.parse(body) as DecryptRequestBody;
        const symmetricKey = xor(
          encryptionBase64Decode(descriptor.publicEncryptionKey),
          encryptionBase64Decode(request.encryptedSymmetricKey),
        );
        const wrappedKey = xor(
          encryptionBase64Decode(request.receiverPublicKey),
          symmetricKey,
        );
        const invocationCid = "bafy-node-secret-read";
        const requestBodyHash = canonicalHashHex(crypto.sha256, request as any);
        const response: DecryptResponseBody = {
          type: "tinycloud.encryption.decrypt-result/v1",
          targetNode: request.targetNode,
          networkId: request.networkId,
          invocationCid,
          encryptedSymmetricKeyHash: request.encryptedSymmetricKeyHash,
          receiverPublicKeyHash: request.receiverPublicKeyHash,
          wrappedKey: encryptionBase64Encode(wrappedKey),
          alg: request.alg,
          keyVersion: request.keyVersion,
          requestHash: hexEncode(
            crypto.sha256(
              encryptionUtf8Encode(`${invocationCid}${requestBodyHash}`),
            ),
          ),
          nodeId: node.did,
          nodeSignature: encryptionBase64Encode(new Uint8Array(64).fill(9)),
        };
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const encryption = (node as any).createEncryptionService();
      const secret = {
        value: "secret value",
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z",
      };
      const encrypted = await encryption.encryptToNetwork(
        networkId,
        encryptionUtf8Encode(JSON.stringify(secret)),
        { metadata: { "x-vault-content-type": "application/json" } },
      );
      expect(encrypted.ok).toBe(true);
      if (!encrypted.ok) return;

      const fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe("runtime-token");
        return new Response(JSON.stringify(encrypted.data), { status: 200 });
      }) as any;
    const context = new ServiceContext({
      invoke: (node as any).invokeWithRuntimePermissions,
      fetch,
      hosts: ["https://tinycloud.test"],
    });
    context.setSession({
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: `tinycloud:pkh:eip155:1:${address}:default`,
      verificationMethod: "did:key:default",
      jwk,
    });
    (node as any)._serviceContext = context;
    (node as any)._spaceService = {};

    await expect(node.readSecret({
      space: secretsSpaceId,
      name: "ANTHROPIC_API_KEY",
    })).resolves.toEqual({ status: "ok", value: "secret value" });

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(encryptionInvocations).toEqual(["runtime-token"]);
      expect(invoke.mock.calls[invoke.mock.calls.length - 1][0].delegationHeader.Authorization)
        .toBe("runtime-token");
      expect(fetchCalls.some((call) => call.url.endsWith("/decrypt"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    { label: "plain-text 401", status: 401, hint: "none" },
    { label: "structured 403 naming another network", status: 403, hint: "other-network" },
    { label: "structured 401 naming a KV read", status: 401, hint: "kv-read" },
  ] as const)("classifies a decrypt $label as missing decrypt authority on the requested network", async ({ status, hint }) => {
    const node = makeNode(mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const secretsSpaceId = `tinycloud:pkh:eip155:1:${address}:secrets`;
    (node as any)._address = address;
    const networkId = node.getEncryptionNetworkIdForSpace(secretsSpaceId);
    const descriptor = makeEncryptionDescriptor(networkId, node.did);
    const crypto = makeEncryptionCrypto();
    (node as any).createEncryptionCrypto = () => crypto;
    const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    (node as any).auth.tinyCloudSession.jwk = jwk;
    (node as any).wasmBindings.invokeAny = mock(() => ({
      Authorization: [
        Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url"),
        Buffer.from(JSON.stringify({ aud: "placeholder" })).toString("base64url"),
        "signature",
      ].join("."),
    }));

    const networkUrl = `https://tinycloud.test/encryption/networks/${encodeURIComponent(networkId)}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url === networkUrl) return Response.json({ descriptor });
      if (method === "POST" && url === `${networkUrl}/decrypt`) {
        if (hint === "other-network") {
          return Response.json({
            permissionHint: {
              service: "tinycloud.encryption",
              path: "urn:tinycloud:encryption:did:key:z6MkOther:default",
              actions: ["tinycloud.encryption/decrypt"],
            },
          }, { status });
        }
        if (hint === "kv-read") {
          return Response.json({
            error: {
              permissionHint: {
                service: "tinycloud.kv",
                space: secretsSpaceId,
                path: "vault/secrets/OPENAI_API_KEY",
                actions: ["tinycloud.kv/get"],
              },
            },
          }, { status });
        }
        // Production nodes may deny with plain text and no structured hint.
        return new Response(`Unauthorized Action: ${networkId} / tinycloud.encryption/decrypt`, { status });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as typeof fetch;

    try {
      const encrypted = await (node as any).createEncryptionService().encryptToNetwork(
        networkId,
        encryptionUtf8Encode(JSON.stringify({ value: "secret value" })),
        { metadata: { "x-vault-content-type": "application/json" } },
      );
      expect(encrypted.ok).toBe(true);
      const context = new ServiceContext({
        invoke: (node as any).invokeWithRuntimePermissions,
        fetch: mock(async () => new Response(JSON.stringify(encrypted.data), { status: 200 })) as any,
        hosts: ["https://tinycloud.test"],
      });
      context.setSession({
        delegationHeader: { Authorization: "base-token" },
        delegationCid: "base-cid",
        spaceId: `tinycloud:pkh:eip155:1:${address}:default`,
        verificationMethod: "did:key:default",
        jwk,
      });
      (node as any)._serviceContext = context;
      (node as any)._spaceService = {};

      await expect(node.readSecret({ space: secretsSpaceId, name: "OPENAI_API_KEY" })).resolves.toEqual({
        status: "permission_required",
        hint: {
          service: "tinycloud.encryption",
          path: networkId,
          actions: ["tinycloud.encryption/decrypt"],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("failed runtime grant activation preserves the host verdict and diagnostic", async () => {
    const node = makeNode(mock(() => ({})) as IWasmBindings["invoke"]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response("Unauthorized Action: missing capability", { status: 403 }),
    ) as unknown as typeof fetch;
    try {
      await node.grantRuntimePermissions([{
        service: "tinycloud.kv",
        space: "secrets",
        path: "vault/secrets/API_KEY",
        actions: ["tinycloud.kv/get"],
      }]).then(
        () => { throw new Error("expected activation failure"); },
        (error: unknown) => {
          expect((error as Error).message).toContain("403 - Unauthorized Action: missing capability");
          expect((error as Error & { cause: { status: number; error: string } }).cause).toMatchObject({
            success: false,
            status: 403,
            error: "Unauthorized Action: missing capability",
          });
          expect(authorizationVerdictOf(error)).toBe("forbidden");
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses a stored runtime delegation for matching invocations", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const secretsSpaceId = `tinycloud:pkh:eip155:1:${address}:secrets`;
    const permission: PermissionEntry = {
      service: "tinycloud.kv",
      space: "secrets",
      path: "vault/secrets/ANTHROPIC_API_KEY",
      actions: ["tinycloud.kv/put"],
    };

    await withActivatedDelegations(async () => {
      const delegations = await node.grantRuntimePermissions([permission]);
      expect(delegations).toHaveLength(1);
      expect(delegations[0].delegateDID).toBe("did:key:default");
      expect(delegations[0].resources).toEqual([
        {
          service: "kv",
          space: secretsSpaceId,
          path: "vault/secrets/ANTHROPIC_API_KEY",
          actions: ["tinycloud.kv/put"],
        },
      ]);
    });

    expect(node.hasRuntimePermissions([permission])).toBe(true);
    const fallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: secretsSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeWithRuntimePermissions(
      fallback,
      "kv",
      "vault/secrets/ANTHROPIC_API_KEY",
      "tinycloud.kv/put",
    );
    expect(invoke.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "runtime-token",
    );

    (node as any).invokeWithRuntimePermissions(
      fallback,
      "kv",
      "vault/secrets/ANTHROPIC_API_KEY",
      "tinycloud.kv/get",
    );
    expect(invoke.mock.calls[1][0].delegationHeader.Authorization).toBe(
      "base-token",
    );
  });

  test("matches a runtime grant across EIP-155 address-case differences", async () => {
    // The grant stores its operation spaceId with the EIP-55 checksummed
    // address (from the session). A real invocation routed through the CLI
    // arrives with the SAME address lowercased (the CLI canonicalizes space
    // URIs to lowercase). The casing is cosmetic — the grant must still match.
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const lowercasedSpaceId = `tinycloud:pkh:eip155:1:${address.toLowerCase()}:secrets`;
    const permission: PermissionEntry = {
      service: "tinycloud.kv",
      space: "secrets",
      path: "vault/secrets/ANTHROPIC_API_KEY",
      actions: ["tinycloud.kv/put"],
    };

    await withActivatedDelegations(async () => {
      await node.grantRuntimePermissions([permission]);
    });

    // Fallback (the base session for the request) carries the lowercased
    // address; the granted operation carries the checksummed one.
    const lowercasedFallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: lowercasedSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeWithRuntimePermissions(
      lowercasedFallback,
      "kv",
      "vault/secrets/ANTHROPIC_API_KEY",
      "tinycloud.kv/put",
    );
    // Before the fix the strict spaceId === comparison missed and fell back to
    // base-token; now the case-insensitive compare selects the runtime grant.
    expect(invoke.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "runtime-token",
    );

    // Symmetry: a checksummed-address request against a grant whose op space is
    // lowercased must also match. Reinstall the grant under a lowercased space.
    const lowercaseAddrNode = (() => {
      const n = makeNode(invoke);
      (n as any).auth.tinyCloudSession.address = address.toLowerCase();
      (n as any).auth.tinyCloudSession.spaceId =
        `tinycloud:pkh:eip155:1:${address.toLowerCase()}:default`;
      return n;
    })();
    await withActivatedDelegations(async () => {
      await lowercaseAddrNode.grantRuntimePermissions([permission]);
    });
    const checksummedFallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: `tinycloud:pkh:eip155:1:${address}:secrets`,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };
    (lowercaseAddrNode as any).invokeWithRuntimePermissions(
      checksummedFallback,
      "kv",
      "vault/secrets/ANTHROPIC_API_KEY",
      "tinycloud.kv/put",
    );
    const lastCall = invoke.mock.calls[invoke.mock.calls.length - 1];
    expect(lastCall[0].delegationHeader.Authorization).toBe("runtime-token");

    // Only the address segment is case-normalized — the space NAME stays
    // case-sensitive. A request for a differently-cased NAME must NOT match the
    // grant (it falls back to the base session).
    const wrongNameFallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: `tinycloud:pkh:eip155:1:${address.toLowerCase()}:SECRETS`,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };
    (node as any).invokeWithRuntimePermissions(
      wrongNameFallback,
      "kv",
      "vault/secrets/ANTHROPIC_API_KEY",
      "tinycloud.kv/put",
    );
    const wrongNameCall = invoke.mock.calls[invoke.mock.calls.length - 1];
    expect(wrongNameCall[0].delegationHeader.Authorization).toBe("base-token");
  });

  test("does NOT match a runtime grant for a different address or chain", async () => {
    // The case-insensitive compare normalizes ONLY the casing of the eip155
    // address segment. A genuinely different owner (a different 40-hex address)
    // or a different chain id is NOT the same space and must never be covered by
    // the grant — the request falls back to the base session token.
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const permission: PermissionEntry = {
      service: "tinycloud.kv",
      space: "secrets",
      path: "vault/secrets/ANTHROPIC_API_KEY",
      actions: ["tinycloud.kv/put"],
    };

    await withActivatedDelegations(async () => {
      await node.grantRuntimePermissions([permission]);
    });

    // A request whose space embeds a DIFFERENT owner address (same length, same
    // chain, same name) must not be covered — case normalization is not address
    // equivalence.
    const otherAddress = "0xAbAdBabeAbAdBabeAbAdBabeAbAdBabeAbAdBabe";
    const otherAddressFallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: `tinycloud:pkh:eip155:1:${otherAddress}:secrets`,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };
    (node as any).invokeWithRuntimePermissions(
      otherAddressFallback,
      "kv",
      "vault/secrets/ANTHROPIC_API_KEY",
      "tinycloud.kv/put",
    );
    expect(
      invoke.mock.calls[invoke.mock.calls.length - 1][0].delegationHeader
        .Authorization,
    ).toBe("base-token");

    // A request on a DIFFERENT chain id (same address, same name) must not be
    // covered either — the chain segment is part of the space identity.
    const otherChainFallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: `tinycloud:pkh:eip155:137:${address}:secrets`,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };
    (node as any).invokeWithRuntimePermissions(
      otherChainFallback,
      "kv",
      "vault/secrets/ANTHROPIC_API_KEY",
      "tinycloud.kv/put",
    );
    expect(
      invoke.mock.calls[invoke.mock.calls.length - 1][0].delegationHeader
        .Authorization,
    ).toBe("base-token");
  });

  test("expands vault shorthand before storing runtime delegation operations", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const secretsSpaceId = `tinycloud:pkh:eip155:1:${address}:secrets`;
    const permission: PermissionEntry = {
      service: "tinycloud.vault",
      space: "secrets",
      path: "secrets/ANTHROPIC_API_KEY",
      actions: ["write"],
    };

    await withActivatedDelegations(async () => {
      const delegations = await node.grantRuntimePermissions([permission]);
      expect(delegations).toHaveLength(1);
      expect(delegations[0].resources).toEqual([
        {
          service: "kv",
          space: secretsSpaceId,
          path: "vault/secrets/ANTHROPIC_API_KEY",
          actions: ["tinycloud.kv/put"],
        },
      ]);
    });

    expect(node.hasRuntimePermissions([permission])).toBe(true);
    const prepareSession = (node as any).wasmBindings.prepareSession;
    expect(prepareSession.mock.calls[0][0].abilities).toEqual({
      kv: {
        "vault/secrets/ANTHROPIC_API_KEY": ["tinycloud.kv/put"],
      },
    });

    const fallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: secretsSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeWithRuntimePermissions(
      fallback,
      "kv",
      "vault/secrets/ANTHROPIC_API_KEY",
      "tinycloud.kv/put",
    );
    expect(invoke.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "runtime-token",
    );

    (node as any).invokeWithRuntimePermissions(
      fallback,
      "kv",
      "vault/secrets/ANTHROPIC_API_KEY",
      "tinycloud.kv/del",
    );
    expect(invoke.mock.calls[1][0].delegationHeader.Authorization).toBe(
      "base-token",
    );
  });

  test("delegateTo can derive from a stored runtime delegation", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const permission: PermissionEntry = {
      service: "tinycloud.kv",
      space: "secrets",
      path: "vault/secrets/ANTHROPIC_API_KEY",
      actions: ["tinycloud.kv/put"],
    };

    await withActivatedDelegations(async () => {
      await node.grantRuntimePermissions([permission]);
      const result = await node.delegateTo("did:key:backend", [permission]);

      expect(result.prompted).toBe(false);
      expect(result.delegation.delegateDID).toBe("did:key:backend");
      expect(result.delegation.delegationHeader.Authorization).toBe(
        "child-runtime-token",
      );
    });

    const createDelegation = (node as any).wasmBindings.createDelegation;
    expect(createDelegation).toHaveBeenCalledTimes(1);
    expect(createDelegation.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "runtime-token",
    );
  });

  test("fails closed when a caveated runtime grant would cross the action-only WASM boundary", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const spaceId = `tinycloud:pkh:eip155:1:${address}:secrets`;
    const caveats = [{ tenant: "alpha", nested: { region: "us-east-1" } }];
    const permission: PermissionEntry = {
      service: "tinycloud.kv",
      space: "secrets",
      path: "vault/secrets/ANTHROPIC_API_KEY",
      actions: ["tinycloud.kv/put"],
      caveats,
    };
    (node as any).runtimePermissionGrants = [{
      session: {
        delegationHeader: { Authorization: "runtime-token" },
        delegationCid: "runtime-cid",
        spaceId,
        verificationMethod: "did:key:default",
        jwk: { kty: "OKP" },
      },
      delegation: {
        cid: "runtime-cid",
        delegationHeader: { Authorization: "runtime-token" },
        spaceId,
        path: permission.path,
        actions: permission.actions,
        caveats,
        expiry: new Date(Date.now() + 3_600_000),
        delegateDID: "did:key:default",
        ownerAddress: address,
        chainId: 1,
      },
      operations: [{
        spaceId,
        service: "kv",
        path: permission.path,
        action: "tinycloud.kv/put",
        caveats,
      }],
      expiresAt: new Date(Date.now() + 3_600_000),
      provenance: "delegated",
    }];

    await expect(node.delegateTo("did:key:backend", [permission]))
      .rejects.toBeInstanceOf(CaveatedDelegationUnsupportedError);
    expect((node as any).wasmBindings.createDelegation).not.toHaveBeenCalled();
  });

  describe("delegateTo onPrepared on the runtime-grant path", () => {
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const spaceId = `tinycloud:pkh:eip155:1:${address}:secrets`;
    const permission: PermissionEntry = {
      service: "tinycloud.kv",
      space: "secrets",
      path: "vault/secrets/ANTHROPIC_API_KEY",
      actions: ["tinycloud.kv/put"],
    };

    // Installs a runtime grant directly (no grant-time activation request) so
    // the only `/delegate` call the spy can see is the one delegateTo makes.
    function makeNodeWithRuntimeGrant(): TinyCloudNode {
      const node = makeNode(mock(() => ({})));
      Object.assign(node, {
        runtimePermissionGrants: [{
          session: {
            delegationHeader: { Authorization: "runtime-token" },
            delegationCid: "runtime-cid",
            spaceId,
            verificationMethod: "did:key:default",
            jwk: { kty: "OKP" },
          },
          delegation: {
            cid: "runtime-cid",
            delegationHeader: { Authorization: "runtime-token" },
            spaceId,
            path: permission.path,
            actions: permission.actions,
            expiry: new Date(Date.now() + 3_600_000),
            delegateDID: "did:key:default",
            ownerAddress: address,
            chainId: 1,
          },
          operations: [{
            spaceId,
            service: "kv",
            path: permission.path,
            action: "tinycloud.kv/put",
          }],
          expiresAt: new Date(Date.now() + 3_600_000),
          provenance: "delegated",
        }],
      });
      return node;
    }

    async function withFetchSpy(
      events: string[],
      fn: () => Promise<void>,
    ): Promise<void> {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        events.push(`fetch:${String(input)}`);
        return new Response(JSON.stringify({ activated: ["child-runtime-cid"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      try {
        await fn();
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    test("hook receives the returned delegation before the activation request", async () => {
      const node = makeNodeWithRuntimeGrant();
      const events: string[] = [];
      let prepared: unknown;

      await withFetchSpy(events, async () => {
        const result = await node.delegateTo("did:key:backend", [permission], {
          onPrepared: async (delegation) => {
            events.push(`hook:${delegation.cid}`);
            prepared = delegation;
          },
        });
        expect(result.prompted).toBe(false);
        expect(prepared).toBe(result.delegation);
        expect(result.delegation.cid).toBe("child-runtime-cid");
      });

      expect(events).toEqual([
        "hook:child-runtime-cid",
        "fetch:https://tinycloud.test/delegate",
      ]);
    });

    test("rejecting hook propagates the same error and sends no activation request", async () => {
      const node = makeNodeWithRuntimeGrant();
      const events: string[] = [];
      const failure = new Error("inventory write failed");

      await withFetchSpy(events, async () => {
        await expect(
          node.delegateTo("did:key:backend", [permission], {
            onPrepared: async () => {
              events.push("hook");
              throw failure;
            },
          }),
        ).rejects.toBe(failure);
      });

      expect(events).toEqual(["hook"]);
    });
  });

  test("disableSubDelegation marks a runtime-grant delegation terminal with the grant's session key", async () => {
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const spaceId = `tinycloud:pkh:eip155:1:${address}:secrets`;
    const permission: PermissionEntry = {
      service: "tinycloud.kv",
      space: "secrets",
      path: "vault/secrets/ANTHROPIC_API_KEY",
      actions: ["tinycloud.kv/put"],
    };
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = ed25519.getPublicKey(privateKey);
    const grantDid = `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...publicKey))}`;
    const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
    const node = makeNode(mock(() => ({})));
    // The WASM builder's token: signed by the runtime grant's session key, no facts.
    const input = [
      { alg: "EdDSA", typ: "JWT", ucv: "0.10.0" },
      { iss: `${grantDid}#${grantDid.slice(8)}`, aud: "did:key:backend", exp: 1_900_000_000, prf: ["runtime-cid"], att: {} },
    ].map((part) => b64u(Buffer.from(JSON.stringify(part)))).join(".");
    const wasmToken = `${input}.${b64u(ed25519.sign(Buffer.from(input), privateKey))}`;
    Object.assign(Reflect.get(node, "wasmBindings"), { createDelegation: mock((_session: unknown, delegateDid: string, space: string) => ({
      delegation: wasmToken,
      cid: "wasm-cid",
      delegateDid,
      expiry: 1_900_000_000,
      resources: [{ service: "kv", space, path: permission.path, actions: permission.actions }],
    })) });
    Object.assign(node, {
      runtimePermissionGrants: [{
        session: {
          delegationHeader: { Authorization: "runtime-token" },
          delegationCid: "runtime-cid",
          spaceId,
          verificationMethod: `${grantDid}#${grantDid.slice(8)}`,
          jwk: { kty: "OKP", crv: "Ed25519", x: b64u(publicKey), d: b64u(privateKey) },
        },
        delegation: {
          cid: "runtime-cid",
          delegationHeader: { Authorization: "runtime-token" },
          spaceId,
          path: permission.path,
          actions: permission.actions,
          expiry: new Date(Date.now() + 3_600_000),
          delegateDID: grantDid,
          ownerAddress: address,
          chainId: 1,
        },
        operations: [{ spaceId, service: "kv", path: permission.path, action: "tinycloud.kv/put" }],
        expiresAt: new Date(Date.now() + 3_600_000),
        provenance: "delegated",
      }],
    });
    const activated: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      activated.push(new Headers(init?.headers).get("Authorization") ?? "");
      return new Response(JSON.stringify({ activated: ["x"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const result = await node.delegateTo("did:key:backend", [permission], { disableSubDelegation: true });
      const token = result.delegation.delegationHeader.Authorization;
      const [header, payload, signature] = token.split(".");
      expect(JSON.parse(Buffer.from(payload!, "base64url").toString()).fct).toEqual([
        { "xyz.tinycloud.policy/delegationMode": "terminal" },
      ]);
      expect(ed25519.verify(Buffer.from(signature!, "base64url"), Buffer.from(`${header}.${payload}`), publicKey)).toBe(true);
      expect(result.delegation.disableSubDelegation).toBe(true);
      expect(result.delegation.cid).not.toBe("wasm-cid");
      expect(activated).toEqual([token]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects an uncaveated public request selected against a caveated runtime grant", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const spaceId = `tinycloud:pkh:eip155:1:${address}:default`;
    const caveats = [{ tenant: "alpha", nested: { region: "us-east-1" } }];
    const operation = {
      spaceId,
      service: "kv",
      path: "vault/secrets/ANTHROPIC_API_KEY",
      action: "tinycloud.kv/put",
      caveats,
    };
    const grant = {
      session: {
        delegationHeader: { Authorization: "runtime-token" },
        delegationCid: "runtime-cid",
        spaceId,
        verificationMethod: "did:key:default",
        jwk: { kty: "OKP" },
      },
      delegation: {
        cid: "runtime-cid",
        delegationHeader: { Authorization: "runtime-token" },
        spaceId,
        path: operation.path,
        actions: [operation.action],
        caveats,
        expiry: new Date(Date.now() + 3_600_000),
        delegateDID: "did:key:default",
        ownerAddress: address,
        chainId: 1,
      },
      operations: [operation],
      expiresAt: new Date(Date.now() + 3_600_000),
      provenance: "delegated" as const,
    };
    (node as any).runtimePermissionGrants = [grant];
    const selectGrant = mock((operations: unknown[], options: unknown) =>
      (node as any).__selectRuntimeGrant(operations, options),
    );
    (node as any).__selectRuntimeGrant = (node as any).findGrantForOperations.bind(node);
    (node as any).findGrantForOperations = selectGrant;

    const result = node.createDelegation({
      path: operation.path,
      actions: [operation.action],
      delegateDID: "did:key:backend",
    });

    await expect(result).rejects.toMatchObject({
      name: "CaveatedDelegationUnsupportedError",
      code: "CAVEATED_DELEGATION_UNSUPPORTED",
      entries: [{ caveats }],
    });
    expect(selectGrant).toHaveBeenCalledTimes(1);
    const [selectedOperations, selectedOptions] = selectGrant.mock.calls[0] as [
      Array<Record<string, unknown>>,
      { excludePrimary: boolean },
    ];
    expect(selectedOperations).toEqual([expect.objectContaining({
      spaceId: operation.spaceId,
      service: operation.service,
      path: operation.path,
      action: operation.action,
    })]);
    expect(selectedOperations[0]?.caveats).toBeUndefined();
    expect(selectedOptions).toEqual({ excludePrimary: true });
    expect((node as any).wasmBindings.createDelegation).not.toHaveBeenCalled();
  });

  test("rejects caveated runtime grants before preparing an action-only session", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const permission: PermissionEntry = {
      service: "tinycloud.kv",
      space: "secrets",
      path: "vault/secrets/ANTHROPIC_API_KEY",
      actions: ["tinycloud.kv/put"],
      caveats: [{ tenant: "alpha" }],
    };

    await expect(node.grantRuntimePermissions([permission]))
      .rejects.toBeInstanceOf(CaveatedDelegationUnsupportedError);
    expect((node as any).wasmBindings.prepareSession).not.toHaveBeenCalled();
  });

  test("can reinstall a portable runtime delegation", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const permission: PermissionEntry = {
      service: "tinycloud.kv",
      space: "secrets",
      path: "vault/secrets/ANTHROPIC_API_KEY",
      actions: ["tinycloud.kv/put"],
    };

    let runtimeDelegation: any;
    await withActivatedDelegations(async () => {
      [runtimeDelegation] = await node.grantRuntimePermissions([permission]);
      (node as any).runtimePermissionGrants = [];
      expect(node.hasRuntimePermissions([permission])).toBe(false);
      await node.useRuntimeDelegation(runtimeDelegation!);
    });

    expect(node.hasRuntimePermissions([permission])).toBe(true);
  });

  test("projects exact effective runtime entries, preserves caveats, and prunes expiry", () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const spaceId = `tinycloud:pkh:eip155:1:0x71C7656EC7ab88b098defB751B7401B5f6d8976F:secrets`;
    const caveats = [{ tenant: "alpha" }];
    (node as any).runtimePermissionGrants = [
      {
        session: {},
        delegation: {},
        operations: [{
          spaceId: "secrets",
          service: "kv",
          path: "vault/secrets/API_KEY",
          action: "tinycloud.kv/get",
          caveats,
        }, {
          spaceId: "secrets",
          service: "kv",
          path: "vault/secrets/API_KEY",
          action: "tinycloud.kv/put",
          caveats,
        }, {
          resource: "urn:tinycloud:encryption:did:key:z6MkPrincipal:default",
          service: "encryption",
          path: "urn:tinycloud:encryption:did:key:z6MkPrincipal:default",
          action: "tinycloud.encryption/decrypt",
        }],
        expiresAt: new Date(Date.now() + 3_600_000),
        provenance: "runtime",
      },
      {
        session: {},
        delegation: {},
        operations: [{
          spaceId,
          service: "kv",
          path: "vault/secrets/EXPIRED",
          action: "tinycloud.kv/get",
        }],
        expiresAt: new Date(Date.now() - 1),
        provenance: "runtime",
      },
    ];

    expect(node.getEffectiveRuntimePermissionEntries()).toEqual([
      {
        service: "tinycloud.encryption",
        path: "urn:tinycloud:encryption:did:key:z6MkPrincipal:default",
        actions: ["tinycloud.encryption/decrypt"],
      },
      {
        service: "tinycloud.kv",
        space: spaceId,
        path: "vault/secrets/API_KEY",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
        caveats,
      },
    ]);
    expect((node as any).runtimePermissionGrants).toHaveLength(1);
  });

  test("a tinycloud.kv/* runtime grant never covers kv/sync or kv/retain", () => {
    const node = makeNode(mock(() => ({})));
    const spaceId = "tinycloud:pkh:eip155:1:0x71C7656EC7ab88b098defB751B7401B5f6d8976F:default";
    Reflect.set(node, "runtimePermissionGrants", [{
      session: {},
      delegation: {},
      operations: [{ spaceId, service: "kv", path: "notes/", action: "tinycloud.kv/*" }],
      expiresAt: new Date(Date.now() + 3_600_000),
      provenance: "runtime",
    }]);
    const request = (action: string) => [{
      service: "tinycloud.kv", space: spaceId, path: "notes/", actions: [action],
    }];

    expect(node.hasRuntimePermissions(request("tinycloud.kv/get"))).toBe(true);
    expect(node.hasRuntimePermissions(request("tinycloud.kv/sync"))).toBe(false);
    expect(node.hasRuntimePermissions(request("tinycloud.kv/retain"))).toBe(false);
  });

  test("hasRuntimePermissions does not count a runtime grant after it expires", () => {
    const node = makeNode(mock(() => ({})));
    const spaceId = "tinycloud:pkh:eip155:1:0x71C7656EC7ab88b098defB751B7401B5f6d8976F:default";
    const operations = [{ spaceId, service: "kv", path: "notes/", action: "tinycloud.kv/get" }];
    const entries = [{ service: "tinycloud.kv", space: spaceId, path: "notes/", actions: ["tinycloud.kv/get"] }];

    Reflect.set(node, "runtimePermissionGrants", [{
      session: {},
      delegation: {},
      operations,
      expiresAt: new Date(Date.now() - 1),
      provenance: "runtime",
    }]);
    expect(node.hasRuntimePermissions(entries)).toBe(false);

    Reflect.set(node, "runtimePermissionGrants", [{
      session: {},
      delegation: {},
      operations,
      expiresAt: new Date(Date.now() + 3_600_000),
      provenance: "runtime",
    }]);
    expect(node.hasRuntimePermissions(entries)).toBe(true);
  });

  test("can reinstall a runtime delegation targeted at fragmentless session DID", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    (node as any).auth.tinyCloudSession.verificationMethod = "did:key:default#default";
    Object.defineProperty(node, "sessionDid", {
      configurable: true,
      get: () => "did:key:default#default",
    });
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const secretsSpaceId = `tinycloud:pkh:eip155:1:${address}:secrets`;
    const permission: PermissionEntry = {
      service: "tinycloud.kv",
      space: "secrets",
      path: "vault/secrets/ANTHROPIC_API_KEY",
      actions: ["tinycloud.kv/put"],
    };
    const delegation = {
      cid: "fragmentless-cid",
      delegationHeader: { Authorization: "fragmentless-token" },
      spaceId: secretsSpaceId,
      path: permission.path,
      actions: permission.actions,
      resources: [{
        service: "kv",
        space: secretsSpaceId,
        path: permission.path,
        actions: permission.actions,
      }],
      expiry: new Date(Date.now() + 60_000),
      delegateDID: "did:key:default",
      ownerAddress: address,
      chainId: 1,
    };

    await withActivatedDelegations(async () => {
      await node.useRuntimeDelegation(delegation);
    });

    expect(node.hasRuntimePermissions([permission])).toBe(true);
  });

  test("grants decrypt permission for the default encryption network", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const networkId = node.getDefaultEncryptionNetworkId();
    const permission: PermissionEntry = {
      service: "tinycloud.encryption",
      path: networkId,
      actions: ["tinycloud.encryption/decrypt"],
    };

    await withActivatedDelegations(async () => {
      const delegations = await node.grantRuntimePermissions([permission]);
      expect(delegations).toHaveLength(1);
      expect(delegations[0].resources).toEqual([
        {
          service: "encryption",
          space: "encryption",
          path: networkId,
          actions: ["tinycloud.encryption/decrypt"],
        },
      ]);
      const prepareSession = (node as any).wasmBindings.prepareSession;
      expect(prepareSession.mock.calls[0][0].rawAbilities).toEqual({
        [networkId]: ["tinycloud.encryption/decrypt"],
      });
      expect(prepareSession.mock.calls[0][0].abilities).toEqual({});

      const result = await node.delegateTo("did:key:backend", [permission]);
      expect(result.prompted).toBe(false);
      expect(result.delegation.delegateDID).toBe("did:key:backend");
      expect(result.delegation.actions).toEqual([
        "tinycloud.encryption/decrypt",
      ]);
    });

    expect(node.hasRuntimePermissions([permission])).toBe(true);
  });

function makeExpiryTestNode(): TinyCloudNode {
  const invoke = mock((session: { delegationHeader: { Authorization: string } }) => ({
    Authorization: session.delegationHeader.Authorization,
  }));
  // makeNode takes the wasm invoke type; the mock only echoes the auth header.
  return makeNode(invoke as unknown as IWasmBindings["invoke"]);
}

function lastPrepareExpiryMs(node: TinyCloudNode): number {
  // Test-only access to the wasm binding mock recorded by makeFakeWasmBindings.
  const wasm = node as unknown as {
    wasmBindings: { prepareSession: { mock: { calls: Array<[{ expirationTime: string }]> } } };
  };
  return new Date(wasm.wasmBindings.prepareSession.mock.calls[0][0].expirationTime).getTime();
}

const DECRYPT_EXPIRY_TEST_ACTIONS = ["tinycloud.encryption/decrypt"];

test("runtime grants that include decrypt honour an explicit expiry of one hour or less", async () => {
  const node = makeExpiryTestNode();
  const permission: PermissionEntry = {
    service: "tinycloud.encryption",
    path: node.getDefaultEncryptionNetworkId(),
    actions: DECRYPT_EXPIRY_TEST_ACTIONS,
  };

  const before = Date.now();
  let delegations: Array<{ expiry: Date }> = [];
  await withActivatedDelegations(async () => {
    delegations = await node.grantRuntimePermissions([permission], { expiry: 3_540_000 });
  });

  const target = before + 3_540_000;
  expect(Math.abs(lastPrepareExpiryMs(node) - target)).toBeLessThanOrEqual(5_000);
  expect(delegations).toHaveLength(1);
  expect(Math.abs(delegations[0].expiry.getTime() - target)).toBeLessThanOrEqual(5_000);
});

test("runtime grants without decrypt keep the 30-day default", async () => {
  const node = makeExpiryTestNode();
  const permission: PermissionEntry = {
    service: "tinycloud.kv",
    space: "secrets",
    path: "vault/",
    actions: ["tinycloud.kv/get"],
  };

  const before = Date.now();
  await withActivatedDelegations(async () => {
    await node.grantRuntimePermissions([permission]);
  });

  expect(lastPrepareExpiryMs(node)).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60_000);
});

test("runtime grants that include decrypt end within a shorter session expiry", async () => {
  const node = makeExpiryTestNode();
  const permission: PermissionEntry = {
    service: "tinycloud.encryption",
    path: node.getDefaultEncryptionNetworkId(),
    actions: DECRYPT_EXPIRY_TEST_ACTIONS,
  };
  const session = (node as unknown as {
    auth: { tinyCloudSession: { siwe: string } };
  }).auth.tinyCloudSession;
  const sessionEnd = new Date(Date.now() + 20 * 60_000);
  session.siwe = session.siwe.replace("2999-01-01T00:00:00.000Z", sessionEnd.toISOString());

  await withActivatedDelegations(async () => {
    await node.grantRuntimePermissions([permission]);
  });

  expect(lastPrepareExpiryMs(node)).toBe(sessionEnd.getTime());
});

function expectEveryExpiryNear(
  node: TinyCloudNode,
  delegations: Array<{ expiry: Date }>,
  expectedMs: number,
): void {
  const expiries = [...allPrepareExpiryMs(node), ...delegations.map((d) => d.expiry.getTime())];
  expect(expiries.length).toBeGreaterThan(0);
  for (const expiry of expiries) {
    expect(Math.abs(expiry - expectedMs)).toBeLessThanOrEqual(5_000);
  }
}

const MIXED_DECRYPT_KV_PERMISSIONS = (node: TinyCloudNode): PermissionEntry[] => [
  {
    service: "tinycloud.kv",
    space: "secrets",
    path: "vault/",
    actions: ["tinycloud.kv/get"],
  },
  {
    service: "tinycloud.encryption",
    path: node.getDefaultEncryptionNetworkId(),
    actions: DECRYPT_EXPIRY_TEST_ACTIONS,
  },
];

test("non-encryption wildcard runtime grants keep the 30-day default", async () => {
  const node = makeExpiryTestNode();
  const permission: PermissionEntry = {
    service: "tinycloud.kv",
    space: "secrets",
    path: "vault/",
    actions: ["tinycloud.kv/*"],
  };
  const before = Date.now();
  let delegations: Array<{ expiry: Date }> = [];
  await withActivatedDelegations(async () => {
    delegations = await node.grantRuntimePermissions([permission]);
  });

  expectEveryExpiryNear(node, delegations, before + 30 * 24 * 60 * 60_000);
});

test("non-encryption wildcard runtime grants accept an explicit 7d expiry", async () => {
  const node = makeExpiryTestNode();
  const permission: PermissionEntry = {
    service: "tinycloud.kv",
    space: "secrets",
    path: "vault/",
    actions: ["tinycloud.kv/*"],
  };
  const before = Date.now();
  let delegations: Array<{ expiry: Date }> = [];
  await withActivatedDelegations(async () => {
    delegations = await node.grantRuntimePermissions([permission], { expiry: "7d" });
  });

  expectEveryExpiryNear(node, delegations, before + 7 * 24 * 60 * 60_000);
});

test("mixed kv and decrypt runtime grants honour an explicit one-hour expiry for every delegation", async () => {
  const node = makeExpiryTestNode();
  const before = Date.now();
  let delegations: Array<{ expiry: Date }> = [];
  await withActivatedDelegations(async () => {
    delegations = await node.grantRuntimePermissions(MIXED_DECRYPT_KV_PERMISSIONS(node), {
      expiry: 3_600_000,
    });
  });

  expectEveryExpiryNear(node, delegations, before + 3_600_000);
});

  test("grants mixed KV and raw encryption permissions in one runtime delegation", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const secretsSpaceId = `tinycloud:pkh:eip155:1:${address}:secrets`;
    const networkId = node.getDefaultEncryptionNetworkId();
    const permissions: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "secrets",
        path: "vault/secrets/",
        actions: ["tinycloud.kv/get"],
      },
      {
        service: "tinycloud.encryption",
        path: networkId,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ];

    await withActivatedDelegations(async () => {
      const delegations = await node.grantRuntimePermissions(permissions);
      expect(delegations).toHaveLength(1);
      expect(delegations[0].resources).toEqual([
        {
          service: "kv",
          space: secretsSpaceId,
          path: "vault/secrets/",
          actions: ["tinycloud.kv/get"],
        },
        {
          service: "encryption",
          space: "encryption",
          path: networkId,
          actions: ["tinycloud.encryption/decrypt"],
        },
      ]);
    });

    const prepareSession = (node as any).wasmBindings.prepareSession;
    expect(prepareSession.mock.calls[0][0].abilities).toEqual({
      kv: {
        "vault/secrets/": ["tinycloud.kv/get"],
      },
    });
    expect(prepareSession.mock.calls[0][0].rawAbilities).toEqual({
      [networkId]: ["tinycloud.encryption/decrypt"],
    });
    expect(node.hasRuntimePermissions(permissions)).toBe(true);
  });

  test("delegates mixed KV and raw encryption permissions from the session recap", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const secretsSpaceId = `tinycloud:pkh:eip155:1:${address}:secrets`;
    const networkId = node.getDefaultEncryptionNetworkId();
    const permissions: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "secrets",
        path: "vault/secrets/",
        actions: ["tinycloud.kv/get"],
      },
      {
        service: "tinycloud.encryption",
        path: networkId,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ];
    (node as any).wasmBindings.parseRecapFromSiwe = mock(() => [
      {
        service: "kv",
        space: secretsSpaceId,
        path: "vault/secrets/",
        actions: ["tinycloud.kv/get"],
      },
      {
        service: "encryption",
        space: "encryption",
        path: networkId,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ]);

    await withActivatedDelegations(async () => {
      const result = await node.delegateTo("did:key:backend", permissions);
      expect(result.prompted).toBe(false);
      expect(result.delegation.resources).toEqual([
        {
          service: "encryption",
          space: "encryption",
          path: networkId,
          actions: ["tinycloud.encryption/decrypt"],
        },
        {
          service: "kv",
          space: secretsSpaceId,
          path: "vault/secrets/",
          actions: ["tinycloud.kv/get"],
        },
      ]);
    });
  });

  test("delegates raw encryption permissions without a data space from the session recap", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const networkId = node.getDefaultEncryptionNetworkId();
    const permission: PermissionEntry = {
      service: "tinycloud.encryption",
      path: networkId,
      actions: ["tinycloud.encryption/decrypt"],
    };
    (node as any).wasmBindings.parseRecapFromSiwe = mock(() => [
      {
        service: "encryption",
        space: "encryption",
        path: networkId,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ]);

    await withActivatedDelegations(async () => {
      const result = await node.delegateTo("did:key:backend", [permission]);
      expect(result.prompted).toBe(false);
      expect(result.delegation.resources).toEqual([
        {
          service: "encryption",
          space: "encryption",
          path: networkId,
          actions: ["tinycloud.encryption/decrypt"],
        },
      ]);
    });

    const createDelegation = (node as any).wasmBindings.createDelegation;
    expect(createDelegation).toHaveBeenCalledTimes(1);
    expect(createDelegation.mock.calls[0][3]).toEqual({
      encryption: {
        [networkId]: ["tinycloud.encryption/decrypt"],
      },
    });
  });

  test("a signed space-nested encryption recap cannot claim a raw network invocation over a later signed grant", async () => {
    const wasm = new NodeWasmBindings();
    const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
    const manager = wasm.createSessionManager();
    const jwk = JSON.parse(manager.jwk("default")!);
    const address = await signer.getAddress();
    const chainId = await signer.getChainId();
    const spaceId = wasm.makeSpaceId(address, chainId, "secrets");
    const networkId = `urn:tinycloud:encryption:did:pkh:eip155:${chainId}:${address}:default`;
    const action = "tinycloud.encryption/decrypt";
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
    const prepared = wasm.prepareSession({
      abilities: { encryption: { [networkId]: [action] } },
      address,
      chainId,
      domain: "tinycloud.test",
      issuedAt: now.toISOString(),
      expirationTime: expiresAt,
      spaceId,
      jwk,
    });
    const signature = await signer.signMessage(prepared.siwe);
    const nested = wasm.completeSessionSetup({ ...prepared, signature });
    const proof = {
      delegationHeader: nested.delegationHeader,
      delegationCid: nested.delegationCid,
      spaceId,
      jwk,
      verificationMethod: nested.verificationMethod,
      address,
      chainId,
      siwe: prepared.siwe,
      signature,
      expiresAt,
    };
    const recap = wasm.validatePersistedSession!(proof).verifiedRecap!;
    expect(recap.some((entry) =>
      entry.service === "encryption" && entry.space === spaceId &&
      entry.path === networkId && entry.actions.includes(action)
    )).toBe(true);

    const node = new TinyCloudNode({
      host: "http://127.0.0.1:1",
      signer,
      wasmBindings: wasm,
    });
    await node.restoreSession(proof);
    const bindings = (node as any).wasmBindings;
    const originalInvokeAny = bindings.invokeAny;
    const queryInvokeAny = mock((..._args: any[]) => ({ Authorization: "restored-query" }));
    bindings.invokeAny = queryInvokeAny;
    (node.delegationManager as any).fetchFn = mock(async () => new Response(JSON.stringify({
      schemaVersion: 2,
      items: [],
    }), { headers: { "content-type": "application/json" } }));
    const restoredQuery = await node.delegationManager.query();
    expect(restoredQuery.ok).toBe(true);
    expect(queryInvokeAny.mock.calls[0]?.[1]).toEqual([{
      spaceId: node.accountSpaceId,
      service: "delegation",
      path: "",
      action: "tinycloud.delegation/list",
    }]);
    bindings.invokeAny = originalInvokeAny;
    expect(node.getVerifiedSessionCapabilities()).toEqual([{
      service: "tinycloud.encryption",
      space: spaceId,
      path: networkId,
      actions: [action],
      caveats: [],
    }]);
    const operation = { resource: networkId, service: "encryption", path: networkId, action };
    const selection = node as unknown as {
      findGrantForOperation: (requested: typeof operation) => { provenance: string; session: { delegationCid: string } } | undefined;
      invokeAnyWithRuntimePermissions: (
        session: NonNullable<TinyCloudNode["restorableSession"]>,
        entries: typeof operation[],
        facts: Record<string, unknown>[],
      ) => { Authorization: string };
    };
    expect(selection.findGrantForOperation(operation)).toBeUndefined();

    await withActivatedDelegations(async () => {
      const grants = await node.grantRuntimePermissions([{
        service: "tinycloud.encryption",
        path: networkId,
        actions: [action],
      }]);
      expect(grants).toHaveLength(1);
    });
    const selected = selection.findGrantForOperation(operation);
    expect(selected?.provenance).toBe("runtime");
    const headers = selection.invokeAnyWithRuntimePermissions(
      node.restorableSession!,
      [operation],
      [{}],
    );
    expect(headers.Authorization).toContain(".");

    const rawPrepared = wasm.prepareSession({
      abilities: { kv: { "": ["tinycloud.kv/get"] } },
      rawAbilities: { [networkId]: [action] },
      address,
      chainId,
      domain: "tinycloud.test",
      issuedAt: now.toISOString(),
      expirationTime: expiresAt,
      spaceId,
      jwk,
    });
    const rawSignature = await signer.signMessage(rawPrepared.siwe);
    const rawSession = wasm.completeSessionSetup({ ...rawPrepared, signature: rawSignature });
    const rawProof = {
      ...proof,
      delegationHeader: rawSession.delegationHeader,
      delegationCid: rawSession.delegationCid,
      verificationMethod: rawSession.verificationMethod,
      siwe: rawPrepared.siwe,
      signature: rawSignature,
    };
    expect(wasm.validatePersistedSession!(rawProof).verifiedRecap!.some((entry) =>
      entry.service === "encryption" && entry.space === "encryption" &&
      entry.path === networkId && entry.actions.includes(action)
    )).toBe(true);
    await node.restoreSession(rawProof);
    expect(node.getVerifiedSessionCapabilities()).toContainEqual({
      service: "tinycloud.encryption",
      path: networkId,
      actions: [action],
      caveats: [],
    });
    expect(selection.findGrantForOperation(operation)?.provenance).toBe("primary");
    expect(selection.invokeAnyWithRuntimePermissions(
      node.restorableSession!,
      [operation],
      [{}],
    ).Authorization).toContain(".");

    // A nested owner space also named "encryption" must not collapse into
    // the identically named top-level ReCap resource.
    const encryptionSpaceId = wasm.makeSpaceId(address, chainId, "encryption");
    const ownerPrepared = wasm.prepareSession({
      abilities: { encryption: { [networkId]: [action] } },
      address,
      chainId,
      domain: "tinycloud.test",
      issuedAt: now.toISOString(),
      expirationTime: expiresAt,
      spaceId: encryptionSpaceId,
      jwk,
    });
    const ownerSignature = await signer.signMessage(ownerPrepared.siwe);
    const ownerSession = wasm.completeSessionSetup({ ...ownerPrepared, signature: ownerSignature });
    await node.restoreSession({
      ...proof,
      delegationHeader: ownerSession.delegationHeader,
      delegationCid: ownerSession.delegationCid,
      verificationMethod: ownerSession.verificationMethod,
      spaceId: encryptionSpaceId,
      siwe: ownerPrepared.siwe,
      signature: ownerSignature,
    });
    expect(node.getVerifiedSessionCapabilities()).toEqual([{
      service: "tinycloud.encryption",
      space: encryptionSpaceId,
      path: networkId,
      actions: [action],
      caveats: [],
    }]);
    expect(selection.findGrantForOperation(operation)).toBeUndefined();
    expect(node.hasRuntimePermissions([{
      service: "tinycloud.encryption", space: "encryption", path: networkId, actions: [action],
    }])).toBe(false);
    await expect(node.delegateTo("did:key:backend", [{
      service: "tinycloud.encryption", space: "encryption", path: networkId, actions: [action],
    }])).rejects.toBeInstanceOf(PermissionNotInManifestError);
  });

  test("uses a runtime decrypt grant for raw network invocations", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const networkId = node.getDefaultEncryptionNetworkId();
    const permission: PermissionEntry = {
      service: "tinycloud.encryption",
      path: networkId,
      actions: ["tinycloud.encryption/decrypt"],
    };

    await withActivatedDelegations(async () => {
      await node.grantRuntimePermissions([permission]);
    });

    const fallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: "tinycloud:pkh:eip155:1:0x71C7656EC7ab88b098defB751B7401B5f6d8976F:default",
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeAnyWithRuntimePermissions(
      fallback,
      [
        {
          resource: networkId,
          service: "encryption",
          path: networkId,
          action: "tinycloud.encryption/decrypt",
        },
      ],
      [{}],
    );

    const invokeAny = (node as any).wasmBindings.invokeAny;
    expect(invokeAny.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "runtime-token",
    );
  });



  test("classifies a host missing-parent rejection for raw CID revoke authority", async () => {
    const node = makeNode(mock(() => ({})) as any);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response("Cannot find parent delegation", { status: 401 })
    ) as any;

    try {
      await expect(node.grantRuntimePermissions([{
        service: "tinycloud.delegation",
        space: `urn:cid:${revokeTargetCid}`,
        path: "",
        actions: ["tinycloud.delegation/revoke"],
      }])).rejects.toMatchObject({ code: "RAW_RECAP_RESOURCE_UNSUPPORTED" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("routes CID revoke control proofs through the activated runtime ability", async () => {
    const invoke = mock((session: { delegationHeader: { Authorization: string } }) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as IWasmBindings["invoke"];
    const node = makeNode(invoke);
    const spaceId = "tinycloud:pkh:eip155:1:0x71C7656EC7ab88b098defB751B7401B5f6d8976F:default";

    let authorityCid = "";
    await withActivatedDelegations(async () => {
      const [delegation] = await node.grantRuntimePermissions([{
        service: "tinycloud.delegation",
        space: `urn:cid:${revokeTargetCid}`,
        path: "",
        actions: ["tinycloud.delegation/revoke"],
      }]);
      await node.useRuntimeDelegation(delegation!);
      authorityCid = delegation!.cid;
    });

    const fallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };
    const invocation = node as unknown as {
      invokeAnyWithRuntimePermissions: (
        session: NonNullable<TinyCloudNode["restorableSession"]>,
        entries: Array<{
          spaceId?: string;
          resource: string;
          service: string;
          path: string;
          action: string;
          revokeAuthorityCid?: string;
        }>,
        facts: Record<string, unknown>[],
      ) => unknown;
      wasmBindings: {
        invokeAny: {
          mock: { calls: Array<[NonNullable<TinyCloudNode["restorableSession"]>]> };
        };
      };
    };
    const revokeEntry = {
      spaceId,
      resource: `urn:cid:${revokeTargetCid}`,
      service: "delegation",
      path: "",
      action: "tinycloud.delegation/revoke",
    };
    Object.defineProperty(revokeEntry, "revokeAuthorityCid", {
      value: authorityCid,
      enumerable: false,
    });
    invocation.invokeAnyWithRuntimePermissions(fallback, [revokeEntry], [{}]);
    invocation.invokeAnyWithRuntimePermissions(fallback, [{
      resource: "urn:cid:bafkreirevocationtarget",
      service: "delegation",
      path: "",
      action: "tinycloud.delegation/status",
    }], [{}]);

    expect(invocation.wasmBindings.invokeAny.mock.calls[0]?.[0]?.delegationHeader.Authorization).toBe("runtime-token");
    expect(invocation.wasmBindings.invokeAny.mock.calls[1]?.[0]?.delegationHeader.Authorization).toBe("base-token");
  });

  test("uses a single runtime SQL grant for migration-style schema and write batches", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const secretsSpaceId = `tinycloud:pkh:eip155:1:${address}:secrets`;
    const permission: PermissionEntry = {
      service: "tinycloud.sql",
      space: "secrets",
      path: "default",
      actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"],
    };

    await withActivatedDelegations(async () => {
      await node.grantRuntimePermissions([permission]);
    });

    const fallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: secretsSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeAnyWithRuntimePermissions(
      fallback,
      [
        {
          spaceId: secretsSpaceId,
          service: "sql",
          path: "default",
          action: "tinycloud.sql/schema",
        },
        {
          spaceId: secretsSpaceId,
          service: "sql",
          path: "default",
          action: "tinycloud.sql/write",
        },
      ],
      [{}, {}],
    );

    const invokeAny = (node as any).wasmBindings.invokeAny;
    expect(invokeAny.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "runtime-token",
    );
  });

  test("TC-531: an activated delegation lasts as long as the delegation, not an hour", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const networkId = node.getDefaultEncryptionNetworkId();
    const encryptionSpaceId = `tinycloud:pkh:eip155:1:${address}:encryption`;
    const expiry = new Date(Date.now() + 3 * 24 * 3600_000);
    const delegation = {
      cid: "owner-decrypt-cid",
      delegationHeader: { Authorization: "owner-decrypt-token" },
      spaceId: encryptionSpaceId,
      path: networkId,
      actions: ["tinycloud.encryption/decrypt"],
      resources: [{ service: "encryption", space: "encryption", path: networkId, actions: ["tinycloud.encryption/decrypt"] }],
      disableSubDelegation: false,
      expiry,
      delegateDID: "did:key:default",
      ownerAddress: address,
      chainId: 1,
      host: "https://tinycloud.test",
    };

    await withActivatedDelegations(async () => {
      await node.useDelegation(delegation as any);
    });

    const prepareSession = (node as any).wasmBindings.prepareSession;
    expect(prepareSession.mock.calls[0][0].expirationTime).toBe(expiry.toISOString());
  });

  test("useDelegation installs encryption delegations as raw runtime grants", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const networkId = node.getDefaultEncryptionNetworkId();
    const encryptionSpaceId = `tinycloud:pkh:eip155:1:${address}:encryption`;
    const delegation = {
      cid: "owner-decrypt-cid",
      delegationHeader: { Authorization: "owner-decrypt-token" },
      spaceId: encryptionSpaceId,
      path: networkId,
      actions: ["tinycloud.encryption/decrypt"],
      resources: [
        {
          service: "encryption",
          space: "encryption",
          path: networkId,
          actions: ["tinycloud.encryption/decrypt"],
        },
      ],
      disableSubDelegation: false,
      expiry: new Date(Date.now() + 3600_000),
      delegateDID: "did:key:default",
      ownerAddress: address,
      chainId: 1,
      host: "https://tinycloud.test",
    };

    await withActivatedDelegations(async () => {
      await node.useDelegation(delegation as any);
    });

    const prepareSession = (node as any).wasmBindings.prepareSession;
    expect(prepareSession.mock.calls[0][0].rawAbilities).toEqual({
      [networkId]: ["tinycloud.encryption/decrypt"],
    });

    const fallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: encryptionSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeAnyWithRuntimePermissions(
      fallback,
      [
        {
          resource: networkId,
          service: "encryption",
          path: networkId,
          action: "tinycloud.encryption/decrypt",
        },
      ],
      [{}],
    );

    const invokeAny = (node as any).wasmBindings.invokeAny;
    expect(invokeAny.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "runtime-token",
    );
  });

  test("useDelegation activates every resource of a multi-resource delegation", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    const secretsSpaceId = `tinycloud:pkh:eip155:1:${address}:secrets`;
    const networkId = node.getDefaultEncryptionNetworkId();
    const secretPath = "vault/secrets/ANTHROPIC_API_KEY";

    // A delegation covering BOTH a kv secret and an encryption network.
    // The flat top-level path/actions mirror only the encryption resource
    // (sorted first by service); the full set lives in `resources[]`.
    const delegation = {
      cid: "owner-multi-cid",
      delegationHeader: { Authorization: "owner-multi-token" },
      spaceId: secretsSpaceId,
      path: networkId,
      actions: ["tinycloud.encryption/decrypt"],
      resources: [
        {
          service: "encryption",
          space: "encryption",
          path: networkId,
          actions: ["tinycloud.encryption/decrypt"],
        },
        {
          service: "kv",
          space: secretsSpaceId,
          path: secretPath,
          actions: ["tinycloud.kv/get"],
        },
      ],
      disableSubDelegation: false,
      expiry: new Date(Date.now() + 3600_000),
      delegateDID: "did:key:default",
      ownerAddress: address,
      chainId: 1,
      host: "https://tinycloud.test",
    };

    await withActivatedDelegations(async () => {
      await node.useDelegation(delegation as any);
    });

    const prepareSession = (node as any).wasmBindings.prepareSession;
    const call = prepareSession.mock.calls[0][0];

    // The kv capability must NOT be dropped from the activation.
    expect(call.abilities).toEqual({
      kv: { [secretPath]: ["tinycloud.kv/get"] },
    });
    // The encryption capability must also be present, as a raw network grant.
    expect(call.rawAbilities).toEqual({
      [networkId]: ["tinycloud.encryption/decrypt"],
    });

    // Both resources are tracked as runtime grants so subsequent
    // invocations route to the activated sub-delegation session.
    const fallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: secretsSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeWithRuntimePermissions(
      fallback,
      "kv",
      secretPath,
      "tinycloud.kv/get",
    );
    expect(
      invoke.mock.calls[invoke.mock.calls.length - 1][0].delegationHeader
        .Authorization,
    ).toBe("runtime-token");

    (node as any).invokeAnyWithRuntimePermissions(
      fallback,
      [
        {
          resource: networkId,
          service: "encryption",
          path: networkId,
          action: "tinycloud.encryption/decrypt",
        },
      ],
      [{}],
    );
    const invokeAny = (node as any).wasmBindings.invokeAny;
    expect(
      invokeAny.mock.calls[invokeAny.mock.calls.length - 1][0].delegationHeader
        .Authorization,
    ).toBe("runtime-token");
  });

  test("encryption discovery falls back to the well-known cache record", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const address = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
    (node as any)._address = address;
    (node as any)._chainId = 1;
    (node as any).getEncryptionNetwork = mock(async () => null);

    const networkId = node.getDefaultEncryptionNetworkId();
    const descriptor = {
      networkId,
      ownerDid: node.did,
      name: "default",
      members: [{ nodeId: "did:key:cache-node", role: "primary" as const }],
      threshold: { n: 1, t: 1 },
      state: "active" as const,
      publicEncryptionKey: "AQID",
      alg: "x25519-aes256gcm/v1",
      keyVersion: 1,
      keyBackend: "local-one-of-one" as const,
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    };

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () =>
      new Response(JSON.stringify(descriptor), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const encryption = (node as any).createEncryptionService();
      const result = await encryption.discoverNetwork("default", node.did);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.networkId).toBe(networkId);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("encryption service round-trips through the node encrypt/decrypt path", async () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const networkId = node.getDefaultEncryptionNetworkId();
    const descriptor = makeEncryptionDescriptor(networkId, node.did);
    const crypto = makeEncryptionCrypto();

    (node as any).createEncryptionCrypto = () => crypto;

    const signRawNetworkAuthorization = mock(
      async ({ targetNode, networkId: signedNetworkId, action, facts }: any) => {
        const keyPath = facts.keyPath;
        expect(targetNode).toBe(node.did);
        expect(signedNetworkId).toBe(keyPath === undefined ? networkId : `${networkId}/${keyPath}`);
        expect(action).toBe("tinycloud.encryption/decrypt");
        expect(facts.targetNode).toBe(node.did);
        expect(facts.networkId).toBe(networkId);
        expect(facts.keyPath).toBe(keyPath);
        return {
          authorization: "Invocation node-encryption",
          invocationCid: keyPath === undefined
            ? "bafy-node-encryption"
            : "bafy-node-encryption-scoped",
        };
      },
    );
    (node as any).signRawNetworkAuthorization = signRawNetworkAuthorization;

    const fetchCalls: Array<{ method: string; url: string; body?: string }> = [];
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string"
          ? init.body
          : init?.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : undefined;
      fetchCalls.push({ method, url, body });

      const getUrl =
        `https://tinycloud.test/encryption/networks/${encodeURIComponent(networkId)}`;
      const decryptUrl = `${getUrl}/decrypt`;

      if (method === "GET" && url === getUrl) {
        return new Response(JSON.stringify({ descriptor }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (method === "POST" && url === decryptUrl) {
        if (!body) {
          throw new Error("expected canonical decrypt body");
        }
        const request = JSON.parse(body) as DecryptRequestBody;
        const wrappedSymmetricKey = encryptionBase64Decode(
          request.encryptedSymmetricKey,
        );
        const networkPublicKey = encryptionBase64Decode(
          descriptor.publicEncryptionKey,
        );
        const symmetricKey = xor(networkPublicKey, wrappedSymmetricKey);
        const receiverPublicKey = encryptionBase64Decode(
          request.receiverPublicKey,
        );
        const wrappedKey = xor(receiverPublicKey, symmetricKey);
        const invocationCid = request.keyPath === undefined
          ? "bafy-node-encryption"
          : "bafy-node-encryption-scoped";
        const requestBodyHash = canonicalHashHex(crypto.sha256, request as any);
        const response: DecryptResponseBody = {
          type: "tinycloud.encryption.decrypt-result/v1",
          targetNode: request.targetNode,
          networkId: request.networkId,
          invocationCid,
          encryptedSymmetricKeyHash: request.encryptedSymmetricKeyHash,
          receiverPublicKeyHash: request.receiverPublicKeyHash,
          wrappedKey: encryptionBase64Encode(wrappedKey),
          alg: request.alg,
          keyVersion: request.keyVersion,
          requestHash: hexEncode(
            crypto.sha256(
              encryptionUtf8Encode(`${invocationCid}${requestBodyHash}`),
            ),
          ),
          nodeId: node.did,
          nodeSignature: encryptionBase64Encode(new Uint8Array(64).fill(9)),
        };
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const encryption = (node as any).createEncryptionService();
      const plaintext = encryptionUtf8Encode("hello tinycloud encryption");

      const encryptResult = await encryption.encryptToNetwork(networkId, plaintext);
      expect(encryptResult.ok).toBe(true);
      if (!encryptResult.ok) return;

      const decryptResult = await encryption.decryptEnvelope(encryptResult.data, {
        proofs: ["bafyDelegationFromPrincipal"],
      });
      expect(decryptResult.ok).toBe(true);
      if (!decryptResult.ok) return;
      expect(new TextDecoder().decode(decryptResult.data)).toBe(
        "hello tinycloud encryption",
      );

      const keyPath = "share/abcdef1234567890";
      const scopedEncryptResult = await encryption.encryptToNetwork(
        networkId,
        plaintext,
        { keyPath },
      );
      expect(scopedEncryptResult.ok).toBe(true);
      if (!scopedEncryptResult.ok) return;
      const scopedDecryptResult = await encryption.decryptEnvelope(
        scopedEncryptResult.data,
        { proofs: ["bafyDelegationFromPrincipal"] },
      );
      expect(scopedDecryptResult.ok).toBe(true);
      if (!scopedDecryptResult.ok) return;
      expect(new TextDecoder().decode(scopedDecryptResult.data)).toBe(
        "hello tinycloud encryption",
      );

      expect(fetchCalls.map((call) => call.method)).toEqual(["GET", "POST", "POST"]);
      expect(signRawNetworkAuthorization).toHaveBeenCalledTimes(2);

      const postCall = fetchCalls[1];
      expect(postCall.url).toBe(
        `https://tinycloud.test/encryption/networks/${encodeURIComponent(networkId)}/decrypt`,
      );
      const request = JSON.parse(postCall.body ?? "{}") as DecryptRequestBody;
      expect(request.targetNode).toBe(node.did);
      expect(request.networkId).toBe(networkId);
      expect(request.alg).toBe(descriptor.alg);
      expect(request.keyVersion).toBe(descriptor.keyVersion);
      expect(request.encryptedSymmetricKeyHash).toBe(
        encryptResult.data.encryptedSymmetricKeyHash,
      );
      expect(request.receiverPublicKeyHash).toBe(
        canonicalHashHex(crypto.sha256, request.receiverPublicKey),
      );
      const scopedPostCall = fetchCalls[2];
      expect(scopedPostCall.url).toBe(postCall.url);
      const scopedRequest = JSON.parse(
        scopedPostCall.body ?? "{}",
      ) as DecryptRequestBody;
      expect(scopedRequest).toMatchObject({
        networkId,
        keyPath,
        encryptedSymmetricKeyHash:
          scopedEncryptResult.data.encryptedSymmetricKeyHash,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// TC-111: the primary session's own recap must out-rank any other covering
// runtime grant so a broad/broken bootstrap or delegated grant can never
// hijack an operation the primary session itself already authorizes.
// ---------------------------------------------------------------------------
describe("TinyCloudNode primary-session grant precedence (TC-111)", () => {
  const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

  // The TinyCloudSession the harness installs on `node.auth`. Full-URI space,
  // matching what `parseRecapFromSiwe` emits for the primary recap.
  function primarySession(node: TinyCloudNode) {
    return (node as any).auth.tinyCloudSession;
  }

  // Install a broad hijacking grant (path "" covers everything on the space)
  // that a broken bootstrap/delegated flow might have registered. We push
  // directly to mirror an already-installed grant without going through the
  // activation machinery.
  function installBroadGrant(
    node: TinyCloudNode,
    spaceId: string,
    service: string,
    action: string,
    provenance: "bootstrap" | "delegated" | "runtime" = "bootstrap",
  ): void {
    (node as any).runtimePermissionGrants.push({
      session: {
        delegationHeader: { Authorization: "hijack-token" },
        delegationCid: "hijack-cid",
        spaceId,
        verificationMethod: "did:key:hijack",
        jwk: { kty: "OKP" },
      },
      delegation: {
        cid: "hijack-cid",
        delegationHeader: { Authorization: "hijack-token" },
        delegateDID: "did:key:hijack",
        delegatorDID: node.did,
        spaceId,
        path: "",
        actions: [action],
        expiry: new Date(Date.now() + 3600_000),
        allowSubDelegation: true,
        ownerAddress: ADDRESS,
        chainId: 1,
        host: "https://tinycloud.test",
      },
      operations: [{ spaceId, service, path: "", action }],
      expiresAt: new Date(Date.now() + 3600_000),
      provenance,
    });
  }

  test("primary session wins over a broad covering grant (hijack regression)", () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const defaultSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;

    // Broken bootstrap grant registered FIRST — under insertion-order `.find`
    // it would have been selected and hijacked the operation.
    installBroadGrant(node, defaultSpaceId, "kv", "tinycloud.kv/put");

    // The primary session's own recap covers this native op.
    (node as any).wasmBindings.parseRecapFromSiwe = mock(() => [
      {
        service: "kv",
        space: defaultSpaceId,
        path: "vault/",
        actions: ["tinycloud.kv/put"],
      },
    ]);
    (node as any).registerPrimarySessionGrant(primarySession(node));

    const fallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: defaultSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeWithRuntimePermissions(
      fallback,
      "kv",
      "vault/foo",
      "tinycloud.kv/put",
    );
    // Must mint with the PRIMARY (base) session, not the hijacking grant.
    expect(invoke.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "base-token",
    );
  });

  test("primary session wins over a broad covering grant via invokeAny", () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const defaultSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;

    installBroadGrant(node, defaultSpaceId, "sql", "tinycloud.sql/write");

    (node as any).wasmBindings.parseRecapFromSiwe = mock(() => [
      {
        service: "sql",
        space: defaultSpaceId,
        path: "default",
        actions: ["tinycloud.sql/write"],
      },
    ]);
    (node as any).registerPrimarySessionGrant(primarySession(node));

    const fallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: defaultSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeAnyWithRuntimePermissions(
      fallback,
      [
        {
          spaceId: defaultSpaceId,
          service: "sql",
          path: "default",
          action: "tinycloud.sql/write",
        },
      ],
      [{}],
    );

    const invokeAny = (node as any).wasmBindings.invokeAny;
    expect(invokeAny.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "base-token",
    );
  });

  test("grant is still selected when the primary recap does not cover the op", () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const defaultSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
    const secretsSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:secrets`;

    // Real grant covers the SECRETS space.
    installBroadGrant(node, secretsSpaceId, "kv", "tinycloud.kv/put", "delegated");

    // Primary recap only covers the DEFAULT space — so the op on `secrets`
    // is not covered by the synthetic primary and the grant must win.
    (node as any).wasmBindings.parseRecapFromSiwe = mock(() => [
      {
        service: "kv",
        space: defaultSpaceId,
        path: "vault/",
        actions: ["tinycloud.kv/put"],
      },
    ]);
    (node as any).registerPrimarySessionGrant(primarySession(node));

    const fallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: secretsSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeWithRuntimePermissions(
      fallback,
      "kv",
      "vault/secrets/X",
      "tinycloud.kv/put",
    );
    expect(invoke.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "hijack-token",
    );
  });

  test("primary recap for owner B never covers an op on owner A's space", () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const aliceSpaceId = "tinycloud:pkh:eip155:1:0xAAAA000000000000000000000000000000000000:default";
    const bobSpaceId = "tinycloud:pkh:eip155:1:0xBBBB000000000000000000000000000000000000:default";

    // A grant covers Alice's space.
    installBroadGrant(node, aliceSpaceId, "kv", "tinycloud.kv/put", "delegated");

    // Primary recap claims Bob's identically-named "default" space. Because we
    // build primary ops from the RAW full URI, the owner is preserved and the
    // synthetic primary must NOT cover an op on Alice's space.
    (node as any).wasmBindings.parseRecapFromSiwe = mock(() => [
      {
        service: "kv",
        space: bobSpaceId,
        path: "",
        actions: ["tinycloud.kv/put"],
      },
    ]);
    (node as any).registerPrimarySessionGrant(primarySession(node));

    const fallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: aliceSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeWithRuntimePermissions(
      fallback,
      "kv",
      "vault/x",
      "tinycloud.kv/put",
    );
    // The Alice-space grant wins; the Bob-space primary recap must not.
    expect(invoke.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "hijack-token",
    );
  });

  test("skipped-activation space is excluded from the synthetic primary grant", () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const defaultSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;

    // A bootstrap grant that actually works covers the space.
    installBroadGrant(node, defaultSpaceId, "kv", "tinycloud.kv/put", "bootstrap");

    // The node REFUSED to activate this space this sign-in, so even though the
    // recap claims it, the synthetic primary must NOT include it — otherwise
    // the (non-working) primary would out-rank the working bootstrap grant.
    (node as any).auth.lastActivationSkippedSpaceIds = [defaultSpaceId];
    (node as any).wasmBindings.parseRecapFromSiwe = mock(() => [
      {
        service: "kv",
        space: defaultSpaceId,
        path: "",
        actions: ["tinycloud.kv/put"],
      },
    ]);
    (node as any).registerPrimarySessionGrant(primarySession(node));

    // No primary grant should have been registered (only the bootstrap grant).
    const grants = (node as any).runtimePermissionGrants;
    expect(grants.some((g: any) => g.provenance === "primary")).toBe(false);

    const fallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: defaultSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeWithRuntimePermissions(
      fallback,
      "kv",
      "vault/x",
      "tinycloud.kv/put",
    );
    // The working bootstrap grant wins.
    expect(invoke.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "hijack-token",
    );
  });

  test("invokeAny: primary wins when it covers all entries, grant when it doesn't", () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const defaultSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
    const secretsSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:secrets`;

    // A single delegated grant that covers BOTH spaces (two operations), so a
    // multi-space batch can be satisfied by one grant.
    (node as any).runtimePermissionGrants.push({
      session: {
        delegationHeader: { Authorization: "hijack-token" },
        delegationCid: "hijack-cid",
        spaceId: defaultSpaceId,
        verificationMethod: "did:key:hijack",
        jwk: { kty: "OKP" },
      },
      delegation: {
        cid: "hijack-cid",
        delegationHeader: { Authorization: "hijack-token" },
        delegateDID: "did:key:hijack",
        delegatorDID: node.did,
        spaceId: defaultSpaceId,
        path: "",
        actions: ["tinycloud.sql/write"],
        expiry: new Date(Date.now() + 3600_000),
        allowSubDelegation: true,
        ownerAddress: ADDRESS,
        chainId: 1,
        host: "https://tinycloud.test",
      },
      operations: [
        { spaceId: defaultSpaceId, service: "sql", path: "", action: "tinycloud.sql/write" },
        { spaceId: secretsSpaceId, service: "sql", path: "", action: "tinycloud.sql/write" },
      ],
      expiresAt: new Date(Date.now() + 3600_000),
      provenance: "delegated",
    });

    // Primary recap only covers the DEFAULT space.
    (node as any).wasmBindings.parseRecapFromSiwe = mock(() => [
      {
        service: "sql",
        space: defaultSpaceId,
        path: "default",
        actions: ["tinycloud.sql/write"],
      },
    ]);
    (node as any).registerPrimarySessionGrant(primarySession(node));

    const fallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: defaultSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    // All entries covered by primary -> primary wins.
    (node as any).invokeAnyWithRuntimePermissions(
      fallback,
      [
        {
          spaceId: defaultSpaceId,
          service: "sql",
          path: "default",
          action: "tinycloud.sql/write",
        },
      ],
      [{}],
    );
    const invokeAny = (node as any).wasmBindings.invokeAny;
    expect(invokeAny.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "base-token",
    );

    // One entry only covered by a grant (secrets space) -> grant wins.
    (node as any).invokeAnyWithRuntimePermissions(
      fallback,
      [
        {
          spaceId: defaultSpaceId,
          service: "sql",
          path: "default",
          action: "tinycloud.sql/write",
        },
        {
          spaceId: secretsSpaceId,
          service: "sql",
          path: "default",
          action: "tinycloud.sql/write",
        },
      ],
      [{}, {}],
    );
    expect(invokeAny.mock.calls[1][0].delegationHeader.Authorization).toBe(
      "hijack-token",
    );
  });

  test("getRuntimePermissionDelegations never returns the synthetic primary grant", () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const defaultSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;

    // One real delegated grant plus the synthetic primary.
    installBroadGrant(node, defaultSpaceId, "kv", "tinycloud.kv/put", "delegated");
    (node as any).wasmBindings.parseRecapFromSiwe = mock(() => [
      {
        service: "kv",
        space: defaultSpaceId,
        path: "",
        actions: ["tinycloud.kv/put"],
      },
    ]);
    (node as any).registerPrimarySessionGrant(primarySession(node));

    // Sanity: the synthetic primary IS registered.
    expect(
      (node as any).runtimePermissionGrants.some(
        (g: any) => g.provenance === "primary",
      ),
    ).toBe(true);

    // Unfiltered public listing must exclude it (only the delegated grant).
    const delegations = node.getRuntimePermissionDelegations();
    expect(delegations).toHaveLength(1);
    expect(delegations[0].cid).toBe("hijack-cid");

    // Permission-filtered public listing must also exclude it: even though the
    // primary recap covers this op, only the delegated grant is returned.
    const filtered = node.getRuntimePermissionDelegations([
      {
        service: "tinycloud.kv",
        space: "default",
        path: "vault/x",
        actions: ["tinycloud.kv/put"],
      },
    ]);
    expect(filtered.every((d) => d.cid !== "base-cid")).toBe(true);
  });

  // TC-111 follow-up (prod regression): a multi-space primary recap covers ops
  // on OTHER spaces than the primary session's own `spaceId`. When the primary
  // grant wins for such an op, the invocation must be minted with the caller's
  // SCOPED fallback session (correct target `spaceId`), NOT the stored primary
  // `ServiceSession` (whose `spaceId` is the primary space). Before the fix, the
  // account-registry write for a scoped `account`-space op was minted against
  // the primary `applications` space and the node rejected it (404/40x).
  test("primary wins but mints with the scoped fallback session (wrong-space regression)", () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    // Space A: the primary session's own space (as installed by the harness).
    const applicationsSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
    // Space B: a DIFFERENT space the multi-space recap also covers.
    const accountSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:account`;

    // Primary recap covers BOTH the primary space AND the account space.
    (node as any).wasmBindings.parseRecapFromSiwe = mock(() => [
      {
        service: "kv",
        space: applicationsSpaceId,
        path: "",
        actions: ["tinycloud.kv/put"],
      },
      {
        service: "kv",
        space: accountSpaceId,
        path: "applications/",
        actions: ["tinycloud.kv/put"],
      },
    ]);
    (node as any).registerPrimarySessionGrant(primarySession(node));
    // A broad non-primary grant also covers the op. This makes the three
    // outcomes distinguishable: "scoped-token" = correct (primary won, caller
    // session used), "base-token" = call-site regression (primary session
    // returned), "hijack-token" = ranking regression (primary registration or
    // coverage silently broken, grant won). Without it, a primary-registration
    // failure would fall through to the fallback and pass vacuously.
    installBroadGrant(node, accountSpaceId, "kv", "tinycloud.kv/put", "delegated");

    // The caller passes a SCOPED fallback session for the account space: same
    // primary delegation, but the correct target `spaceId` and a distinct token.
    const scopedFallback = {
      delegationHeader: { Authorization: "scoped-token" },
      delegationCid: "scoped-cid",
      spaceId: accountSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeWithRuntimePermissions(
      scopedFallback,
      "kv",
      "applications/xyz.tinycloud.listen",
      "tinycloud.kv/put",
    );

    // Must mint with the SCOPED fallback (account space), not the primary
    // session whose spaceId is the applications space.
    expect(invoke.mock.calls[0][0].spaceId).toBe(accountSpaceId);
    expect(invoke.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "scoped-token",
    );
  });

  // invokeAny analog of the wrong-space regression above.
  test("invokeAny: primary wins but mints with the scoped fallback session", () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const applicationsSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
    const accountSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:account`;

    (node as any).wasmBindings.parseRecapFromSiwe = mock(() => [
      {
        service: "kv",
        space: applicationsSpaceId,
        path: "",
        actions: ["tinycloud.kv/put"],
      },
      {
        service: "kv",
        space: accountSpaceId,
        path: "applications/",
        actions: ["tinycloud.kv/put"],
      },
    ]);
    (node as any).registerPrimarySessionGrant(primarySession(node));
    // Broad non-primary grant covering the op — see the single-invoke test
    // above for why this keeps the test non-vacuous.
    installBroadGrant(node, accountSpaceId, "kv", "tinycloud.kv/put", "delegated");

    const scopedFallback = {
      delegationHeader: { Authorization: "scoped-token" },
      delegationCid: "scoped-cid",
      spaceId: accountSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeAnyWithRuntimePermissions(
      scopedFallback,
      [
        {
          spaceId: accountSpaceId,
          service: "kv",
          path: "applications/xyz.tinycloud.listen",
          action: "tinycloud.kv/put",
        },
      ],
      [{}],
    );

    const invokeAny = (node as any).wasmBindings.invokeAny;
    expect(invokeAny.mock.calls[0][0].spaceId).toBe(accountSpaceId);
    expect(invokeAny.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "scoped-token",
    );
  });

  test("a multi-space bootstrap grant invokes against the target space (TC-957)", () => {
    const invoke = mock((session: any) => ({
      Authorization: session.delegationHeader.Authorization,
    })) as any;
    const node = makeNode(invoke);
    const defaultSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
    const accountSpaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:account`;

    // The widened default bootstrap session: minted for the default space but
    // its recap also covers the account-index database on the account space.
    (node as any).runtimePermissionGrants.push({
      session: {
        delegationHeader: { Authorization: "bootstrap-token" },
        delegationCid: "bootstrap-cid",
        spaceId: defaultSpaceId,
        verificationMethod: "did:key:bootstrap",
        jwk: { kty: "OKP" },
      },
      delegation: {
        cid: "bootstrap-cid",
        delegationHeader: { Authorization: "bootstrap-token" },
        delegateDID: "did:key:bootstrap",
        delegatorDID: node.did,
        spaceId: defaultSpaceId,
        path: "",
        actions: ["tinycloud.sql/schema"],
        expiry: new Date(Date.now() + 3600_000),
        allowSubDelegation: true,
        ownerAddress: ADDRESS,
        chainId: 1,
        host: "https://tinycloud.test",
      },
      operations: [
        { spaceId: defaultSpaceId, service: "sql", path: "", action: "tinycloud.sql/read" },
        { spaceId: accountSpaceId, service: "sql", path: "account", action: "tinycloud.sql/schema" },
      ],
      expiresAt: new Date(Date.now() + 3600_000),
      provenance: "bootstrap",
    });

    const accountFallback = {
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      spaceId: accountSpaceId,
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP" },
    };

    (node as any).invokeWithRuntimePermissions(
      accountFallback,
      "sql",
      "account",
      "tinycloud.sql/schema",
    );

    // The bootstrap grant's key and proof, but the account space as target:
    // minting against the grant's own (default) space would address
    // `…:default/sql/account` instead.
    expect(invoke.mock.calls[0][0].delegationHeader.Authorization).toBe(
      "bootstrap-token",
    );
    expect(invoke.mock.calls[0][0].spaceId).toBe(accountSpaceId);

    // An op on the grant's own space keeps the grant's session untouched,
    // including its spelling of the space id (callers may lowercase it).
    (node as any).invokeWithRuntimePermissions(
      { ...accountFallback, spaceId: defaultSpaceId.toLowerCase() },
      "sql",
      "",
      "tinycloud.sql/read",
    );
    expect(invoke.mock.calls[1][0].delegationHeader.Authorization).toBe(
      "bootstrap-token",
    );
    expect(invoke.mock.calls[1][0].spaceId).toBe(defaultSpaceId);
  });
});

describe("TinyCloudNode grantRuntimePermissions issued expiry", () => {
  const secretsPermission: PermissionEntry = {
    service: "tinycloud.kv",
    space: "secrets",
    path: "vault/secrets/ANTHROPIC_API_KEY",
    actions: ["tinycloud.kv/put"],
  };
  // makeNode() signs in with a SIWE whose expiration is 2999-01-01T00:00:00.000Z.
  const SESSION_EXPIRY_MS = Date.parse("2999-01-01T00:00:00.000Z");

  test("the issued delegation expires at the requested expiry", async () => {
    const node = makeNode(mock(() => ({})) as IWasmBindings["invoke"]);
    await withActivatedDelegations(async () => {
      const before = Date.now();
      const delegations = await node.grantRuntimePermissions([secretsPermission], {
        expiry: 3_600_000,
      });
      const after = Date.now();
      expect(delegations).toHaveLength(1);
      const issued = new Date(delegations[0].expiry).getTime();
      expect(issued).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(issued).toBeLessThanOrEqual(after + 3_600_000);
    });
  });

  test("the issued delegation defaults to the 30-day window when no expiry is given", async () => {
    const node = makeNode(mock(() => ({})) as IWasmBindings["invoke"]);
    await withActivatedDelegations(async () => {
      const before = Date.now();
      const delegations = await node.grantRuntimePermissions([secretsPermission]);
      const after = Date.now();
      expect(delegations).toHaveLength(1);
      const issued = new Date(delegations[0].expiry).getTime();
      expect(issued).toBeGreaterThanOrEqual(before + DEFAULT_DELEGATION_EXPIRY_MS);
      expect(issued).toBeLessThanOrEqual(after + DEFAULT_DELEGATION_EXPIRY_MS);
    });
  });

  test("the issued delegation never outlives the session", async () => {
    const node = makeNode(mock(() => ({})) as IWasmBindings["invoke"]);
    await withActivatedDelegations(async () => {
      const delegations = await node.grantRuntimePermissions([secretsPermission], {
        expiry: 2_000 * 365 * 24 * 3_600_000,
      });
      expect(delegations).toHaveLength(1);
      expect(new Date(delegations[0].expiry).getTime()).toBe(SESSION_EXPIRY_MS);
    });
  });
});

function allPrepareExpiryMs(node: TinyCloudNode): number[] {
  const wasm = node as unknown as {
    wasmBindings: { prepareSession: { mock: { calls: Array<[{ expirationTime: string }]> } } };
  };
  return wasm.wasmBindings.prepareSession.mock.calls.map(([call]) => new Date(call.expirationTime).getTime());
}

describe("TinyCloudNode per-entry permission coverage (TC-1781)", () => {
  const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
  const SECRETS_SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:secrets`;
  const KV_PATH = "vault/secrets/API_KEY";
  const DECRYPT_ACTIONS = ["decrypt"];
  const CLOCK_SLACK_MS = 5_000;
  const KV_GET_ENTRY: PermissionEntry = {
    service: "tinycloud.kv",
    space: SECRETS_SPACE,
    path: KV_PATH,
    actions: ["get"],
    skipPrefix: true,
  };
  const KV_GET_RECAP = [{
    service: "kv",
    space: SECRETS_SPACE,
    path: KV_PATH,
    actions: ["tinycloud.kv/get"],
  }];

  function decryptEntryFor(node: TinyCloudNode): PermissionEntry {
    return {
      service: "tinycloud.encryption",
      path: node.getEncryptionNetworkIdForSpace(SECRETS_SPACE),
      actions: DECRYPT_ACTIONS,
      skipPrefix: true,
    };
  }

  function nodeWithSessionRecap(recap: unknown[]): TinyCloudNode {
    const node = makeNode(mock(() => ({})));
    Reflect.set(node, "_address", ADDRESS);
    (node as any).wasmBindings.parseRecapFromSiwe = mock(() => recap);
    return node;
  }

  function stubBaseSecrets(node: TinyCloudNode) {
    const base = { get: mock(async () => ({ ok: true, data: "value" })) };
    (node as any).getBaseSecrets = () => base;
    (node as any)._spaceService = {};
    return base;
  }

  function spyOnGrant(node: TinyCloudNode) {
    const spy = mock(node.grantRuntimePermissions.bind(node));
    (node as any).grantRuntimePermissions = spy;
    return spy;
  }

  async function withFetchActivated<T>(fn: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ activated: ["runtime-cid"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as any;
    try {
      return await fn();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  function walletCallCounts(node: TinyCloudNode) {
    const wasm = (node as any).wasmBindings;
    return {
      signatures: ((node as any).signer.signMessage as ReturnType<typeof mock>).mock.calls.length,
      prepareSession: wasm.prepareSession.mock.calls.length,
      createDelegation: wasm.createDelegation.mock.calls.length,
    };
  }

  function expectExpiriesNear(node: TinyCloudNode, expectedMs: number): void {
    const now = Date.now();
    const expiries = [
      ...allPrepareExpiryMs(node),
      ...node.getRuntimePermissionDelegations().map((d) => d.expiry.getTime()),
    ];
    expect(expiries.length).toBeGreaterThan(0);
    for (const expiry of expiries) {
      expect(Math.abs(expiry - now - expectedMs)).toBeLessThanOrEqual(CLOCK_SLACK_MS);
    }
  }

  test("secrets.get succeeds on a session kv get plus a decrypt-only runtime grant, with zero new calls", async () => {
    const node = nodeWithSessionRecap(KV_GET_RECAP);
    const decryptEntry = decryptEntryFor(node);
    await withFetchActivated(() => node.grantRuntimePermissions([decryptEntry]));
    expect(node.getRuntimePermissionDelegations([decryptEntry])).toHaveLength(1);

    const base = stubBaseSecrets(node);
    const before = walletCallCounts(node);

    const result = await node.secrets.get("API_KEY");

    expect(result).toEqual({ ok: true, data: "value" });
    expect(base.get).toHaveBeenCalled();
    expect(walletCallCounts(node)).toEqual(before);
  });

  test("hasRuntimePermissions requires every entry, each covered on its own", () => {
    const node = nodeWithSessionRecap(KV_GET_RECAP);
    const decryptEntry = decryptEntryFor(node);

    // Session covers the kv get; nothing covers decrypt.
    expect(node.hasRuntimePermissions([KV_GET_ENTRY])).toBe(true);
    expect(node.hasRuntimePermissions([decryptEntry])).toBe(false);
    expect(node.hasRuntimePermissions([KV_GET_ENTRY, decryptEntry])).toBe(false);
  });

  test("a split set, kv from the session and decrypt from a runtime grant, is not covered jointly", async () => {
    const node = nodeWithSessionRecap(KV_GET_RECAP);
    const decryptEntry = decryptEntryFor(node);
    await withFetchActivated(() => node.grantRuntimePermissions([decryptEntry]));

    expect(node.hasRuntimePermissions([KV_GET_ENTRY])).toBe(true);
    expect(node.hasRuntimePermissions([decryptEntry])).toBe(true);
    expect(node.hasRuntimePermissions([KV_GET_ENTRY, decryptEntry])).toBe(false);
  });

  test("a joint set held by one live runtime grant counts as covered", async () => {
    const node = nodeWithSessionRecap([]);
    const decryptEntry = decryptEntryFor(node);
    await withFetchActivated(() => node.grantRuntimePermissions([KV_GET_ENTRY, decryptEntry]));

    expect(node.hasRuntimePermissions([KV_GET_ENTRY, decryptEntry])).toBe(true);
  });

  test("an entry covered only by an expired runtime grant does not count as covered", async () => {
    const node = nodeWithSessionRecap(KV_GET_RECAP);
    const decryptEntry = decryptEntryFor(node);
    await withFetchActivated(() => node.grantRuntimePermissions([decryptEntry]));
    expect(node.hasRuntimePermissions([decryptEntry])).toBe(true);

    const grants = (node as any).runtimePermissionGrants as Array<{ expiresAt: Date }>;
    for (const grant of grants) grant.expiresAt = new Date(Date.now() - 1);

    expect(node.hasRuntimePermissions([decryptEntry])).toBe(false);
    expect(node.hasRuntimePermissions([KV_GET_ENTRY, decryptEntry])).toBe(false);
  });

  test("a one-hour decrypt-only grant costs one signature in total, and repeat reads cost none", async () => {
    const node = nodeWithSessionRecap(KV_GET_RECAP);
    const decryptEntry = decryptEntryFor(node);
    await withFetchActivated(() => node.grantRuntimePermissions([decryptEntry], { expiry: 3_540_000 }));
    stubBaseSecrets(node);

    await withFetchActivated(() => node.secrets.get("API_KEY"));
    const afterFirst = walletCallCounts(node);
    await withFetchActivated(() => node.secrets.get("API_KEY"));
    const afterSecond = walletCallCounts(node);

    expect(afterFirst.signatures).toBe(1);
    expect(afterSecond).toEqual(afterFirst);
    expectExpiriesNear(node, 3_540_000);
  });

  test("no prior step-up, session holds kv get: secrets.get escalates once, requesting only decrypt, on the default expiry", async () => {
    const node = nodeWithSessionRecap(KV_GET_RECAP);
    stubBaseSecrets(node);
    const grant = spyOnGrant(node);

    const result = await withFetchActivated(() => node.secrets.get("API_KEY"));

    expect(result).toEqual({ ok: true, data: "value" });
    expect(grant).toHaveBeenCalledTimes(1);
    const requested = grant.mock.calls[0][0] as PermissionEntry[];
    expect(requested.map((e) => e.actions)).toEqual([DECRYPT_ACTIONS]);
    expect(node.getRuntimePermissionDelegations()).toHaveLength(1);
    expectExpiriesNear(node, DEFAULT_DELEGATION_EXPIRY_MS);
  });

  test("kv get outside the session manifest, decrypt already held: escalation requests only the kv get", async () => {
    const node = nodeWithSessionRecap([]);
    const decryptEntry = decryptEntryFor(node);
    await withFetchActivated(() => node.grantRuntimePermissions([decryptEntry]));
    stubBaseSecrets(node);
    const grant = spyOnGrant(node);

    const result = await withFetchActivated(() => node.secrets.get("API_KEY"));

    expect(result).toEqual({ ok: true, data: "value" });
    expect(grant).toHaveBeenCalledTimes(1);
    const requested = grant.mock.calls[0][0] as PermissionEntry[];
    expect(requested.map((e) => e.service)).toEqual(["tinycloud.kv"]);
  });

  test("nothing held: secrets.get grants the kv get and decrypt pair together, on the default expiry", async () => {
    const node = nodeWithSessionRecap([]);
    stubBaseSecrets(node);
    const grant = spyOnGrant(node);

    await withFetchActivated(() => node.secrets.get("API_KEY"));

    expect(grant).toHaveBeenCalledTimes(1);
    const requested = grant.mock.calls[0][0] as PermissionEntry[];
    expect(requested.map((e) => e.service)).toEqual(["tinycloud.kv", "tinycloud.encryption"]);
    expectExpiriesNear(node, DEFAULT_DELEGATION_EXPIRY_MS);
  });

  test("session-only node: a get whose entries are each covered proceeds with no grant and no signer", async () => {
    const node = nodeWithSessionRecap(KV_GET_RECAP);
    const decryptEntry = decryptEntryFor(node);
    await withFetchActivated(() => node.grantRuntimePermissions([decryptEntry]));
    (node as any).signer = undefined;
    const base = stubBaseSecrets(node);
    const grant = spyOnGrant(node);

    const result = await node.secrets.get("API_KEY");

    expect(result).toEqual({ ok: true, data: "value" });
    expect(base.get).toHaveBeenCalledTimes(1);
    expect(grant).not.toHaveBeenCalled();
  });

  test("session-only node: a get with an uncovered entry is denied, with no grant attempt", async () => {
    const node = nodeWithSessionRecap([]);
    (node as any).signer = undefined;
    const base = stubBaseSecrets(node);
    const grant = spyOnGrant(node);

    const result = await node.secrets.get("API_KEY");

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: ErrorCodes.PERMISSION_DENIED,
        message:
          "Cannot autosign tinycloud.kv/get for API_KEY; TinyCloudNode needs wallet mode with a signer or privateKey.",
      }),
    });
    expect(base.get).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });
});
