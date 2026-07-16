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
import { invokeOperation } from "../invoke.js";
import { createSafeOperationDiagnostic } from "../redaction.js";
import * as registry from "../registry.js";
import {
  additionalDelegationsPath,
  authRequestsPath,
  profileStoreMetadataPath,
  readJson,
  readAdditionalDelegations,
  sessionPath,
  withProfileLock,
  writeJsonAtomic,
} from "../state.js";
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

test("defines exactly the three internal v1 auth operations", () => {
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

test("auth request rejects prefix, caveated, and non-array planner hints", async () => {
  const request = requestDefinition();
  for (const planned of [
    [{ ...capability, path: "/" }],
    [{ ...capability, path: "vault/secrets/" }],
    [{ ...capability, caveats: [{ tenant: "one" }] }],
    { not: "an array" },
  ]) {
    definitions = [targetDefinition(planned)];
    const result = await request.execute(context(), targetInput());
    expect(result).toMatchObject({ status: "error", error: { code: "PERMISSION_HINT_INVALID" } });
  }
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

test("a covered stored request is reevaluated and returns no artifact", async () => {
  definitions = [targetDefinition()];
  const request = requestDefinition();
  const created = await request.execute(context(), targetInput());
  if (created.status !== "ok" || created.output.request === undefined) {
    throw new Error("expected a stored request");
  }

  const covered = await request.execute(context([capability]), {
    requestId: created.output.request.requestId,
  });

  expect(covered).toEqual({ status: "ok", output: { missing: [] } });
});

test("a partially covered stored request returns and persists only its exact missing subset", async () => {
  const put = { ...capability, actions: ["tinycloud.kv/put"] };
  definitions = [targetDefinition([capability, put])];
  const request = requestDefinition();
  const created = await request.execute(context(), targetInput());
  if (created.status !== "ok" || created.output.request === undefined) {
    throw new Error("expected a stored request");
  }

  const reevaluated = await request.execute(
    context([capability]),
    { requestId: created.output.request.requestId },
  );

  expect(reevaluated).toMatchObject({
    status: "ok",
    output: { missing: [put], request: { requested: [put] } },
  });
  expect(created.output.request.requested).toEqual([capability, put]);
  const stored = await readAuthRequestRecords("delegate");
  expect(stored.map((entry) => entry.requested)).toEqual([[put]]);
});

test("maps malformed import input through canonical invocation to DELEGATION_ARTIFACT_INVALID", async () => {
  definitions = [importDefinition()];

  const result = await invokeOperation("tinycloud.auth.import", 1, {}, {
    kind: "tinycloud.auth.delegation",
    version: 1,
    requestId: "request-1",
    delegation: { cid: "malformed" },
  });

  expect(result).toMatchObject({
    status: "error",
    error: { code: "DELEGATION_ARTIFACT_INVALID" },
  });
});

test("auth diagnostic policies redact delegation transport and nested target inputs", () => {
  const importCanary = "delegation-proof-token-jwk-canary";
  const requestCanary = "nested-target-input-canary";
  const importer = importDefinition();
  const requester = requestDefinition();
  const importDiagnostic = createSafeOperationDiagnostic(importer, {
    operation: { operationId: importer.id, operationVersion: importer.version },
    context: context().summary,
    input: {
      kind: "tinycloud.auth.delegation",
      delegation: { proof: importCanary, token: importCanary, jwk: importCanary },
    },
  });
  const requestDiagnostic = createSafeOperationDiagnostic(requester, {
    operation: { operationId: requester.id, operationVersion: requester.version },
    context: context().summary,
    input: {
      operationId: "tinycloud.test.get",
      operationVersion: 1,
      input: { credentials: { token: requestCanary } },
    },
  });

  expect(JSON.stringify({ importDiagnostic, requestDiagnostic })).not.toContain(importCanary);
  expect(JSON.stringify({ importDiagnostic, requestDiagnostic })).not.toContain(requestCanary);
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

test("imports a real signed hostless delegation idempotently and a fresh runtime replays only its signed authority", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const runtime = await runtimeContext(fixture.profile);
    const requestId = await createBoundRequest(runtime, fixture.hermetic.permissions);
    const delegation = await fixture.hermetic.mintDelegation();
    const hostlessDelegation = withoutDelegationHost(delegation);
    expect(hostlessDelegation.host).toBeUndefined();
    const importer = importDefinition();
    const artifact = {
      ...importArtifact(requestId, delegation),
      permissions: [{
        service: "tinycloud.kv",
        path: "display-only",
        actions: ["tinycloud.kv/*"],
      }],
    };

    const hostlessArtifact = {
      ...artifact,
      delegation: hostlessDelegation,
    };
    const first = await importer.execute(runtime, hostlessArtifact);
    const second = await importer.execute(runtime, hostlessArtifact);
    expect(first).toMatchObject({
      status: "ok",
      output: {
        cid: delegation.cid,
        effectivePermissions: canonicalizeCapabilities(fixture.hermetic.permissions),
        host: fixture.hermetic.host,
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

test("imports a real signed delegation with an explicit selected profile host", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const runtime = await runtimeContext(fixture.profile);
    const requestId = await createBoundRequest(runtime, fixture.hermetic.permissions);
    const delegation = await fixture.hermetic.mintDelegation();
    const explicitHostDelegation = { ...delegation, host: fixture.hermetic.host };

    const result = await importDefinition().execute(
      runtime,
      importArtifact(requestId, explicitHostDelegation),
    );

    expect(result).toMatchObject({
      status: "ok",
      output: {
        cid: delegation.cid,
        host: fixture.hermetic.host,
        activated: true,
        alreadyPresent: false,
      },
    });
    expect(await readAdditionalDelegations(fixture.profile)).toHaveLength(1);
  } finally {
    fixture.hermetic.stop();
  }
});

test("rejects a real hostless delegation when the stored request substitutes localhost for 127.0.0.1", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const runtime = await runtimeContext(fixture.profile);
    const requestId = await createBoundRequest(runtime, fixture.hermetic.permissions);
    const substitutedHost = fixture.hermetic.host.replace("127.0.0.1", "localhost");
    const requests = await readAuthRequestRecords(fixture.profile);
    await writeJsonAtomic(authRequestsPath(fixture.profile), requests.map((request) =>
      request.requestId === requestId ? { ...request, host: substitutedHost } : request,
    ));

    const node = runtime.runtime.node as {
      useRuntimeDelegation(delegation: unknown): Promise<void>;
    };
    const activate = node.useRuntimeDelegation.bind(node);
    let activationCalls = 0;
    node.useRuntimeDelegation = async (delegation) => {
      activationCalls += 1;
      await activate(delegation);
    };

    const delegation = await fixture.hermetic.mintDelegation();
    const result = await importDefinition().execute(
      runtime,
      importArtifact(requestId, withoutDelegationHost(delegation)),
    );

    expect(result).toMatchObject({
      status: "error",
      error: {
        code: "DELEGATION_HOST_MISMATCH",
        details: { expectedHost: fixture.hermetic.host, artifactHost: substitutedHost },
      },
    });
    expect(activationCalls).toBe(0);
    expect(await readAdditionalDelegations(fixture.profile)).toEqual([]);
  } finally {
    fixture.hermetic.stop();
  }
});

test("imports a real delegation against a minimal public node-sdk request record", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const runtime = await runtimeContext(fixture.profile);
    const requestId = "req_public_shape";
    await writeJsonAtomic(authRequestsPath(fixture.profile), [{
      kind: "tinycloud.auth.request",
      version: 1,
      requestId,
      sessionDid: fixture.sessionDid,
      requested: fixture.hermetic.permissions,
    }]);

    const result = await importDefinition().execute(
      runtime,
      importArtifact(requestId, await fixture.hermetic.mintDelegation()),
    );

    expect(result).toMatchObject({
      status: "ok",
      output: { cid: expect.any(String), activated: true },
    });
  } finally {
    fixture.hermetic.stop();
  }
});

test("imports only delegation authority contained by the exact stored request, including a valid subset", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const runtime = await runtimeContext(fixture.profile);
    const importer = importDefinition();
    const kvOnly = fixture.hermetic.permissions.filter((permission) =>
      permission.service === "tinycloud.kv",
    );
    const narrowRequest = await createBoundRequest(runtime, kvOnly);
    const broaderDelegation = await fixture.hermetic.mintDelegation();

    const broader = await importer.execute(runtime, importArtifact(narrowRequest, broaderDelegation));
    expect(broader).toMatchObject({ status: "error", error: { code: "DELEGATION_REJECTED" } });
    expect(await readAdditionalDelegations(fixture.profile)).toEqual([]);

    const fullRequest = await createBoundRequest(runtime, fixture.hermetic.permissions);
    const subsetDelegation = await fixture.hermetic.mintDelegationWithPermissions([...kvOnly]);
    const subset = await importer.execute(runtime, importArtifact(fullRequest, subsetDelegation));
    expect(subset).toMatchObject({
      status: "ok",
      output: {
        cid: subsetDelegation.cid,
        effectivePermissions: canonicalizeCapabilities(kvOnly),
        host: fixture.hermetic.host,
      },
    });
  } finally {
    fixture.hermetic.stop();
  }
});

test("rejects a stored request whose profile does not match the selected profile", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const runtime = await runtimeContext(fixture.profile);
    const requestId = await createBoundRequest(runtime, fixture.hermetic.permissions);
    const requests = await readAuthRequestRecords(fixture.profile);
    await writeJsonAtomic(authRequestsPath(fixture.profile), requests.map((request) =>
      request.requestId === requestId ? { ...request, profile: "other-profile" } : request,
    ));

    const result = await importDefinition().execute(
      runtime,
      importArtifact(requestId, await fixture.hermetic.mintDelegation()),
    );
    expect(result).toMatchObject({ status: "error", error: { code: "DELEGATION_ARTIFACT_INVALID" } });
    expect(await readAdditionalDelegations(fixture.profile)).toEqual([]);
  } finally {
    fixture.hermetic.stop();
  }
});

