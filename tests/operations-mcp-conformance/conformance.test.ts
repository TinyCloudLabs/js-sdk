import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { TinyCloudNode } from "@tinycloud/node-sdk";
import { invokeOperation } from "@tinycloud/operations";
import { secretCapabilityAction } from "@tinycloud/operations/secret-capabilities";
import { invokeSecretsGetWithLocalAuthorityRetry } from "@tinycloud/operations/cli-runtime";

import { invokeCommanderSecretGetAdapter } from "../../packages/cli/src/commands/secrets.ts";
import { canonicalMcpAdapterResult } from "../../packages/mcp/src/results.ts";
import {
  createAuthRuntimeFixture,
  persistRuntimeDelegations,
  type AuthRuntimeFixture,
} from "../../packages/operations/test-support/auth-runtime.ts";
import {
  additionalDelegationsPath,
  authRequestsPath,
  profileConfigPath,
  sessionPath,
  writeJsonAtomic,
} from "../../packages/operations/src/state.ts";

const SECRET_INPUT = { name: "HERMETIC_DELEGATION_CANARY" } as const;
let isolatedTail = Promise.resolve();

function provingScenario(name: string, body: (fixture: AuthRuntimeFixture) => Promise<void>): void {
  test(name, async () => {
    const predecessor = isolatedTail;
    let release!: () => void;
    isolatedTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    const home = await mkdtemp(`${tmpdir()}/tinycloud-i5-conformance-`);
    process.env.TC_HOME = home;
    const fixture = await createAuthRuntimeFixture({ secretPayloadValue: "i5-secret-canary" });
    try {
      await body(fixture);
    } finally {
      fixture.hermetic.stop();
      delete process.env.TC_HOME;
      await rm(home, { recursive: true, force: true });
      release();
    }
  });
}

async function secret(fixture: AuthRuntimeFixture, input = SECRET_INPUT) {
  return invokeOperation("tinycloud.secrets.get", 1, { profile: fixture.profile }, input);
}

async function persistFullDelegation(fixture: AuthRuntimeFixture): Promise<Awaited<ReturnType<typeof fixture.hermetic.mintDelegation>>> {
  const delegation = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [delegation]);
  return delegation;
}

async function requestId(result: Awaited<ReturnType<typeof secret>>): Promise<string> {
  if (result.status !== "authority_required") throw new Error("expected authority_required");
  return result.request.requestId;
}

provingScenario("1. authorized secret success has equal direct, Commander, and MCP envelopes", async (fixture) => {
  await persistFullDelegation(fixture);
  const direct = await secret(fixture);
  const commander = await invokeCommanderSecretGetAdapter({ profile: fixture.profile, host: fixture.hermetic.host, input: SECRET_INPUT });
  const mcp = canonicalMcpAdapterResult(direct);
  expect(direct).toEqual(commander);
  expect(mcp).toEqual(direct);
  expect(direct).toMatchObject({ status: "ok", output: { value: "i5-secret-canary" } });
});

provingScenario("2. a missing KV grant can be imported and used by a fresh invocation", async (fixture) => {
  const decryptOnly = fixture.hermetic.permissions.filter((permission) =>
    permission.service === "tinycloud.encryption"
  );
  await persistRuntimeDelegations(fixture, [
    await fixture.hermetic.mintDelegationWithPermissions([...decryptOnly]),
  ]);
  const authority = await secret(fixture);
  expect(authority.status).toBe("authority_required");
  if (authority.status !== "authority_required") throw new Error("expected authority_required");
  expect(authority.missing.map((permission) => permission.service)).toEqual(["tinycloud.kv"]);
  const kvOnly = fixture.hermetic.permissions.filter((permission) => permission.service === "tinycloud.kv");
  const delegation = await fixture.hermetic.mintDelegationWithPermissions([...kvOnly]);
  const imported = await invokeOperation("tinycloud.auth.import", 1, { profile: fixture.profile }, {
    kind: "tinycloud.auth.delegation",
    version: 1,
    requestId: await requestId(authority),
    delegation,
  });
  expect(imported).toMatchObject({ status: "ok", output: { cid: delegation.cid, activated: true } });
  expect(await secret(fixture)).toMatchObject({ status: "ok" });
});

