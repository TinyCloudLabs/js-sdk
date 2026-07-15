import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { canonicalizeCapabilities } from "./authority.js";
import { createInvocationRuntime } from "./runtime.js";
import { profileConfigPath, writeJsonAtomic } from "./state.js";
import {
  createAuthRuntimeFixture,
  persistRuntimeDelegations,
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

interface RuntimeNode {
  readonly sessionDid: string;
  getRuntimePermissionDelegations(): readonly StoredRuntimeDelegation[];
}
