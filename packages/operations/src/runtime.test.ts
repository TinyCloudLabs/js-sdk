import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import type { PermissionEntry } from "@tinycloud/sdk-core";

import { canonicalizeCapabilities, evaluateAuthority } from "./authority.js";
import type { OperationDefinition, RuntimeOperationContext } from "./contract.js";
import { BINDING_NOTES, bindingMigrationPath } from "./delegation-binding.js";
import { createInvocationRuntime } from "./runtime.js";
import {
  additionalDelegationsPath,
  profileConfigPath,
  readAdditionalDelegations,
  readJson,
  sessionPath,
  upsertProfileRecord,
  withProfileLock,
  writeJsonAtomic,
} from "./state.js";
import { authOperationDefinitions } from "./operations/auth.js";
import {
  createAuthRuntimeFixture,
  persistRuntimeDelegations,
  type AuthRuntimeFixture,
  type StoredRuntimeDelegation,
} from "../test-support/auth-runtime.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(`${tmpdir()}/tinycloud-operations-runtime-`);
  process.env.TC_HOME = home;
});

afterEach(async () => {
  delete process.env.TC_HOME;
  await rm(home, { recursive: true, force: true });
});

test("restores the persisted session DID and rereads a real live delegation for every invocation", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const first = await createInvocationRuntime({ profile: fixture.profile });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected a runtime");
    expect(first.context.summary).toMatchObject({
      profile: fixture.profile,
      sessionDid: fixture.sessionDid,
      posture: "delegate-session",
    });
    expect(first.context.runtime.granted).toEqual([]);

    const delegation = await fixture.hermetic.mintDelegation();
    await persistRuntimeDelegations(fixture, [delegation]);

    const second = await createInvocationRuntime({ profile: fixture.profile });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected a runtime");
    expect(second.context.summary.sessionDid).toBe(fixture.sessionDid);
    expect(second.context.runtime.granted).toEqual(
      canonicalizeCapabilities(fixture.hermetic.permissions),
    );

    const node = second.context.runtime.node as RuntimeNode;
    const installed = node.getRuntimePermissionDelegations();
    expect(installed).toHaveLength(1);
    expect(installed[0]?.cid).toBe(delegation.cid);
    await fixture.hermetic.readAndDecrypt(node, validatedDelegation(
      installed[0]!,
      second.context.runtime.granted,
    ));
    fixture.hermetic.assertNarrowDelegatedReadAndDecrypt(
      validatedDelegation(installed[0]!, second.context.runtime.granted),
      node.sessionDid,
    );
  } finally {
    fixture.hermetic.stop();
  }
});

test("includes cryptographically restored base-session ReCap authority in runtime grants", async () => {
  const fixture = await createAuthRuntimeFixture({ delegateBasePermissions: true });
  try {
    const runtime = await createInvocationRuntime({ profile: fixture.profile });
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) throw new Error("expected a runtime");
    expect(runtime.context.runtime.granted).not.toEqual([]);
    expect(evaluateAuthority(
      runtime.context.runtime.granted as unknown as readonly PermissionEntry[],
      fixture.hermetic.permissions,
    )).toEqual({ satisfied: true, missing: [] });
    const capabilities = authOperationDefinitions.find((definition) =>
      definition.id === "tinycloud.auth.capabilities",
    ) as OperationDefinition<{}, { readonly capabilities: readonly PermissionEntry[] }> | undefined;
    if (capabilities === undefined) throw new Error("missing auth capabilities operation");
    const result = await capabilities.execute(runtime.context, {});
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(evaluateAuthority(result.output.capabilities, fixture.hermetic.permissions))
        .toEqual({ satisfied: true, missing: [] });
    }
  } finally {
    fixture.hermetic.stop();
  }
});