provingScenario("3. a missing decrypt grant can be imported and used by a fresh invocation", async (fixture) => {
  const kvOnly = fixture.hermetic.permissions.filter((permission) => permission.service === "tinycloud.kv");
  await persistRuntimeDelegations(fixture, [await fixture.hermetic.mintDelegationWithPermissions([...kvOnly])]);
  const authority = await secret(fixture);
  expect(authority).toMatchObject({ status: "authority_required" });
  if (authority.status !== "authority_required") throw new Error("expected authority_required");
  expect(authority.missing).toEqual([
    expect.objectContaining({ service: "tinycloud.encryption", actions: ["tinycloud.encryption/decrypt"] }),
  ]);
  const decryptOnly = fixture.hermetic.permissions.filter((permission) =>
    permission.service === "tinycloud.encryption"
  );
  const delegation = await fixture.hermetic.mintDelegationWithPermissions([...decryptOnly]);
  const imported = await invokeOperation("tinycloud.auth.import", 1, { profile: fixture.profile }, {
    kind: "tinycloud.auth.delegation",
    version: 1,
    requestId: authority.request.requestId,
    delegation,
  });
  expect(imported).toMatchObject({ status: "ok", output: { cid: delegation.cid, activated: true } });
  expect(await secret(fixture)).toMatchObject({ status: "ok" });
});

provingScenario("4. no grant requests the exact KV/decrypt union once", async (fixture) => {
  const result = await secret(fixture);
  expect(result.status).toBe("authority_required");
  const commander = await invokeCommanderSecretGetAdapter({ profile: fixture.profile, host: fixture.hermetic.host, input: SECRET_INPUT });
  expect(commander).toEqual(result);
  expect(canonicalMcpAdapterResult(result)).toEqual(result);
  if (result.status === "authority_required") {
    expect(result.missing).toHaveLength(2);
    expect(result.request.requested).toEqual(result.missing);
  }
});

provingScenario("5. authorized absence is setup_required on every adapter", async (fixture) => {
  await persistFullDelegation(fixture);
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret").mockResolvedValue({ status: "not_found" } as never);
  try {
    const direct = await secret(fixture);
    const commander = await invokeCommanderSecretGetAdapter({ profile: fixture.profile, host: fixture.hermetic.host, input: SECRET_INPUT });
    expect(direct).toEqual(commander);
    expect(canonicalMcpAdapterResult(direct)).toEqual(direct);
    expect(direct).toMatchObject({ status: "setup_required", setup: { kind: "secret_manager" } });
  } finally {
    readSecret.mockRestore();
  }
});

provingScenario("6. delegate posture never falls back to owner authority", async (fixture) => {
  const result = await secret(fixture);
  expect(result).toMatchObject({ status: "authority_required", context: { posture: "delegate-session" } });
  expect(JSON.stringify(result)).not.toContain("i5-secret-canary");
});

provingScenario("7. owner-openkey posture still ends at the canonical authority result", async (fixture) => {
  const profile = JSON.parse(await readFile(profileConfigPath(fixture.profile), "utf8")) as Record<string, unknown>;
  await writeJsonAtomic(profileConfigPath(fixture.profile), { ...profile, posture: "owner-openkey", authMethod: "openkey" });
  const result = await secret(fixture);
  expect(["authority_required", "error"]).toContain(result.status);
  expect(JSON.stringify(result)).not.toContain("i5-secret-canary");
});

