import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type {
  OperationContext,
  OperationDefinition,
  OperationExecutionOutcome,
} from "../contract.js";
import {
  additionalDelegationsPath,
  profileConfigPath,
  sessionPath,
  tinycloudConfigPath,
  writeJsonAtomic,
} from "../state.js";
import { statusOperationDefinitions } from "./status.js";

type StatusOutput = {
  readonly profile: string;
  readonly host: string;
  readonly posture: "owner-openkey" | "delegate-session" | "local-owner-key" | "unauthenticated";
  readonly operatorType?: "human" | "agent";
  readonly principalDid?: string;
  readonly sessionDid?: string;
  readonly ownerDid?: string;
  readonly space?: string;
  readonly session: {
    readonly present: boolean;
    readonly expired: boolean | null;
    readonly expiresAt: string | null;
  };
  readonly liveAdditionalDelegationCount: number;
};

const originalTcHome = process.env.TC_HOME;
const originalHome = process.env.HOME;
const homes: string[] = [];

afterEach(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

test("defines exactly the two internal read-only v1 status operations with strict empty input", () => {
  expect(statusOperationDefinitions.map((definition) => [definition.id, definition.version])).toEqual([
    ["tinycloud.status.get", 1],
    ["tinycloud.auth.status", 1],
  ]);

  for (const definition of statusOperationDefinitions) {
    expect(definition.effects).toEqual(["read"]);
    expect(definition.input.safeParse({}).success).toBe(true);
    expect(definition.input.safeParse({ argument: "raw-argument-canary" }).success).toBe(false);
    expect(definition.sensitivity).toEqual({ input: [], output: [] });
  }
});

test("returns the same safe delegate summary for status and auth status", async () => {
  await isolatedHome();
  const now = Date.now();
  const sessionExpiry = new Date(now + 60_000).toISOString();
  await writeProfile("delegate", {
    privateKey: "private-key-canary",
    jwk: { d: "jwk-canary" },
    token: "profile-token-canary",
  });
  await writeJsonAtomic(sessionPath("delegate"), {
    expiresAt: sessionExpiry,
    sessionKey: "session-key-canary",
    signature: "signature-canary",
    delegationHeader: { Authorization: "session-authorization-canary" },
  });
  await writeJsonAtomic(additionalDelegationsPath("delegate"), [
    storedDelegation(new Date(now + 120_000).toISOString(), "live-one"),
    storedDelegation(new Date(now + 180_000).toISOString(), "live-two"),
    storedDelegation(new Date(now - 1).toISOString(), "expired"),
  ]);

  const expected: StatusOutput = {
    profile: "delegate",
    host: "https://node.tinycloud.test",
    posture: "delegate-session",
    operatorType: "agent",
    principalDid: "did:key:delegate",
    sessionDid: "did:key:session",
    ownerDid: "did:pkh:eip155:1:0xowner",
    space: "tinycloud:pkh:eip155:1:0xowner:secrets",
    session: { present: true, expired: false, expiresAt: sessionExpiry },
    liveAdditionalDelegationCount: 2,
  };

  for (const definition of statusOperationDefinitions) {
    const result = await execute(definition, delegateContext());
    expect(result).toEqual({ status: "ok", output: expected });
    if (result.status === "ok") {
      expect(definition.output.safeParse(result.output).success).toBe(true);
      expect(definition.output.safeParse({ ...result.output, privateKey: "forbidden" }).success).toBe(false);
    }
  }
});

test("returns an owner-safe summary without a session while preserving operator type", async () => {
  await isolatedHome();
  await writeProfile("owner");
  await writeJsonAtomic(additionalDelegationsPath("owner"), []);

  const result = await execute(definition("tinycloud.auth.status"), {
    summary: {
      profile: "owner",
      host: "https://node.tinycloud.test",
      posture: "owner-openkey",
      operatorType: "human",
      principalDid: "did:pkh:eip155:1:0xowner",
      ownerDid: "did:pkh:eip155:1:0xowner",
    },
  });

  expect(result).toEqual({
    status: "ok",
    output: {
      profile: "owner",
      host: "https://node.tinycloud.test",
      posture: "owner-openkey",
      operatorType: "human",
      principalDid: "did:pkh:eip155:1:0xowner",
      ownerDid: "did:pkh:eip155:1:0xowner",
      session: { present: false, expired: null, expiresAt: null },
      liveAdditionalDelegationCount: 0,
    },
  });
});

test("reports a missing session and treats expiry at the boundary as expired", async () => {
  await isolatedHome();
  await writeProfile("delegate");
  await writeJsonAtomic(additionalDelegationsPath("delegate"), []);

  const missing = await execute(definition("tinycloud.status.get"), delegateContext());
  expect(missing).toEqual({
    status: "ok",
    output: expect.objectContaining({
      session: { present: false, expired: null, expiresAt: null },
    }),
  });

  const boundary = new Date(Date.now()).toISOString();
  await writeJsonAtomic(sessionPath("delegate"), { expiresAt: boundary });
  const expired = await execute(definition("tinycloud.status.get"), delegateContext());
  expect(expired).toEqual({
    status: "ok",
    output: expect.objectContaining({
      session: { present: true, expired: true, expiresAt: boundary },
    }),
  });
});

test("counts only additional delegations whose expiry is strictly in the future", async () => {
  await isolatedHome();
  await writeProfile("delegate");
  await writeJsonAtomic(additionalDelegationsPath("delegate"), [
    storedDelegation(new Date(Date.now() - 1).toISOString(), "expired"),
    storedDelegation(new Date(Date.now()).toISOString(), "boundary"),
    storedDelegation(new Date(Date.now() + 60_000).toISOString(), "live"),
  ]);

  const result = await execute(definition("tinycloud.status.get"), delegateContext());
  expect(result).toEqual({
    status: "ok",
    output: expect.objectContaining({ liveAdditionalDelegationCount: 1 }),
  });
});

test("refuses a deleted pinned profile without reading the configured fallback", async () => {
  await isolatedHome();
  await writeJsonAtomic(tinycloudConfigPath(), { defaultProfile: "fallback", version: 1 });
  await writeProfile("fallback");
  await writeJsonAtomic(sessionPath("fallback"), { expiresAt: new Date(Date.now() + 60_000).toISOString() });

  expect(await execute(definition("tinycloud.status.get"), {
    summary: {
      profile: "deleted",
      host: "https://node.tinycloud.test",
      posture: "delegate-session",
      operatorType: "agent",
    },
  })).toEqual({
    status: "error",
    error: {
      code: "PROFILE_NOT_FOUND",
      message: 'Profile "deleted" is not available.',
      retryable: false,
    },
  });
});

test("refuses malformed stores and never serializes stored secrets or raw artifacts", async () => {
  await isolatedHome();
  const canaries = {
    privateKey: "private-key-canary",
    jwk: "jwk-canary",
    token: "token-canary",
    authorization: "authorization-canary",
    delegation: "raw-delegation-canary",
    argument: "raw-argument-canary",
    secret: "secret-value-canary",
  };
  await writeProfile("delegate", {
    privateKey: canaries.privateKey,
    jwk: { d: canaries.jwk },
    token: canaries.token,
    secret: canaries.secret,
  });
  await writeJsonAtomic(sessionPath("delegate"), {
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    token: canaries.token,
    sessionKey: canaries.privateKey,
  });
  await writeJsonAtomic(additionalDelegationsPath("delegate"), [
    {
      delegation: {
        expiry: new Date(Date.now() + 60_000).toISOString(),
        bytes: canaries.delegation,
        delegationHeader: { Authorization: canaries.authorization },
      },
    },
  ]);

  const statusDefinition = definition("tinycloud.status.get");
  const successfulOutput = await execute(statusDefinition, delegateContext());
  expect(successfulOutput).toMatchObject({
    status: "ok",
    output: { liveAdditionalDelegationCount: 1 },
  });

  await writeJsonAtomic(additionalDelegationsPath("delegate"), [
    {
      delegation: {
        expiry: "not-a-date",
        bytes: canaries.delegation,
        delegationHeader: { Authorization: canaries.authorization },
      },
    },
  ]);

  const malformed = await execute(statusDefinition, delegateContext());
  expect(malformed).toEqual({
    status: "error",
    error: {
      code: "INTERNAL_ERROR",
      message: "The profile state could not be inspected.",
      retryable: false,
    },
  });

  const serialized = JSON.stringify({
    validInput: statusDefinition.input.safeParse({}),
    rejectedInput: statusDefinition.input.safeParse({ argument: canaries.argument }),
    successfulOutput,
    outputOrError: malformed,
  });
  for (const canary of Object.values(canaries)) {
    expect(serialized).not.toContain(canary);
  }
});

async function isolatedHome(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-operations-status-"));
  homes.push(home);
  process.env.TC_HOME = home;
  process.env.HOME = homedir();
}

async function writeProfile(profile: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeJsonAtomic(profileConfigPath(profile), {
    host: "https://node.tinycloud.test",
    ...extra,
  });
}

function storedDelegation(expiry: string, suffix: string): Record<string, unknown> {
  return {
    delegation: {
      cid: `bafy-${suffix}`,
      expiry,
      delegationHeader: { Authorization: `authorization-${suffix}` },
      bytes: `delegation-bytes-${suffix}`,
    },
  };
}

function definition(id: string): OperationDefinition<{}, StatusOutput> {
  const candidate = statusOperationDefinitions.find((item) => item.id === id);
  if (candidate === undefined) throw new Error(`Missing status definition ${id}.`);
  return candidate;
}

async function execute(
  operation: OperationDefinition<{}, StatusOutput>,
  context: OperationContext,
): Promise<OperationExecutionOutcome<StatusOutput>> {
  return operation.execute(context, {});
}

function delegateContext(): OperationContext {
  return {
    summary: {
      profile: "delegate",
      host: "https://node.tinycloud.test",
      posture: "delegate-session",
      operatorType: "agent",
      principalDid: "did:key:delegate",
      sessionDid: "did:key:session",
      ownerDid: "did:pkh:eip155:1:0xowner",
      space: "tinycloud:pkh:eip155:1:0xowner:secrets",
    },
  };
}