test("rechecks real on-disk session rotation before reporting import success", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const runtime = await runtimeContext(fixture.profile);
    const requestId = await createBoundRequest(runtime, fixture.hermetic.permissions);
    const node = runtime.runtime.node as {
      useRuntimeDelegation(delegation: unknown): Promise<void>;
    };
    const activate = node.useRuntimeDelegation.bind(node);
    node.useRuntimeDelegation = async (delegation) => {
      await activate(delegation);
      await writeJsonAtomic(sessionPath(fixture.profile), {
        ...fixture.hermetic.restorableSession,
        verificationMethod: fixture.hermetic.unrelatedAudience,
      });
    };

    const result = await importDefinition().execute(
      runtime,
      importArtifact(requestId, await fixture.hermetic.mintDelegation()),
    );

    expect(result).toMatchObject({
      status: "error",
      error: { code: "DELEGATION_AUDIENCE_MISMATCH" },
    });
    expect(await readAdditionalDelegations(fixture.profile)).toEqual([]);
  } finally {
    fixture.hermetic.stop();
  }
});

test("does not hold the production profile lock during delayed activation and rejects rotated state", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const runtime = await runtimeContext(fixture.profile);
    const requestId = await createBoundRequest(runtime, fixture.hermetic.permissions);
    const node = runtime.runtime.node as {
      useRuntimeDelegation(delegation: unknown): Promise<void>;
    };
    const activate = node.useRuntimeDelegation.bind(node);
    let activationStarted!: () => void;
    let releaseActivation!: () => void;
    const started = new Promise<void>((resolve) => { activationStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseActivation = resolve; });
    node.useRuntimeDelegation = async (delegation) => {
      activationStarted();
      await gate;
      await activate(delegation);
    };

    const importPromise = importDefinition().execute(
      runtime,
      importArtifact(requestId, await fixture.hermetic.mintDelegation()),
    );
    await started;

    let writerEntered = false;
    const writer = withProfileLock(fixture.profile, async () => {
      writerEntered = true;
      await writeJsonAtomic(sessionPath(fixture.profile), {
        ...fixture.hermetic.restorableSession,
        verificationMethod: fixture.hermetic.unrelatedAudience,
      });
    });
    await Promise.race([
      writer,
      new Promise((_, reject) => setTimeout(() => reject(new Error("profile writer blocked during activation")), 250)),
    ]);
    expect(writerEntered).toBe(true);

    releaseActivation();
    const result = await importPromise;
    expect(result).toMatchObject({ status: "error", error: { code: "DELEGATION_AUDIENCE_MISMATCH" } });
    expect(await readAdditionalDelegations(fixture.profile)).toEqual([]);
  } finally {
    fixture.hermetic.stop();
  }
});