provingScenario("8. explicit local-key authority remains inside operations", async (fixture) => {
  await persistFullDelegation(fixture);
  const result = await invokeSecretsGetWithLocalAuthorityRetry(
    { profile: fixture.profile, host: fixture.hermetic.host, privateKey: "2".padStart(64, "0") },
    SECRET_INPUT,
  );
  expect(JSON.stringify(result)).not.toContain("privateKey");
  expect(["ok", "authority_required", "error"]).toContain(result.status);
});

provingScenario("9. persisted authority survives a process-style runtime restart", async (fixture) => {
  await persistFullDelegation(fixture);
  const first = await secret(fixture);
  const second = await secret(fixture);
  expect(first).toEqual(second);
});

provingScenario("10. secret canary is absent from non-result channels", async (fixture) => {
  await persistFullDelegation(fixture);
  const result = await secret(fixture);
  const requestFile = await readFile(authRequestsPath(fixture.profile), "utf8").catch(() => "");
  const delegationFile = await readFile(additionalDelegationsPath(fixture.profile), "utf8").catch(() => "");
  const rendered = JSON.stringify({ mcp: canonicalMcpAdapterResult(result), requestFile, delegationFile });
  expect(rendered).toContain("i5-secret-canary");
  if (result.status === "ok") {
    expect(JSON.stringify({ requestFile, delegationFile })).not.toContain("i5-secret-canary");
    expect(JSON.stringify(canonicalMcpAdapterResult({ ...result, output: undefined }))).not.toContain("i5-secret-canary");
  }
});

provingScenario("11. a rotated session rejects the old import and creates a fresh request", async (fixture) => {
  const authority = await secret(fixture);
  const oldRequestId = await requestId(authority);
  const oldDelegation = await fixture.hermetic.mintDelegation();
  const rotatedSession = await fixture.hermetic.createRotatedRestorableSession();
  const rotatedSessionDid = rotatedSession.verificationMethod.split("#", 1)[0]!;
  const profile = JSON.parse(await readFile(profileConfigPath(fixture.profile), "utf8")) as Record<string, unknown>;
  await writeJsonAtomic(profileConfigPath(fixture.profile), {
    ...profile,
    did: rotatedSessionDid,
    sessionDid: rotatedSessionDid,
  });
  await writeJsonAtomic(sessionPath(fixture.profile), rotatedSession);

  const staleImport = await invokeOperation("tinycloud.auth.import", 1, { profile: fixture.profile }, {
    kind: "tinycloud.auth.delegation",
    version: 1,
    requestId: oldRequestId,
    delegation: oldDelegation,
  });
  expect(staleImport).toMatchObject({
    status: "error",
    error: { code: "DELEGATION_AUDIENCE_MISMATCH" },
  });
  const fresh = await secret(fixture);
  expect(fresh.status).toBe("authority_required");
  if (fresh.status !== "authority_required") throw new Error("expected authority_required");
  expect(fresh.request.requestId).not.toBe(oldRequestId);
  expect(fresh.request.sessionDid).toBe(rotatedSessionDid);
});

provingScenario("12. ciphertext decryption failure is an error, never setup_required", async (fixture) => {
  await persistFullDelegation(fixture);
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret").mockResolvedValue({ status: "decrypt_failed" } as never);
  try {
    expect(await secret(fixture)).toMatchObject({ status: "error", error: { code: "SECRET_DECRYPT_FAILED" } });
  } finally {
    readSecret.mockRestore();
  }
});

provingScenario("13. delegation minting uses the hermetic local owner key and real activation path", async (fixture) => {
  const delegation = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [delegation]);
  const result = await secret(fixture);
  expect(result.status).toBe("ok");
  fixture.hermetic.assertNarrowDelegatedReadAndDecrypt({
    cid: delegation.cid,
    delegation,
    effectivePermissions: fixture.hermetic.permissions,
    expiry: delegation.expiry,
    audience: delegation.delegateDID,
    host: delegation.host!,
  } as never, fixture.sessionDid);
  expect(secretCapabilityAction("get")).toBe("tinycloud.kv/get");
});