test("replay rejects expired and CID-tampered stored records instead of trusting display metadata", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const delegation = await fixture.hermetic.mintDelegation();
    await persistRuntimeDelegations(fixture, [
      { ...delegation, cid: `${delegation.cid}-tampered` },
      { ...delegation, expiry: new Date(0) },
    ]);

    const runtime = await createInvocationRuntime({ profile: fixture.profile });
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) throw new Error("expected a runtime");
    expect(runtime.context.runtime.granted).toEqual([]);
    expect((runtime.context.runtime.node as RuntimeNode).getRuntimePermissionDelegations()).toEqual([]);
  } finally {
    fixture.hermetic.stop();
  }
});

test("replay refuses a compact record broader than its stored binding before activating it", async () => {
  const fixture = await createAuthRuntimeFixture();
  const activations = spyOn(TinyCloudNode.prototype, "useRuntimeDelegation");
  try {
    const kvOnly = fixture.hermetic.permissions.filter((permission) => permission.service === "tinycloud.kv");
    const broader = await fixture.hermetic.mintDelegation();
    const narrow = await fixture.hermetic.mintDelegationWithPermissions([...kvOnly]);
    const binding = { requestId: "req_kv_only", requested: kvOnly };
    await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [
      { delegation: broader, permissions: kvOnly, authorityRequest: binding },
      { delegation: narrow, permissions: kvOnly, authorityRequest: binding },
    ]);

    const runtime = await authenticatedRuntime(fixture.profile);
    expect(runtime.runtime.granted).toEqual(canonicalizeCapabilities(kvOnly));
    expect(installedCids(runtime)).toEqual([narrow.cid]);
    expect(activations.mock.calls.map(([delegation]) => delegation.cid)).toEqual([narrow.cid]);
  } finally {
    activations.mockRestore();
    fixture.hermetic.stop();
  }
});

test("after its migration a profile installs no unbound or malformed-binding compact record", async () => {
  const fixture = await createAuthRuntimeFixture();
  const activations = spyOn(TinyCloudNode.prototype, "useRuntimeDelegation");
  try {
    const delegation = await fixture.hermetic.mintDelegation();
    // A binding that is present but invalid is refused, never migrated.
    const malformed = { delegation, permissions: [], authorityRequest: { requestId: "req_without_requested" } };
    await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [malformed]);
    const first = await authenticatedRuntime(fixture.profile);
    expect(first.runtime.granted).toEqual([]);
    expect(await readAdditionalDelegations(fixture.profile)).toEqual([JSON.parse(JSON.stringify(malformed))]);
    expect(await readJson(bindingMigrationPath(fixture.profile))).toMatchObject({ formatVersion: 1, bound: [] });

    // Planted after the migration, as an unbound `tc auth import` or a pasted record would be.
    await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [{ delegation, permissions: [] }]);
    const second = await authenticatedRuntime(fixture.profile);
    expect(second.runtime.granted).toEqual([]);
    expect(installedCids(second)).toEqual([]);
    expect(activations).not.toHaveBeenCalled();
  } finally {
    activations.mockRestore();
    fixture.hermetic.stop();
  }
});

test("migration binds an existing unbound compact record to its own signed authority and never widens it", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const kvOnly = fixture.hermetic.permissions.filter((permission) => permission.service === "tinycloud.kv");
    const delegation = await fixture.hermetic.mintDelegationWithPermissions([...kvOnly]);
    await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [{
      delegation,
      // Display metadata claiming more is not what migration binds.
      permissions: fixture.hermetic.permissions,
    }]);

    const first = await authenticatedRuntime(fixture.profile);
    expect(first.runtime.granted).toEqual(canonicalizeCapabilities(kvOnly));
    const [migrated] = await readAdditionalDelegations<Record<string, unknown>>(fixture.profile);
    expect(migrated).toMatchObject({
      authorityRequest: { requestId: `migrated:${delegation.cid}`, requested: canonicalizeCapabilities(kvOnly) },
      authorityRequestAudit: { source: "migration", recordedAt: expect.any(String), note: BINDING_NOTES.migration },
    });
    expect(await readJson(bindingMigrationPath(fixture.profile))).toMatchObject({ bound: [delegation.cid] });

    const second = await authenticatedRuntime(fixture.profile);
    expect(second.runtime.granted).toEqual(canonicalizeCapabilities(kvOnly));
    expect(installedCids(second)).toEqual([delegation.cid]);

    // A broader delegation placed under the migrated binding is refused.
    const broader = await fixture.hermetic.mintDelegation();
    await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [{ ...migrated, delegation: broader }]);
    const third = await authenticatedRuntime(fixture.profile);
    expect(third.runtime.granted).toEqual([]);
    expect(installedCids(third)).toEqual([]);
  } finally {
    fixture.hermetic.stop();
  }
});

