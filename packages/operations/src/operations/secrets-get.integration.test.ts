import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
import { signLocationRecordV2, type PermissionEntry } from "@tinycloud/sdk-core";

import { invokeOperation } from "../invoke.js";
import { listPermissionRequests } from "../artifacts.js";
import { createAuthRuntimeFixture, persistRuntimeDelegations } from "../../test-support/auth-runtime.js";
import { additionalDelegationsPath, profileConfigPath, sessionPath, writeJsonAtomic } from "../state.js";

let isolatedTestTail = Promise.resolve();

function isolatedTest(name: string, body: () => Promise<unknown>): void {
  test(name, async () => {
    const predecessor = isolatedTestTail;
    let release!: () => void;
    isolatedTestTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;

    const previousTcHome = process.env.TC_HOME;
    let home: string | undefined;
    try {
      home = await mkdtemp(`${tmpdir()}/tinycloud-secrets-i3-`);
      process.env.TC_HOME = home;
      return await body();
    } finally {
      try {
        if (previousTcHome === undefined) delete process.env.TC_HOME;
        else process.env.TC_HOME = previousTcHome;
        if (home !== undefined) await rm(home, { recursive: true, force: true });
      } finally {
        release();
      }
    }
  });
}

isolatedTest("stored valid authority survives identity, registry and node outages without requesting new consent or falling back", async () => {
  const fixture = await createAuthRuntimeFixture({ secretPayloadValue: "tc2481-private-dummy" });
  const previousRegistry = process.env.TC_REGISTRY_URL;
  delete process.env.TC_REGISTRY_URL;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  let registry: ReturnType<typeof Bun.serve> | undefined;
  let matchingIdentity = true;
  let rejectRegistration = false;
  try {
    const wasm = new NodeWasmBindings();
    const signer = new PrivateKeySigner(fixture.hermetic.ownerPrivateKey);
    const address = await signer.getAddress();
    const chainId = await signer.getChainId();
    const manager = wasm.createSessionManager();
    const jwk = JSON.parse(manager.jwk("default")!);
    const spaceId = fixture.hermetic.ownerRestorableSession.spaceId;
    const prepared = wasm.prepareSession({
      address, chainId, domain: "tc2481-replay.fixture.invalid", spaceId, jwk, abilities: {},
      issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const signature = await signer.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    const sessionDid = session.verificationMethod.split("#", 1)[0]!;
    const grant = await fixture.hermetic.mintDelegationForAudience(sessionDid);
    const { nodeId: nodeDid } = await (await fetch(`${fixture.hermetic.host}/info`)).json() as { nodeId: string };
    proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/tinycloud/node-keys") {
        return Response.json({ nodeDid: matchingIdentity ? nodeDid : fixture.hermetic.unrelatedAudience, shareInvitationPublicKey: "A".repeat(43) });
      }
      if (rejectRegistration && url.pathname === "/delegate") {
        return new Response("registry_unavailable: fixture registry refused", { status: 503 });
      }
      return fetch(new Request(`${fixture.hermetic.host}${url.pathname}${url.search}`, request));
    } });
    const record = await signLocationRecordV2({
      version: 2, subject: fixture.hermetic.ownerDid, nodes: [{ did: nodeDid, url: proxy.url.origin }],
      spaces: [{ space: spaceId, nodes: [{ did: nodeDid, mode: "read-write" }] }],
      encryptionNode: nodeDid, updated_at: new Date().toISOString(), sequence: 0,
    }, { type: "did:pkh", signMessage: (message) => signer.signMessage(message) });
    registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ record }) });
    await writeJsonAtomic(profileConfigPath(fixture.ownerProfile), {
      name: fixture.ownerProfile, host: fixture.hermetic.host, tinycloudRegistryUrl: registry.url.origin,
      chainId, spaceName: "default", spaceId, did: fixture.hermetic.ownerDid, sessionDid,
      posture: "local-owner-key", operatorType: "human", authMethod: "local", privateKey: fixture.hermetic.ownerPrivateKey,
      address, createdAt: new Date().toISOString(),
    });
    await writeJsonAtomic(sessionPath(fixture.ownerProfile), {
      delegationHeader: session.delegationHeader, delegationCid: session.delegationCid,
      spaceId, jwk, verificationMethod: session.verificationMethod, address, chainId,
      siwe: prepared.siwe, signature, tinycloudHosts: [fixture.hermetic.host],
      expiresAt: prepared.siwe.match(/^Expiration Time: (.+)$/m)![1],
    });
    await writeJsonAtomic(additionalDelegationsPath(fixture.ownerProfile), [{
      delegation: grant,
      authorityRequest: { requestId: "req_tc2481_original_authority", requested: fixture.hermetic.permissions },
    }]);
    const invoke = () => invokeOperation("tinycloud.secrets.get", 1, {
      profile: fixture.ownerProfile, allowOwnerProfile: true,
    }, { name: "HERMETIC_DELEGATION_CANARY" });
    expect(await invoke()).toMatchObject({ status: "ok", output: { value: "tc2481-private-dummy" } });

    matchingIdentity = false;
    expect(await invoke()).toMatchObject({ status: "error", error: { code: "NODE_IDENTITY_MISMATCH", retryable: false } });
    matchingIdentity = true;
    rejectRegistration = true;
    expect(await invoke()).toMatchObject({ status: "error", error: { code: "REGISTRY_UNAVAILABLE", retryable: true } });
    rejectRegistration = false;
    proxy.stop(true);
    expect(await invoke()).toMatchObject({ status: "error", error: { code: "NODE_NOT_RESPONDING", retryable: true } });
    expect(await listPermissionRequests(fixture.ownerProfile)).toEqual([]);
  } finally {
    registry?.stop(true);
    proxy?.stop(true);
    fixture.hermetic.stop();
    if (previousRegistry === undefined) delete process.env.TC_REGISTRY_URL;
    else process.env.TC_REGISTRY_URL = previousRegistry;
  }
});

