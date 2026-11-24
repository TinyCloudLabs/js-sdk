import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import type { PermissionEntry } from "@tinycloud/sdk-core";

import { listPermissionRequests } from "../artifacts.js";
import { delegationWithinRequest, evaluateOperationAuthority } from "../authority.js";
import { invokeSecretsGetWithLocalAuthorityRetry } from "../cli-runtime.js";
import { invokeOperation } from "../invoke.js";
import { secretsGetOperationDefinition } from "./secrets-get.js";
import { operationSpaceResolver } from "../secrets.js";
import { profileConfigPath, writeJsonAtomic } from "../state.js";
import type { RuntimeOperationContext } from "../contract.js";
import { createAuthRuntimeFixture, persistRuntimeDelegations } from "../../test-support/auth-runtime.js";

/**
 * Captured real refusal from tinycloud-node 1.26.21 with NAMED_KEYS_V1=true:
 *   HTTP 403 text/plain:
 *   "Unauthorized Action: urn:tinycloud:encryption:did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266:default/secrets/cli_e2e_secret_1795412093937 / tinycloud.encryption/decrypt"
 * DataVaultService.decryptStored maps that 403 to this exact permissionHint shape.
 */
const CAPTURED_NODE_OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CAPTURED_NODE_NETWORK = `urn:tinycloud:encryption:did:pkh:eip155:1:${CAPTURED_NODE_OWNER}:default`;
const CAPTURED_NODE_KEY_HINT: PermissionEntry = {
  service: "tinycloud.encryption",
  path: `${CAPTURED_NODE_NETWORK}/secrets/cli_e2e_secret_1795412093937`,
  actions: ["tinycloud.encryption/decrypt"],
};

let tail = Promise.resolve();

function isolated(name: string, body: () => Promise<unknown>): void {
  test(name, async () => {
    const prev = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await prev;

    const prevTcHome = process.env.TC_HOME;
    let home: string | undefined;
    try {
      home = await mkdtemp(`${tmpdir()}/tinycloud-named-key-hint-`);
      process.env.TC_HOME = home;
      return await body();
    } finally {
      try {
        if (prevTcHome === undefined) delete process.env.TC_HOME;
        else process.env.TC_HOME = prevTcHome;
        if (home !== undefined) await rm(home, { recursive: true, force: true });
      } finally {
        release();
      }
    }
  });
}

async function writeLocalProfile(name: string, ownerAddress: string): Promise<string> {
  const spaceId = `tinycloud:pkh:eip155:1:${ownerAddress}:secrets`;
  await writeJsonAtomic(profileConfigPath(name), {
    name,
    host: "https://node.invalid",
    chainId: 1,
    spaceName: "secrets",
    spaceId,
    did: `did:pkh:eip155:1:${ownerAddress}`,
    posture: "owner-openkey",
    operatorType: "human",
    authMethod: "openkey",
    createdAt: "2026-07-15T00:00:00.000Z",
  });
  return spaceId;
}