test("a record a locked writer publishes while migration waits for the lock is bound by the next runtime", async () => {
  const fixture = await createAuthRuntimeFixture();
  const original = TinyCloudNode.prototype.useRuntimeDelegation;
  const activations = spyOn(TinyCloudNode.prototype, "useRuntimeDelegation");
  try {
    const kvOnly = fixture.hermetic.permissions.filter((permission) => permission.service === "tinycloud.kv");
    const first = await fixture.hermetic.mintDelegationWithPermissions([...kvOnly]);
    const second = await fixture.hermetic.mintDelegation();
    await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [{ delegation: first, permissions: [] }]);

    // A writer holds the profile lock from before the runtime starts and
    // publishes `second`, unbound, while the runtime replays `first`.
    let locked!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const writer = withProfileLock(fixture.profile, async () => {
      locked();
      await released;
      await upsertProfileRecord(
        fixture.profile,
        "additional-delegations",
        second.cid,
        { delegation: second, permissions: [] },
        (candidate: { delegation: { cid: string } }) => candidate.delegation.cid,
      );
    });
    await holding;
    activations.mockImplementation(async function (this: TinyCloudNode, delegation) {
      release();
      await writer;
      return original.call(this, delegation);
    });

    const during = await authenticatedRuntime(fixture.profile);
    expect(installedCids(during)).toEqual([first.cid]);
    activations.mockRestore();

    const after = await authenticatedRuntime(fixture.profile);
    expect(installedCids(after).sort()).toEqual([first.cid, second.cid].sort());
    expect((await readAdditionalDelegations<Record<string, unknown>>(fixture.profile)).map(
      (record) => (record.authorityRequest as { requestId: string }).requestId,
    )).toEqual([`migrated:${first.cid}`, `migrated:${second.cid}`]);
  } finally {
    activations.mockRestore();
    fixture.hermetic.stop();
  }
});

test("migration binds a record a host-overridden first invocation cannot activate", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const delegation = { ...await fixture.hermetic.mintDelegation(), host: fixture.hermetic.host };
    await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [{ delegation, permissions: [] }]);

    const elsewhere = await createInvocationRuntime({ profile: fixture.profile, host: "http://127.0.0.1:9" });
    if (!elsewhere.ok) throw new Error(`expected a runtime: ${elsewhere.error.code}`);
    expect(elsewhere.context.runtime.granted).toEqual([]);
    expect(await readJson(bindingMigrationPath(fixture.profile))).toMatchObject({ bound: [delegation.cid] });

    const home = await authenticatedRuntime(fixture.profile);
    expect(installedCids(home)).toEqual([delegation.cid]);
  } finally {
    fixture.hermetic.stop();
  }
});

test("a runtime that restores its session while another migrates replays the migrated records", async () => {
  const fixture = await createAuthRuntimeFixture();
  const original = TinyCloudNode.prototype.restoreSession;
  const restores = spyOn(TinyCloudNode.prototype, "restoreSession");
  try {
    const delegation = await fixture.hermetic.mintDelegation();
    await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [{ delegation, permissions: [] }]);

    // The slower runtime is mid-restore when the faster one migrates.
    let faster: RuntimeOperationContext | undefined;
    restores.mockImplementation(async function (this: TinyCloudNode, session) {
      if (faster === undefined) {
        restores.mockImplementation(function (this: TinyCloudNode, inner) {
          return original.call(this, inner);
        });
        faster = await authenticatedRuntime(fixture.profile);
      }
      return original.call(this, session);
    });
    const slower = await authenticatedRuntime(fixture.profile);

    expect(installedCids(faster!)).toEqual([delegation.cid]);
    expect(installedCids(slower)).toEqual([delegation.cid]);
    expect(slower.runtime.granted).toEqual(canonicalizeCapabilities(fixture.hermetic.permissions));
  } finally {
    restores.mockRestore();
    fixture.hermetic.stop();
  }
});

