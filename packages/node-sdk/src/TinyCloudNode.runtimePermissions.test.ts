import { describe, expect, mock, test } from "bun:test";

import {
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
} from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

function makeFakeSessionManager(): ISessionManager {
  return {
    createSessionKey: (id: string) => id,
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
          space: encryptionSpaceId,
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
        expect(targetNode).toBe(node.did);
        expect(signedNetworkId).toBe(networkId);
        expect(action).toBe("tinycloud.encryption/decrypt");
        expect(facts.targetNode).toBe(node.did);
        expect(facts.networkId).toBe(networkId);
        return {
          authorization: "Invocation node-encryption",
          invocationCid: "bafy-node-encryption",
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
        const invocationCid = "bafy-node-encryption";
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
      expect(fetchCalls.map((call) => call.method)).toEqual(["GET", "GET", "POST"]);
      expect(signRawNetworkAuthorization).toHaveBeenCalledTimes(1);

      const postCall = fetchCalls[2];
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
});