isolated("accepts exact per-secret named-key hints (unscoped and scoped) and keeps bare-network hint accepted", async () => {
  const fixture = await createAuthRuntimeFixture();
  const full = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [full]);
  const bareDecrypt = fixture.hermetic.permissions.find((p) => p.service === "tinycloud.encryption")!;
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");

  try {
    // 1. Exact per-secret named-key hint (unscoped), matching the captured node 1.26.21 shape.
    const unscopedKeyHint: PermissionEntry = {
      service: "tinycloud.encryption",
      path: `${bareDecrypt.path}/secrets/hermetic_delegation_canary`,
      actions: ["tinycloud.encryption/decrypt"],
    };
    readSecret.mockResolvedValue({ status: "permission_required", hint: unscopedKeyHint } as never);
    const unscopedResult = await invokeOperation(
      "tinycloud.secrets.get",
      1,
      { profile: fixture.profile },
      { name: "HERMETIC_DELEGATION_CANARY" },
    );
    expect(unscopedResult.status).toBe("authority_required");
    if (unscopedResult.status !== "authority_required") throw new Error("expected authority_required");
    expect(unscopedResult.missing as unknown).toEqual([unscopedKeyHint]);
    expect(unscopedResult.request.requested as unknown).toEqual([unscopedKeyHint]);

    // 2. Bare-network decrypt hint stays accepted for legacy v1 / non-named-keys nodes.
    readSecret.mockResolvedValue({ status: "permission_required", hint: bareDecrypt } as never);
    const bareResult = await invokeOperation(
      "tinycloud.secrets.get",
      1,
      { profile: fixture.profile },
      { name: "HERMETIC_DELEGATION_CANARY" },
    );
    expect(bareResult.status).toBe("authority_required");
    if (bareResult.status !== "authority_required") throw new Error("expected authority_required");
    expect(bareResult.missing).toHaveLength(1);
    expect(bareResult.missing[0]).toMatchObject({
      service: "tinycloud.encryption",
      actions: ["tinycloud.encryption/decrypt"],
    });
    expect(String(bareResult.missing[0]?.path).toLowerCase()).toBe(bareDecrypt.path.toLowerCase());
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }

  // 3. Scoped secret named-key runtime hint derives exact `secrets/scoped/<scope>/<lower(name)>`
  //    with canonical EIP-55 owner even when `getEncryptionNetworkIdForSpace` returns a lowercased PKH address.
  const runtimeCtx = {
    summary: {
      profile: "delegate",
      host: "https://node.tinycloud.test",
      posture: "delegate-session",
      sessionDid: "did:key:session",
    },
    runtime: {
      node: {
        getEncryptionNetworkIdForSpace: () => CAPTURED_NODE_NETWORK.toLowerCase(),
      },
      granted: [],
    },
  } as unknown as RuntimeOperationContext;
  const scopedInput = secretsGetOperationDefinition.input.parse({
    name: "API_KEY",
    scope: "Food Tracker",
    space: `tinycloud:pkh:eip155:1:${CAPTURED_NODE_OWNER.toLowerCase()}:secrets`,
  });
  const scopedHints = await secretsGetOperationDefinition.runtimeHints!(runtimeCtx, scopedInput);
  expect(scopedHints).toEqual([
    {
      service: "tinycloud.encryption",
      path: `${CAPTURED_NODE_NETWORK}/secrets/scoped/food-tracker/api_key`,
      actions: ["tinycloud.encryption/decrypt"],
    },
  ]);

  // Reserved unscoped name `SCOPED` and names over 64 chars have no named key.
  const reservedInput = secretsGetOperationDefinition.input.parse({
    name: "SCOPED",
    space: `tinycloud:pkh:eip155:1:${CAPTURED_NODE_OWNER.toLowerCase()}:secrets`,
  });
  expect(await secretsGetOperationDefinition.runtimeHints!(runtimeCtx, reservedInput)).toEqual([]);
  const tooLongInput = secretsGetOperationDefinition.input.parse({
    name: `A${"B".repeat(64)}`,
    space: `tinycloud:pkh:eip155:1:${CAPTURED_NODE_OWNER.toLowerCase()}:secrets`,
  });
  expect(await secretsGetOperationDefinition.runtimeHints!(runtimeCtx, tooLongInput)).toEqual([]);
});

