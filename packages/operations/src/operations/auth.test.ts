import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import { z } from "zod";

import { canonicalizeCapabilities } from "../authority.js";
import type {
  OperationDefinition,
  RuntimeOperationContext,
} from "../contract.js";
import { createInvocationRuntime } from "../runtime.js";
import * as registry from "../registry.js";
import { readAdditionalDelegations } from "../state.js";
import {
  createAuthRuntimeFixture,
  type StoredRuntimeDelegation,
} from "../../test-support/auth-runtime.js";

let definitions: readonly OperationDefinition<unknown, unknown>[] = [];

import { authOperationDefinitions } from "./auth.js";

spyOn(registry, "lookupOperation").mockImplementation((operationId, operationVersion) => {
  const matching = definitions.filter((definition) => definition.id === operationId);
  if (matching.length === 0) return { status: "operation_not_found" };
  const definition = matching.find((candidate) => candidate.version === operationVersion);
  return definition === undefined
    ? { status: "operation_version_unsupported", supportedVersions: matching.map((item) => item.version) }
    : { status: "found", definition };
});

let home: string;
let handlerRuns = 0;

beforeEach(async () => {
  home = await mkdtemp(`${tmpdir()}/tinycloud-operations-auth-`);
  process.env.TC_HOME = home;
  definitions = [];
  handlerRuns = 0;
});

afterEach(async () => {
  delete process.env.TC_HOME;
  await rm(home, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

test("defines exactly the three unregistered v1 auth operations", () => {
  expect(authOperationDefinitions.map((definition) => [definition.id, definition.version])).toEqual([
    ["tinycloud.auth.capabilities", 1],
    ["tinycloud.auth.request", 1],
    ["tinycloud.auth.import", 1],
  ]);
});

test("auth request accepts no free-form capabilities and calls only a registered planner", async () => {
  const request = requestDefinition();
  expect(request.input.safeParse({ permissions: [capability] }).success).toBe(false);
  expect(request.input.safeParse({ operationId: "tinycloud.test.get", operationVersion: 1 }).success).toBe(false);
  expect(request.input.safeParse({ ...targetInput(), replace: true }).success).toBe(false);

  definitions = [targetDefinition()];
  const outcome = await request.execute(context(), targetInput());

  expect(outcome).toMatchObject({ status: "ok", output: { missing: [capability] } });
  expect(handlerRuns).toBe(0);
});

test("auth request reuses equivalent exact requests and persists nothing when authority is satisfied", async () => {
  definitions = [targetDefinition()];
  const request = requestDefinition();
  const first = await request.execute(context(), targetInput());
  const second = await request.execute(context(), targetInput());

  expect(first.status).toBe("ok");
  expect(second.status).toBe("ok");
  if (first.status !== "ok" || second.status !== "ok") throw new Error("expected requests");
  expect(first.output.request?.requestId).toBe(second.output.request?.requestId);

  const satisfied = await request.execute(context([capability]), targetInput());
  expect(satisfied).toEqual({ status: "ok", output: { missing: [] } });
});

test("a stored request is bound to the active profile host and session", async () => {
  definitions = [targetDefinition()];
  const request = requestDefinition();
  const created = await request.execute(context(), targetInput());
  if (created.status !== "ok" || created.output.request === undefined) throw new Error("expected request");

  const oldSession = await request.execute(context([], "did:key:rotated"), {
    requestId: created.output.request.requestId,
  });
  expect(oldSession).toMatchObject({ status: "error", error: { code: "INPUT_INVALID" } });

  const oldHost = await request.execute(context([], "did:key:session", "https://other.example"), {
    requestId: created.output.request.requestId,
  });
  expect(oldHost).toMatchObject({ status: "error", error: { code: "INPUT_INVALID" } });
});

test("import rejects malformed, host, audience, expiry, session-rotation, and CID-invalid artifacts before persistence", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const runtime = await runtimeContext(fixture.profile);
    const importer = importDefinition();
    const delegation = await fixture.hermetic.mintDelegation();

    expect(importer.input.safeParse({
      ...importArtifact("missing-request", delegation),
      delegation: {},
    }).success).toBe(false);

    const noRequest = await importer.execute(runtime, importArtifact("missing-request", delegation));
    expect(noRequest).toMatchObject({ status: "error", error: { code: "DELEGATION_ARTIFACT_INVALID" } });

    const requestId = await createBoundRequest(runtime, fixture.hermetic.permissions);

    const badHost = await importer.execute(runtime, importArtifact(requestId, {
      ...delegation,
      host: "https://other.example",
    }));
    expect(badHost).toMatchObject({ status: "error", error: { code: "DELEGATION_HOST_MISMATCH" } });

    const badAudience = await importer.execute(runtime, importArtifact(requestId, {
      ...delegation,
      delegateDID: fixture.hermetic.unrelatedAudience,
    }));
    expect(badAudience).toMatchObject({ status: "error", error: { code: "DELEGATION_AUDIENCE_MISMATCH" } });

    const expired = await importer.execute(runtime, importArtifact(requestId, {
      ...delegation,
      expiry: new Date(0),
    }));
    expect(expired).toMatchObject({ status: "error", error: { code: "DELEGATION_EXPIRED" } });

    const rotated = await importer.execute({
      ...runtime,
      summary: { ...runtime.summary, sessionDid: fixture.hermetic.unrelatedAudience },
    }, importArtifact(requestId, delegation));
    expect(rotated).toMatchObject({ status: "error", error: { code: "DELEGATION_AUDIENCE_MISMATCH" } });

    const sdkInvalid = await importer.execute(runtime, importArtifact(requestId, {
      ...delegation,
      cid: `${delegation.cid}-tampered`,
    }));
    expect(sdkInvalid).toMatchObject({ status: "error", error: { code: "DELEGATION_REJECTED" } });
    expect(await readAdditionalDelegations(fixture.profile)).toEqual([]);
  } finally {
    fixture.hermetic.stop();
  }
});

test("imports a real signed delegation idempotently and a fresh runtime replays only its signed authority", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const runtime = await runtimeContext(fixture.profile);
    const requestId = await createBoundRequest(runtime, fixture.hermetic.permissions);
    const delegation = await fixture.hermetic.mintDelegation();
    const importer = importDefinition();
    const artifact = {
      ...importArtifact(requestId, delegation),
      permissions: [{
        service: "tinycloud.kv",
        path: "display-only",
        actions: ["tinycloud.kv/*"],
      }],
    };

    const first = await importer.execute(runtime, artifact);
    const second = await importer.execute(runtime, artifact);
    expect(first).toMatchObject({
      status: "ok",
      output: {
        cid: delegation.cid,
        effectivePermissions: canonicalizeCapabilities(fixture.hermetic.permissions),
        activated: true,
        alreadyPresent: false,
      },
    });
    expect(second).toMatchObject({
      status: "ok",
      output: { cid: delegation.cid, activated: true, alreadyPresent: true },
    });
    expect(JSON.stringify(first)).not.toContain(delegation.delegationHeader.Authorization);
    expect(await readAdditionalDelegations(fixture.profile)).toHaveLength(1);

    const fresh = await createInvocationRuntime({ profile: fixture.profile });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error("expected a fresh runtime");
    expect(fresh.context.runtime.granted).toEqual(
      canonicalizeCapabilities(fixture.hermetic.permissions),
    );
  } finally {
    fixture.hermetic.stop();
  }
});