test("migration binds every bindable record when another cannot be bound, and still records the migration", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const good = await fixture.hermetic.mintDelegation();
    // Unsigned bytes suffice: the node checks the signature only on activation.
    const unbindable = await compactDelegationSigning(fixture, { "": [] });
    await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [
      { delegation: unbindable, permissions: [] },
      { delegation: good, permissions: [] },
    ]);

    const first = await authenticatedRuntime(fixture.profile);
    expect(installedCids(first)).toEqual([good.cid]);
    expect(await readJson(bindingMigrationPath(fixture.profile))).toMatchObject({
      bound: [good.cid],
      unbound: [unbindable.cid],
    });
    const records = await readAdditionalDelegations<Record<string, unknown>>(fixture.profile);
    expect(records[0]).not.toHaveProperty("authorityRequest");
    expect(records[1]).toMatchObject({ authorityRequest: { requestId: `migrated:${good.cid}` } });

    const second = await authenticatedRuntime(fixture.profile);
    expect(installedCids(second)).toEqual([good.cid]);
  } finally {
    fixture.hermetic.stop();
  }
});

test("a runtime whose session was rotated after its restore leaves the migration to the new session", async () => {
  const fixture = await createAuthRuntimeFixture();
  const original = TinyCloudNode.prototype.restoreSession;
  const restores = spyOn(TinyCloudNode.prototype, "restoreSession");
  try {
    const rotated = await fixture.hermetic.createRotatedRestorableSession();
    const delegation = await fixture.hermetic.mintDelegationForAudience(
      rotated.verificationMethod.split("#", 1)[0]!,
    );
    // After the stale runtime restores the old session, a writer rotates the
    // session and stores an unbound delegation addressed to the new one.
    let rotatedOnDisk = false;
    restores.mockImplementation(async function (this: TinyCloudNode, session) {
      await original.call(this, session);
      if (rotatedOnDisk) return;
      rotatedOnDisk = true;
      await writeJsonAtomic(sessionPath(fixture.profile), rotated);
      await writeJsonAtomic(additionalDelegationsPath(fixture.profile), [{ delegation, permissions: [] }]);
    });

    await authenticatedRuntime(fixture.profile);
    expect(await readJson(bindingMigrationPath(fixture.profile))).toBeNull();

    const fresh = await authenticatedRuntime(fixture.profile);
    expect(installedCids(fresh)).toEqual([delegation.cid]);
    expect(await readJson(bindingMigrationPath(fixture.profile))).toMatchObject({ bound: [delegation.cid] });
  } finally {
    restores.mockRestore();
    fixture.hermetic.stop();
  }
});

test("a local sign-in without the profile's stored session never runs the migration", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const delegation = await fixture.hermetic.mintDelegation();
    await rm(sessionPath(fixture.ownerProfile), { force: true });
    await writeJsonAtomic(additionalDelegationsPath(fixture.ownerProfile), [{ delegation, permissions: [] }]);

    const runtime = await createInvocationRuntime({ profile: fixture.ownerProfile });
    if (!runtime.ok) throw new Error(`expected a runtime: ${runtime.error.code}`);
    expect(await readJson(bindingMigrationPath(fixture.ownerProfile))).toBeNull();
    expect(await readAdditionalDelegations(fixture.ownerProfile)).toEqual([JSON.parse(JSON.stringify({
      delegation,
      permissions: [],
    }))]);
  } finally {
    fixture.hermetic.stop();
  }
});