isolated("refuses wrong-secret, prefix, wildcard, wrong-action, wrong-network, non-canonical, and non-secret named-key hints", async () => {
  const fixture = await createAuthRuntimeFixture();
  const full = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [full]);
  const bareDecrypt = fixture.hermetic.permissions.find((p) => p.service === "tinycloud.encryption")!;
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");

  try {
    const otherOwnerNetwork = `urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000009:default`;
    const otherNameNetwork = bareDecrypt.path.replace(/:default$/, ":other");
    const lowerOwnerNetwork = bareDecrypt.path.toLowerCase();

    const rejectedHints: PermissionEntry[] = [
      // Different secret's key.
      { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets/other_secret`, actions: ["tinycloud.encryption/decrypt"] },
      // Scoped key when reading unscoped secret.
      { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets/scoped/app/hermetic_delegation_canary`, actions: ["tinycloud.encryption/decrypt"] },
      // Prefix under secrets/.
      { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets/`, actions: ["tinycloud.encryption/decrypt"] },
      // Bare secrets key.
      { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets`, actions: ["tinycloud.encryption/decrypt"] },
      // Wildcard path or action.
      { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets/*`, actions: ["tinycloud.encryption/decrypt"] },
      { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets/hermetic_delegation_canary`, actions: ["tinycloud.encryption/*"] },
      // Non-decrypt actions on this secret's key.
      { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets/hermetic_delegation_canary`, actions: ["tinycloud.encryption/key.create"] },
      { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets/hermetic_delegation_canary`, actions: ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"] },
      // Wrong owner network (including captured node owner when fixture owner differs).
      CAPTURED_NODE_KEY_HINT,
      { service: "tinycloud.encryption", path: `${otherOwnerNetwork}/secrets/hermetic_delegation_canary`, actions: ["tinycloud.encryption/decrypt"] },
      // Different network name on the same owner.
      { service: "tinycloud.encryption", path: `${otherNameNetwork}/secrets/hermetic_delegation_canary`, actions: ["tinycloud.encryption/decrypt"] },
      // Non-canonical (lowercased) EIP-55 owner on a named key.
      { service: "tinycloud.encryption", path: `${lowerOwnerNetwork}/secrets/hermetic_delegation_canary`, actions: ["tinycloud.encryption/decrypt"] },
      // Uppercase key segment (not canonical).
      { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets/HERMETIC_DELEGATION_CANARY`, actions: ["tinycloud.encryption/decrypt"] },
      // Non-secret namespace.
      { service: "tinycloud.encryption", path: `${bareDecrypt.path}/apps/com.example/hermetic_delegation_canary`, actions: ["tinycloud.encryption/decrypt"] },
    ];

    for (const hint of rejectedHints) {
      readSecret.mockResolvedValue({ status: "permission_required", hint } as never);
      const result = await invokeOperation(
        "tinycloud.secrets.get",
        1,
        { profile: fixture.profile },
        { name: "HERMETIC_DELEGATION_CANARY" },
      );
      expect(result).toMatchObject({ status: "error", error: { code: "PERMISSION_HINT_INVALID" } });
    }
    expect(await listPermissionRequests(fixture.profile)).toEqual([]);
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

isolated("local private-key authority retry grants and accepts an exact per-secret named-key runtime hint", async () => {
  const ownerSpace = await writeLocalProfile("local-test", CAPTURED_NODE_OWNER);
  const baseCapabilities: PermissionEntry[] = [
    {
      service: "tinycloud.kv",
      space: ownerSpace,
      path: "vault/secrets/CLI_E2E_SECRET_1795412093937",
      actions: ["tinycloud.kv/get"],
    },
    {
      service: "tinycloud.encryption",
      path: CAPTURED_NODE_NETWORK,
      actions: ["tinycloud.encryption/decrypt"],
    },
  ];
  const activated: PermissionEntry[] = [];
  const grantedRequests: PermissionEntry[][] = [];
  let reads = 0;

  const signIn = spyOn(TinyCloudNode.prototype, "signIn").mockImplementation(async function (this: TinyCloudNode) {
    const node = this as unknown as { _address?: string; _chainId: number };
    node._address = CAPTURED_NODE_OWNER;
    node._chainId = 1;
  });
  const getCapabilities = spyOn(TinyCloudNode.prototype, "getVerifiedSessionCapabilities")
    .mockImplementation(() => baseCapabilities as never);
  const getEffective = spyOn(TinyCloudNode.prototype, "getEffectiveRuntimePermissionEntries")
    .mockImplementation(() => activated as never);
  const hasRuntime = spyOn(TinyCloudNode.prototype, "hasRuntimePermissions")
    .mockImplementation((perms) => perms.every((p) => activated.some((a) => a.path === p.path && a.service === p.service)));
  const grantRuntime = spyOn(TinyCloudNode.prototype, "grantRuntimePermissions")
    .mockImplementation(async (perms) => {
      grantedRequests.push([...perms]);
      activated.push(...perms);
      return [] as never;
    });
  const network = spyOn(TinyCloudNode.prototype, "getEncryptionNetworkIdForSpace")
    .mockReturnValue(CAPTURED_NODE_NETWORK.toLowerCase());
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret").mockImplementation(async () => {
    reads += 1;
    return reads === 1
      ? { status: "permission_required", hint: CAPTURED_NODE_KEY_HINT } as never
      : { status: "ok", value: "named-key-secret-value" };
  });

  try {
    const result = await invokeSecretsGetWithLocalAuthorityRetry(
      { profile: "local-test", host: "https://node.invalid", allowOwnerProfile: true, privateKey: "1".repeat(64) },
      { name: "CLI_E2E_SECRET_1795412093937" },
    );
    expect(result).toMatchObject({ status: "ok", output: { value: "named-key-secret-value" } });
    expect(reads).toBe(2);
    expect(grantedRequests).toEqual([[CAPTURED_NODE_KEY_HINT]]);
  } finally {
    signIn.mockRestore();
    getCapabilities.mockRestore();
    getEffective.mockRestore();
    hasRuntime.mockRestore();
    grantRuntime.mockRestore();
    network.mockRestore();
    readSecret.mockRestore();
  }
});

test("authority canonicalization preserves canonical EIP-55 owners on named-key grants during replay", () => {
  const resolve = operationSpaceResolver({}, `tinycloud:pkh:eip155:1:${CAPTURED_NODE_OWNER.toLowerCase()}:secrets`);
  const withMarker: PermissionEntry = { ...CAPTURED_NODE_KEY_HINT, space: "encryption" };

  // Matching canonical EIP-55 named-key grant stays inside its bound request.
  expect(delegationWithinRequest([CAPTURED_NODE_KEY_HINT], [CAPTURED_NODE_KEY_HINT], resolve)).toBe(true);
  expect(delegationWithinRequest([withMarker], [CAPTURED_NODE_KEY_HINT], resolve)).toBe(true);
  expect(evaluateOperationAuthority([CAPTURED_NODE_KEY_HINT], [withMarker], resolve).satisfied).toBe(true);

  // Different secret key or non-canonical (lowercased) owner is refused.
  expect(delegationWithinRequest(
    [CAPTURED_NODE_KEY_HINT],
    [{ ...CAPTURED_NODE_KEY_HINT, path: `${CAPTURED_NODE_NETWORK}/secrets/other_secret` }],
    resolve,
  )).toBe(false);
  expect(delegationWithinRequest(
    [CAPTURED_NODE_KEY_HINT],
    [{ ...CAPTURED_NODE_KEY_HINT, path: CAPTURED_NODE_KEY_HINT.path.toLowerCase() }],
    resolve,
  )).toBe(false);
});