isolatedTest("registered secret invocation preflights the exact KV/encryption union", async () => {
  const fixture = await createAuthRuntimeFixture();
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  try {
    const missing = await invokeSecret(fixture.profile);
    expect(missing.status).toBe("authority_required");
    if (missing.status !== "authority_required") throw new Error("expected authority");
    expect(missing.missing).toHaveLength(2);
    expect(missing.missing.map((permission) => permission.service).sort()).toEqual([
      "tinycloud.kv",
      "tinycloud.encryption",
    ].sort());
    const requested = missing.request.requested as readonly {
      readonly service?: unknown;
      readonly space?: unknown;
    }[];
    expect(requested).toEqual(missing.missing);
    expect(requested.some((permission) =>
      permission.service === "tinycloud.kv" &&
      permission.space === missing.context.space?.toLowerCase(),
    )).toBe(true);
    expect(readSecret).not.toHaveBeenCalled();
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

isolatedTest("registered authority accepts only the exact KV/encryption union", async () => {
  const fixture = await createAuthRuntimeFixture();
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  try {
    const kvOnly = await fixture.hermetic.mintDelegationWithPermissions(
      fixture.hermetic.permissions.filter((permission) => permission.service === "tinycloud.kv") as PermissionEntry[],
    );
    await persistRuntimeDelegations(fixture, [kvOnly]);
    const missingDecrypt = await invokeSecret(fixture.profile);
    expect(missingDecrypt.status).toBe("authority_required");
    if (missingDecrypt.status !== "authority_required") throw new Error("expected authority");
    expect(missingDecrypt.missing.map((permission) => permission.service)).toEqual([
      "tinycloud.encryption",
    ]);

    const decryptOnly = await fixture.hermetic.mintDelegationWithPermissions(
      fixture.hermetic.permissions.filter((permission) => permission.service === "tinycloud.encryption") as PermissionEntry[],
    );
    await persistRuntimeDelegations(fixture, [decryptOnly]);
    const missingKv = await invokeSecret(fixture.profile);
    expect(missingKv.status).toBe("authority_required");
    if (missingKv.status !== "authority_required") throw new Error("expected authority");
    expect(missingKv.missing.map((permission) => permission.service)).toEqual([
      "tinycloud.kv",
    ]);

    const full = await fixture.hermetic.mintDelegation();
    await persistRuntimeDelegations(fixture, [full]);
    readSecret.mockResolvedValue({
      status: "ok",
      value: "hermetic encrypted delegation proof",
    });
    const result = await invokeSecret(fixture.profile);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected success");
    expect(result.output).toEqual({ value: "hermetic encrypted delegation proof" });
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

isolatedTest("registered planning is owner-exact for full and explicit short spaces", async () => {
  const fixture = await createAuthRuntimeFixture();
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  try {
    const full = await fixture.hermetic.mintDelegation();
    await persistRuntimeDelegations(fixture, [full]);

    const ownerB = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000003:secrets";
    const crossOwner = await invokeSecret(fixture.profile, { space: ownerB });
    expect(crossOwner.status).toBe("authority_required");
    if (crossOwner.status !== "authority_required") throw new Error("expected authority");
    expect(crossOwner.missing).toContainEqual(expect.objectContaining({
      service: "tinycloud.kv",
      space: ownerB,
    }));
    expect(crossOwner.request.requested).toEqual(crossOwner.missing);

    readSecret.mockResolvedValue({ status: "ok", value: "short-space-proof" });
    const crossOwnerShort = await invokeSecret(fixture.profile, { space: "other" });
    expect(crossOwnerShort.status).toBe("authority_required");
    if (crossOwnerShort.status !== "authority_required") throw new Error("expected authority");
    expect(crossOwnerShort.missing).toContainEqual(expect.objectContaining({
      service: "tinycloud.kv",
      space: `${missingOwnerSpace(fixture)}:other`,
    }));

    const explicitShort = await invokeSecret(fixture.profile, { space: "secrets" });
    expect(explicitShort.status).toBe("ok");
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

isolatedTest("registered secret execution preserves classified node failures and thrown reads", async () => {
  const fixture = await createAuthRuntimeFixture();
  const full = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [full]);
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  try {
    for (const [status, code] of [
      ["node_unreachable", "NODE_NOT_RESPONDING"],
      ["read_failed", "SECRET_READ_FAILED"],
      ["corrupt_envelope", "SECRET_READ_FAILED"],
      ["decrypt_failed", "SECRET_DECRYPT_FAILED"],
      ["invalid_payload", "SECRET_DECRYPT_FAILED"],
    ] as const) {
      readSecret.mockResolvedValue({ status } as never);
      const result = await invokeSecret(fixture.profile);
      expect(result.status).toBe("error");
      if (result.status !== "error") throw new Error("expected error");
      expect(result.error.code).toBe(code);
    }

    readSecret.mockResolvedValue({ status: "not_found" } as never);
    const absent = await invokeSecret(fixture.profile);
    expect(absent.status).toBe("setup_required");
    if (absent.status !== "setup_required") throw new Error("expected setup");
    expect(absent.setup.url).toContain("HERMETIC_DELEGATION_CANARY");

    readSecret.mockImplementation(async () => {
      throw Object.assign(new Error("private node detail"), { code: "NODE_NOT_RESPONDING" });
    });
    const notResponding = await invokeSecret(fixture.profile);
    expect(notResponding).toMatchObject({
      status: "error",
      error: { code: "NODE_NOT_RESPONDING", retryable: true },
    });
    expect(JSON.stringify(notResponding)).not.toContain("private node detail");

    readSecret.mockImplementation(async () => {
      throw new Error("private node detail");
    });
    const thrown = await invokeSecret(fixture.profile);
    expect(thrown).toMatchObject({ status: "error", error: { code: "NODE_ERROR" } });
    expect(JSON.stringify(thrown)).not.toContain("private node detail");
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

isolatedTest("registered runtime hints persist only the exact planned phase", async () => {
  const fixture = await createAuthRuntimeFixture();
  const full = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [full]);
  const kv = fixture.hermetic.permissions.find((permission) => permission.service === "tinycloud.kv");
  const decrypt = fixture.hermetic.permissions.find((permission) => permission.service === "tinycloud.encryption");
  if (kv === undefined || decrypt === undefined) throw new Error("expected hermetic plan");
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  try {
    readSecret.mockResolvedValue({ status: "permission_required", hint: kv } as never);
    const kvHint = await invokeSecret(fixture.profile);
    expect(kvHint.status).toBe("authority_required");
    if (kvHint.status !== "authority_required") throw new Error("expected KV authority");
    const kvRequested = kvHint.request.requested as readonly Readonly<Record<string, unknown>>[];
    expect(kvHint.missing).toEqual(kvRequested);
    expect(kvHint.missing).toHaveLength(1);
    expect(kvHint.missing[0]).toMatchObject({
      service: "tinycloud.kv",
      path: kv.path,
      actions: kv.actions,
    });
    const kvSpace = kvHint.missing[0]?.space;
    expect(typeof kvSpace === "string" ? kvSpace.toLowerCase() : kvSpace)
      .toBe(typeof kv.space === "string" ? kv.space.toLowerCase() : kv.space);

    readSecret.mockResolvedValue({ status: "permission_required", hint: decrypt } as never);
    const decryptHint = await invokeSecret(fixture.profile, { name: "HERMETIC_DELEGATION_CANARY" });
    expect(decryptHint.status).toBe("authority_required");
    if (decryptHint.status !== "authority_required") throw new Error("expected decrypt authority");
    const decryptRequested = decryptHint.request.requested as readonly Readonly<Record<string, unknown>>[];
    expect(decryptHint.missing).toEqual(decryptRequested);
    expect(decryptHint.missing).toHaveLength(1);
    expect(decryptHint.missing[0]).toMatchObject({
      service: decrypt.service,
      actions: decrypt.actions,
    });
    const decryptPath = decryptHint.missing[0]?.path;
    expect(typeof decryptPath === "string" ? decryptPath.toLowerCase() : decryptPath)
      .toBe(typeof decrypt.path === "string" ? decrypt.path.toLowerCase() : decrypt.path);

    const requests = await listPermissionRequests(fixture.profile);
    expect(requests.map((request) => request.requested)).toEqual([
      Array.from(kvRequested),
      Array.from(decryptRequested),
    ] as never);
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

isolatedTest("registered runtime rejects wrong-owner, broad, and unknown hints without persisting", async () => {
  const fixture = await createAuthRuntimeFixture();
  const full = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [full]);
  const kv = fixture.hermetic.permissions.find((permission) => permission.service === "tinycloud.kv");
  if (kv === undefined) throw new Error("expected hermetic KV plan");
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  try {
    const invalidHints = [
      { ...kv, space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000009:secrets" },
      { ...kv, path: "vault/secrets/*" },
      { ...kv, actions: ["tinycloud.kv/*"] },
      { ...kv, service: "tinycloud.unknown" },
      { ...kv, caveats: [{ tenant: "wrong" }] },
      [],
    ];
    for (const hint of invalidHints) {
      readSecret.mockResolvedValue({ status: "permission_required", hint } as never);
      const result = await invokeSecret(fixture.profile);
      expect(result).toMatchObject({ status: "error", error: { code: "PERMISSION_HINT_INVALID" } });
    }
    expect(await listPermissionRequests(fixture.profile)).toEqual([]);
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

isolatedTest("registered runtime owner retry reads once and retries exactly once after a classified hint", async () => {
  const fixture = await createAuthRuntimeFixture();
  const full = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [full]);
  const kv = fixture.hermetic.permissions.find((permission) => permission.service === "tinycloud.kv");
  if (kv === undefined) throw new Error("expected hermetic KV plan");
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  let attempts = 0;
  readSecret.mockImplementation(async () => {
    attempts += 1;
    return attempts === 1
      ? { status: "permission_required", hint: kv } as never
      : { status: "ok", value: "owner-retry-proof" };
  });
  try {
    const first = await invokeSecret(fixture.profile);
    expect(first.status).toBe("authority_required");
    if (first.status !== "authority_required") throw new Error("expected first authority result");
    expect(first.request.requested).toEqual(first.missing);
    expect(readSecret).toHaveBeenCalledTimes(1);

    const second = await invokeSecret(fixture.profile);
    expect(second).toMatchObject({ status: "ok", output: { value: "owner-retry-proof" } });
    expect(readSecret).toHaveBeenCalledTimes(2);
    expect((await listPermissionRequests(fixture.profile)).map((request) => request.requested))
      .toEqual([first.request.requested] as never);
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

async function invokeSecret(
  profile: string,
  input: Readonly<{ space?: string; name?: string }> = {},
) {
  return invokeOperation(
    "tinycloud.secrets.get",
    1,
    { profile },
    { name: "HERMETIC_DELEGATION_CANARY", ...input },
  );
}

function missingOwnerSpace(fixture: { hermetic: { permissions: readonly PermissionEntry[] } }): string {
  const permission = fixture.hermetic.permissions.find((entry) => entry.service === "tinycloud.kv");
  if (permission?.space === undefined) throw new Error("expected hermetic KV space");
  return permission.space.toLowerCase().replace(/:secrets$/, "");
}
