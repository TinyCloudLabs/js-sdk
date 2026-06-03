import { describe, expect, mock, test } from "bun:test";

import {
  type ISessionManager,
  type IWasmBindings,
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
});