const capability = {
  service: "tinycloud.kv",
  space: "secrets",
  path: "vault/secrets/API_KEY",
  actions: ["tinycloud.kv/get"],
};

function context(
  granted: readonly typeof capability[] = [],
  sessionDid = "did:key:session",
  host = "https://node.example",
): RuntimeOperationContext {
  return {
    summary: {
      profile: "delegate",
      host,
      posture: "delegate-session",
      operatorType: "agent",
      sessionDid,
      ownerDid: "did:key:owner",
    },
    runtime: { node: {}, granted },
  };
}

function targetInput() {
  return { operationId: "tinycloud.test.get", operationVersion: 1, input: { name: "API_KEY" } };
}

function targetDefinition(
  planned: readonly PermissionEntry[] = [capability],
): OperationDefinition<unknown, unknown> {
  return {
    id: "tinycloud.test.get",
    version: 1,
    title: "Test operation",
    description: "Test operation",
    input: z.object({ name: z.string() }),
    output: z.object({ value: z.string() }),
    effects: ["read"],
    postures: ["delegate-session"],
    exposure: {
      cli: { status: "required" },
      mcp: { status: "required" },
      skill: { status: "required" },
      docs: { status: "required" },
    },
    sensitivity: { input: [], output: [] },
    authority: async () => planned as unknown as readonly Readonly<Record<string, unknown>>[],
    execute: async () => {
      handlerRuns += 1;
      return { status: "ok", output: { value: "unreachable" } };
    },
  };
}

async function runtimeContext(profile: string): Promise<RuntimeOperationContext> {
  const runtime = await createInvocationRuntime({ profile });
  if (!runtime.ok) throw new Error(`expected runtime: ${runtime.error.code}`);
  return runtime.context;
}

async function createBoundRequest(
  runtime: RuntimeOperationContext,
  permissions: readonly PermissionEntry[],
): Promise<string> {
  definitions = [targetDefinition(permissions)];
  const result = await requestDefinition().execute(runtime, targetInput());
  if (result.status !== "ok" || result.output.request === undefined) {
    throw new Error("expected a request-bound delegation artifact");
  }
  return result.output.request.requestId;
}

function requestDefinition(): OperationDefinition<any, any> {
  const definition = authOperationDefinitions.find((item) => item.id === "tinycloud.auth.request");
  if (definition === undefined) throw new Error("auth request definition missing");
  return definition;
}

function importDefinition(): OperationDefinition<any, any> {
  const definition = authOperationDefinitions.find((item) => item.id === "tinycloud.auth.import");
  if (definition === undefined) throw new Error("auth import definition missing");
  return definition;
}

function importArtifact(requestId: string, delegation: StoredRuntimeDelegation) {
  return {
    kind: "tinycloud.auth.delegation" as const,
    version: 1 as const,
    requestId,
    delegation,
  };
}