test("serializes concurrent same-CID imports and reports accurate idempotency", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const runtime = await runtimeContext(fixture.profile);
    const requestId = await createBoundRequest(runtime, fixture.hermetic.permissions);
    const artifact = importArtifact(requestId, await fixture.hermetic.mintDelegation());
    const [first, second] = await Promise.all([
      importDefinition().execute(runtime, artifact),
      importDefinition().execute(runtime, artifact),
    ]);

    expect([first, second].map((result) => result.status)).toEqual(["ok", "ok"]);
    const alreadyPresent = [first, second].map((result) =>
      result.status === "ok" ? result.output.alreadyPresent : undefined,
    ).sort();
    expect(alreadyPresent).toEqual([false, true]);
    expect(await readAdditionalDelegations(fixture.profile)).toHaveLength(1);
  } finally {
    fixture.hermetic.stop();
  }
});

test("does not report a persistence failure as a delegation rejection", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const runtime = await runtimeContext(fixture.profile);
    const requestId = await createBoundRequest(runtime, fixture.hermetic.permissions);
    await writeJsonAtomic(
      profileStoreMetadataPath(fixture.profile, "additional-delegations"),
      { formatVersion: 2 },
    );

    const result = await importDefinition().execute(
      runtime,
      importArtifact(requestId, await fixture.hermetic.mintDelegation()),
    );

    expect(result).toMatchObject({ status: "error", error: { code: "INTERNAL_ERROR" } });
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
  planned: unknown = [capability],
): OperationDefinition<unknown, unknown> {
  return {
    id: "tinycloud.test.get",
    version: 1,
    title: "Test operation",
    description: "Test operation",
    input: z.object({ name: z.string() }),
    output: z.object({ value: z.string() }),
    effects: ["read"],
    runtime: "authenticated",
    postures: ["delegate-session"],
    exposure: {
      cli: { status: "required" },
      mcp: { status: "required" },
      skill: { status: "required" },
      docs: { status: "required" },
    },
    sensitivity: { input: [], output: [] },
    authority: async () => planned as never,
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

function withoutDelegationHost(delegation: StoredRuntimeDelegation): StoredRuntimeDelegation {
  const hostless = { ...delegation };
  delete (hostless as { host?: string }).host;
  return hostless;
}

async function readAuthRequestRecords(profile: string): Promise<Record<string, unknown>[]> {
  const records = await readJson<unknown>(authRequestsPath(profile));
  if (!Array.isArray(records)) throw new Error("expected authority request records");
  return records as Record<string, unknown>[];
}