test("never falls back to a configured profile when the pinned profile disappears", async () => {
  await writeJsonAtomic(profileConfigPath("fallback"), {
    name: "fallback",
    host: "https://node.example",
    chainId: 1,
    spaceName: "secrets",
    did: "did:key:fallback",
    createdAt: "2026-07-14T12:00:00.000Z",
  });
  await writeJsonAtomic(`${home}/.tinycloud/config.json`, { defaultProfile: "fallback" });

  const result = await createInvocationRuntime({ profile: "deleted" });
  expect(result).toEqual({
    ok: false,
    context: {
      profile: "deleted",
      host: "unresolved",
      posture: "unauthenticated",
    },
    error: {
      code: "PROFILE_NOT_FOUND",
      message: 'Profile "deleted" is not available.',
      retryable: false,
    },
  });
});

test("rejects a delegate profile with local owner material before sign-in or runtime execution", async () => {
  await writeJsonAtomic(profileConfigPath("incoherent"), {
    name: "incoherent",
    host: "https://node.example",
    chainId: 1,
    spaceName: "secrets",
    did: "did:key:delegate",
    sessionDid: "did:key:delegate",
    posture: "delegate-session",
    authMethod: "local",
    privateKey: "1".padStart(64, "0"),
    createdAt: "2026-07-14T12:00:00.000Z",
  });
  const signIn = spyOn(TinyCloudNode.prototype, "signIn").mockImplementation(async () => {
    throw new Error("owner sign-in must not be reached");
  });

  try {
    const result = await createInvocationRuntime({ profile: "incoherent" });

    expect(result).toEqual({
      ok: false,
      context: {
        profile: "incoherent",
        host: "unresolved",
        posture: "unauthenticated",
      },
      error: {
        code: "PROFILE_NOT_FOUND",
        message: 'Profile "incoherent" is not available.',
        retryable: false,
      },
    });
    expect(signIn).not.toHaveBeenCalled();
  } finally {
    signIn.mockRestore();
  }
});

function validatedDelegation(
  delegation: StoredRuntimeDelegation,
  effectivePermissions: readonly unknown[],
): Record<string, unknown> {
  if (delegation.host === undefined) throw new Error("expected a validated delegation host");
  return {
    cid: delegation.cid,
    delegation,
    effectivePermissions,
    expiry: delegation.expiry,
    audience: delegation.delegateDID,
    host: delegation.host,
  };
}

async function authenticatedRuntime(profile: string): Promise<RuntimeOperationContext> {
  const runtime = await createInvocationRuntime({ profile });
  if (!runtime.ok) throw new Error(`expected a runtime: ${runtime.error.code}`);
  return runtime.context;
}

function installedCids(context: RuntimeOperationContext): string[] {
  return (context.runtime.node as RuntimeNode).getRuntimePermissionDelegations().map(({ cid }) => cid);
}

/**
 * A compact UCAN for the fixture's session key on `notes` in its space, with
 * the given signed abilities and a placeholder signature.
 */
async function compactDelegationSigning(
  fixture: AuthRuntimeFixture,
  abilities: Record<string, unknown[]>,
): Promise<StoredRuntimeDelegation & { resources: unknown[] }> {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const space = fixture.hermetic.restorableSession.spaceId;
  const exp = Math.floor(Date.now() / 1000) + 3_600;
  const authorization = [
    encode({ alg: "EdDSA", typ: "JWT" }),
    encode({
      iss: fixture.hermetic.ownerDid,
      aud: fixture.sessionDid,
      exp,
      prf: [],
      att: { [`${space}/kv/notes`]: abilities },
    }),
    "c2lnbmF0dXJl",
  ].join(".");
  const actions = Object.keys(abilities).sort();
  return {
    cid: new TinyCloudNode({ host: fixture.hermetic.host }).computeDelegationCid(authorization),
    delegationHeader: { Authorization: authorization },
    spaceId: space,
    path: "notes",
    actions,
    resources: [{ service: "kv", space, path: "notes", actions }],
    ownerAddress: fixture.hermetic.restorableSession.address as string,
    chainId: fixture.hermetic.restorableSession.chainId as number,
    expiry: new Date(exp * 1000),
    delegateDID: fixture.sessionDid,
  };
}

interface RuntimeNode {
  readonly sessionDid: string;
  getRuntimePermissionDelegations(): readonly StoredRuntimeDelegation[];
}
