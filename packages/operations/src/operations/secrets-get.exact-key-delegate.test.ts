import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import type { PermissionEntry } from "@tinycloud/sdk-core";

import { evaluateOperationAuthority } from "../authority.js";
import { invokeOperation } from "../invoke.js";
import { secretsGetOperationDefinition } from "./secrets-get.js";
import { operationSpaceResolver } from "../secrets.js";
import { createAuthRuntimeFixture, persistRuntimeDelegations } from "../../test-support/auth-runtime.js";
import type { RuntimeOperationContext } from "../contract.js";

const OWNER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NETWORK_ID = `urn:tinycloud:encryption:did:pkh:eip155:1:${OWNER_ADDRESS}:default`;
const OWNER_SECRETS_SPACE = `tinycloud:pkh:eip155:1:${OWNER_ADDRESS.toLowerCase()}:secrets`;

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
      home = await mkdtemp(`${tmpdir()}/tinycloud-exact-key-delegate-`);
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

isolated("(a) delegate with exact-key-only decrypt reads a v2 secret without bare-network decrypt", async () => {
  const fixture = await createAuthRuntimeFixture();
  const kv = fixture.hermetic.permissions.find((p) => p.service === "tinycloud.kv")!;
  const bareDecrypt = fixture.hermetic.permissions.find((p) => p.service === "tinycloud.encryption")!;
  const exactKeyPath = `${bareDecrypt.path}/secrets/hermetic_delegation_canary`;

  // Give the delegate ONLY kv/get on the secret + decrypt on that secret's exact key (no bare network).
  const exactOnlyGrant = await fixture.hermetic.mintDelegationWithPermissions([kv]);
  await persistRuntimeDelegations(fixture, [exactOnlyGrant]);

  const exactKeyEntry: PermissionEntry = {
    service: "tinycloud.encryption",
    path: exactKeyPath,
    actions: ["tinycloud.encryption/decrypt"],
  };
  const verifiedCaps = spyOn(TinyCloudNode.prototype, "getVerifiedSessionCapabilities")
    .mockReturnValue([exactKeyEntry]);
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret")
    .mockResolvedValue({ status: "ok", value: "exact-key-v2-plaintext" });

  try {
    const read = await invokeOperation(
      "tinycloud.secrets.get",
      1,
      { profile: fixture.profile },
      { name: "HERMETIC_DELEGATION_CANARY" },
    );
    expect(read).toMatchObject({ status: "ok", output: { value: "exact-key-v2-plaintext" } });
    expect(readSecret).toHaveBeenCalledTimes(1);

    // tinycloud.auth.request also sees the exact-key-only grant as complete.
    const requestCheck = await invokeOperation(
      "tinycloud.auth.request",
      1,
      { profile: fixture.profile },
      {
        operationId: "tinycloud.secrets.get",
        operationVersion: 1,
        input: { name: "HERMETIC_DELEGATION_CANARY" },
      },
    );
    expect(requestCheck).toMatchObject({ status: "ok", output: { missing: [] } });
  } finally {
    verifiedCaps.mockRestore();
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

isolated("(b) delegate with exact-key for secret A cannot read secret B, and prefixes/caveats/non-canonical keys are refused", async () => {
  const fixture = await createAuthRuntimeFixture();
  const kv = fixture.hermetic.permissions.find((p) => p.service === "tinycloud.kv")!;
  const bareDecrypt = fixture.hermetic.permissions.find((p) => p.service === "tinycloud.encryption")!;

  const kvGrant = await fixture.hermetic.mintDelegationWithPermissions([kv]);
  await persistRuntimeDelegations(fixture, [kvGrant]);

  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  const verifiedCaps = spyOn(TinyCloudNode.prototype, "getVerifiedSessionCapabilities");

  const nonMatchingGrants: PermissionEntry[] = [
    // Exact key for a different secret (secret A when reading HERMETIC_DELEGATION_CANARY).
    { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets/secret_a`, actions: ["tinycloud.encryption/decrypt"] },
    // Scoped key for the same name when reading unscoped.
    { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets/scoped/app/hermetic_delegation_canary`, actions: ["tinycloud.encryption/decrypt"] },
    // Prefix under secrets/ (must not satisfy exact-key preflight).
    { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets/`, actions: ["tinycloud.encryption/decrypt"] },
    // Wildcard action on this secret's key.
    { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets/hermetic_delegation_canary`, actions: ["tinycloud.encryption/*"] },
    // Non-decrypt action on this secret's key.
    { service: "tinycloud.encryption", path: `${bareDecrypt.path}/secrets/hermetic_delegation_canary`, actions: ["tinycloud.encryption/key.create"] },
    // Non-canonical (lowercased) EIP-55 owner on this secret's key.
    { service: "tinycloud.encryption", path: `${bareDecrypt.path.toLowerCase()}/secrets/hermetic_delegation_canary`, actions: ["tinycloud.encryption/decrypt"] },
    // Caveated grant on this secret's key.
    {
      service: "tinycloud.encryption",
      path: `${bareDecrypt.path}/secrets/hermetic_delegation_canary`,
      actions: ["tinycloud.encryption/decrypt"],
      caveats: [{ tenant: "other" }],
    },
  ];

  try {
    for (const grant of nonMatchingGrants) {
      verifiedCaps.mockReturnValue([grant]);
      const result = await invokeOperation(
        "tinycloud.secrets.get",
        1,
        { profile: fixture.profile },
        { name: "HERMETIC_DELEGATION_CANARY" },
      );
      expect(result.status).toBe("authority_required");
      expect(readSecret).not.toHaveBeenCalled();
    }
  } finally {
    verifiedCaps.mockRestore();
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

isolated("(c) delegate with bare-network-only decrypt on a v2 envelope receives the clear exact-key refusal", async () => {
  const fixture = await createAuthRuntimeFixture();
  const full = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [full]);
  const bareDecrypt = fixture.hermetic.permissions.find((p) => p.service === "tinycloud.encryption")!;
  const exactKeyHint: PermissionEntry = {
    service: "tinycloud.encryption",
    path: `${bareDecrypt.path}/secrets/hermetic_delegation_canary`,
    actions: ["tinycloud.encryption/decrypt"],
  };
  // Node 1.26.21 refuses bare-network decrypt for a v2 envelope and DataVaultService surfaces the exact key hint.
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret")
    .mockResolvedValue({ status: "permission_required", hint: exactKeyHint } as never);

  try {
    const result = await invokeOperation(
      "tinycloud.secrets.get",
      1,
      { profile: fixture.profile },
      { name: "HERMETIC_DELEGATION_CANARY" },
    );
    expect(result.status).toBe("authority_required");
    if (result.status !== "authority_required") throw new Error("expected authority_required");
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(result.missing as unknown).toEqual([exactKeyHint]);
    expect(result.request.requested as unknown).toEqual([exactKeyHint]);
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

test("scoped exact-key-only preflight accepts this scoped secret's exact key and rejects other scopes or missing kv/get", async () => {
  const runtimeCtx = {
    summary: {
      profile: "delegate",
      host: "https://node.tinycloud.test",
      posture: "delegate-session",
      sessionDid: "did:key:session",
      space: OWNER_SECRETS_SPACE,
    },
    runtime: {
      node: {
        getEncryptionNetworkIdForSpace: () => NETWORK_ID.toLowerCase(),
      },
      granted: [],
    },
  } as unknown as RuntimeOperationContext;

  const input = secretsGetOperationDefinition.input.parse({
    name: "API_KEY",
    scope: "Food Tracker",
    space: OWNER_SECRETS_SPACE,
  });
  const required = await secretsGetOperationDefinition.authority(runtimeCtx, input) as unknown as PermissionEntry[];
  const alternatives = await secretsGetOperationDefinition.authorityAlternatives!(runtimeCtx, input) as unknown as Array<{
    replaces: PermissionEntry;
    satisfiedBy: PermissionEntry;
  }>;
  const resolveSpace = operationSpaceResolver(runtimeCtx.runtime.node, OWNER_SECRETS_SPACE);

  const kvGet: PermissionEntry = {
    service: "tinycloud.kv",
    space: OWNER_SECRETS_SPACE,
    path: "vault/secrets/scoped/food-tracker/API_KEY",
    actions: ["tinycloud.kv/get"],
  };
  const exactScopedKey: PermissionEntry = {
    service: "tinycloud.encryption",
    space: "encryption",
    path: `${NETWORK_ID}/secrets/scoped/food-tracker/api_key`,
    actions: ["tinycloud.encryption/decrypt"],
  };

  // Exact scoped key + kv/get satisfies preflight without bare network.
  expect(evaluateOperationAuthority([kvGet, exactScopedKey], required, resolveSpace, alternatives)).toEqual({
    satisfied: true,
    missing: [],
  });

  // Missing kv/get is still refused even with the exact scoped key.
  const missingKv = evaluateOperationAuthority([exactScopedKey], required, resolveSpace, alternatives);
  expect(missingKv.satisfied).toBe(false);
  expect(missingKv.missing.map((p) => p.service)).toEqual(["tinycloud.kv"]);

  // Wrong scope key or scoped prefix does not satisfy preflight.
  const wrongScopeKey: PermissionEntry = {
    ...exactScopedKey,
    path: `${NETWORK_ID}/secrets/scoped/other-scope/api_key`,
  };
  const scopedPrefix: PermissionEntry = {
    ...exactScopedKey,
    path: `${NETWORK_ID}/secrets/scoped/food-tracker/`,
  };
  expect(evaluateOperationAuthority([kvGet, wrongScopeKey], required, resolveSpace, alternatives).satisfied).toBe(false);
  expect(evaluateOperationAuthority([kvGet, scopedPrefix], required, resolveSpace, alternatives).satisfied).toBe(false);
});
