import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { jcsCanonicalize } from "@tinycloud/sdk-core/policy";
import { z } from "zod";

import type {
  InvocationTarget,
  OperationContext,
  OperationDefinition,
  OperationRuntimeRequirement,
  RuntimeOperationContext,
} from "./contract.js";
import { createSafeOperationDiagnostic } from "./redaction.js";
import * as artifacts from "./artifacts.js";
import { invokeOperation } from "./invoke.js";
import * as registry from "./registry.js";
import * as runtime from "./runtime.js";

type TestInput = {
  readonly name: string;
  readonly metadata?: Record<string, unknown>;
};
type TestOutput = { readonly value: string };

let definitions: readonly OperationDefinition<TestInput, TestOutput>[] = [];
let invocationTrace: string[] = [];
type RuntimeResolution =
  | { ok: true; context: RuntimeOperationContext }
  | { ok: false; context: RuntimeOperationContext["summary"]; error: { code: "PROFILE_NOT_FOUND"; message: string; retryable: false } };
let resolver: (
  target: InvocationTarget,
  requirement: OperationRuntimeRequirement,
) => Promise<RuntimeResolution>;

spyOn(registry, "lookupOperation").mockImplementation((operationId, operationVersion) => {
  const matchingId = definitions.filter((definition) => definition.id === operationId);
  if (matchingId.length === 0) return { status: "operation_not_found" };
  const definition = matchingId.find((candidate) => candidate.version === operationVersion);
  return definition === undefined
    ? {
        status: "operation_version_unsupported",
        supportedVersions: matchingId.map((candidate) => candidate.version),
      }
    : { status: "found", definition: definition as unknown as OperationDefinition<unknown, unknown> };
});

spyOn(runtime, "createInvocationRuntime").mockImplementation((
  target: InvocationTarget,
  requirement: OperationRuntimeRequirement = "authenticated",
) => resolver(target, requirement));

spyOn(artifacts, "createOrReusePermissionRequest").mockImplementation(async (input) => {
  invocationTrace.push("persist");
  return {
    status: "created",
    reused: false,
    request: {
      kind: "tinycloud.auth.request",
      version: 1,
      requestId: "request-1",
      createdAt: "2026-07-14T12:00:00.000Z",
      profile: "delegate",
      posture: "delegate-session",
      operatorType: "agent",
      host: "https://node.example",
      sessionDid: "did:key:session",
      requested: input.missing.map((permission) => ({
        ...permission,
        actions: [...permission.actions],
      })),
    },
  };
});

beforeEach(() => {
  definitions = [];
  invocationTrace = [];
  resolver = async () => ({
    ok: true,
    context: {
      summary: {
        profile: "delegate",
        host: "https://node.example",
        posture: "delegate-session",
        operatorType: "agent",
        principalDid: "did:key:principal",
        sessionDid: "did:key:session",
        ownerDid: "did:key:owner",
      },
      runtime: { node: {}, granted: [] },
    },
  });
});

afterAll(() => {
  mock.restore();
});

test("rejects an unknown operation before it attempts input parsing or context resolution", async () => {
  let resolvedContext = false;
  resolver = async () => {
    resolvedContext = true;
    throw new Error("unknown operations must not resolve context");
  };

  const result = await invokeOperation(
    "tinycloud.unknown.get",
    1,
    {},
    { malformed: true },
  );

  expect(result).toMatchObject({
    status: "error",
    error: { code: "OPERATION_NOT_FOUND" },
  });
  expect(resolvedContext).toBe(false);
});

test("rejects an unsupported operation version before it attempts input parsing or context resolution", async () => {
  definitions = [createDefinition()];
  let resolvedContext = false;
  resolver = async () => {
    resolvedContext = true;
    throw new Error("unsupported versions must not resolve context");
  };

  const result = await invokeOperation(
    "tinycloud.test.get",
    2,
    {},
    { malformed: true },
  );

  expect(result).toMatchObject({
    status: "error",
    error: {
      code: "OPERATION_VERSION_UNSUPPORTED",
      details: { supportedVersions: [1] },
    },
  });
  expect(resolvedContext).toBe(false);
});

test("validates unknown input before context resolution or executing a known operation", async () => {
  let executed = false;
  let resolvedContext = false;
  resolver = async () => {
    resolvedContext = true;
    throw new Error("invalid input must not resolve context");
  };
  definitions = [
    createDefinition({
      execute: async () => {
        executed = true;
        return { status: "ok", output: { value: "unreachable" } };
      },
    }),
  ];

  const result = await invokeOperation("tinycloud.test.get", 1, {}, { name: 42 });

  expect(result).toMatchObject({
    status: "error",
    error: { code: "INPUT_INVALID" },
  });
  expect(resolvedContext).toBe(false);
  expect(executed).toBe(false);
});

test("plans and persists exact missing authority before it can execute a handler", async () => {
  let handlerRan = false;
  resolver = async () => {
    invocationTrace.push("runtime");
    return {
      ok: true,
      context: {
        summary: {
          profile: "delegate",
          host: "https://node.example",
          posture: "delegate-session",
          operatorType: "agent",
          sessionDid: "did:key:session",
        },
        runtime: { node: {}, granted: [] },
      },
    };
  };
  definitions = [createDefinition({
    authority: async () => {
      invocationTrace.push("plan");
      return [testCapability];
    },
    execute: async () => {
      handlerRan = true;
      invocationTrace.push("handler");
      return { status: "ok", output: { value: "unreachable" } };
    },
  })];

  const result = await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" });

  expect(result.status).toBe("authority_required");
  expect(invocationTrace).toEqual(["runtime", "runtime", "plan", "persist"]);
  expect(handlerRan).toBe(false);
});

test("rejects broad, caveated, and malformed planner capability hints without persisting", async () => {
  const invalidRequirements: readonly unknown[] = [
    [{ ...testCapability, path: "vault/secrets/*" }],
    [{ ...testCapability, path: "/" }],
    [{ ...testCapability, path: "vault/secrets/" }],
    [{ ...testCapability, caveats: [{ tenant: "one" }] }],
    { not: "an array" },
  ];

  for (const requirement of invalidRequirements) {
    let handlerRan = false;
    definitions = [createDefinition({
      authority: async () => requirement as never,
      execute: async () => {
        handlerRan = true;
        return { status: "ok", output: { value: "unreachable" } };
      },
    })];

    const result = await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" });

    expect(result).toMatchObject({ status: "error", error: { code: "PERMISSION_HINT_INVALID" } });
    expect(handlerRan).toBe(false);
  }
  expect(invocationTrace).toEqual([]);
});

test("requires explicit opt-in before authenticating either owner posture", async () => {
  for (const posture of ["owner-openkey", "local-owner-key"] as const) {
    const requirements: OperationRuntimeRequirement[] = [];
    let planned = false;
    let executed = false;
    definitions = [createDefinition({
      postures: [posture],
      authority: async () => {
        planned = true;
        return [];
      },
      execute: async () => {
        executed = true;
        return { status: "ok", output: { value: "ok" } };
      },
    })];
    resolver = async (_target, requirement) => {
      requirements.push(requirement);
      return {
        ok: true,
        context: {
          summary: {
            profile: "owner",
            host: "https://node.example",
            posture,
            operatorType: "human",
          },
          runtime: { node: {}, granted: [] },
        },
      };
    };

    const blocked = await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" });
    expect(blocked).toMatchObject({ status: "error", error: { code: "PROFILE_OWNER_OPT_IN_REQUIRED" } });
    expect(requirements).toEqual(["inspection"]);
    expect(planned).toBe(false);
    expect(executed).toBe(false);

    const allowed = await invokeOperation(
      "tinycloud.test.get",
      1,
      { allowOwnerProfile: true },
      { name: "valid" },
    );
    expect(allowed).toMatchObject({ status: "ok", output: { value: "ok" } });
    expect(requirements).toEqual(["inspection", "inspection", "authenticated"]);
    expect(planned).toBe(true);
    expect(executed).toBe(true);
  }
});

test("fails closed when the authenticated resolution changes from inspection posture", async () => {
  definitions = [createDefinition({ postures: ["owner-openkey", "delegate-session", "local-owner-key"] })];
  let calls = 0;
  resolver = async (_target, requirement) => {
    calls += 1;
    const posture = requirement === "inspection" && calls === 1
      ? "delegate-session"
      : "local-owner-key";
    return {
      ok: true,
      context: {
        summary: {
          profile: "race",
          host: "https://node.example",
          posture,
          operatorType: "human",
          sessionDid: "did:key:session",
        },
        runtime: { node: {}, granted: [] },
      },
    };
  };

  const result = await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" });

  expect(result).toMatchObject({
    status: "error",
    context: { posture: "local-owner-key" },
    error: { code: "PROFILE_OWNER_OPT_IN_REQUIRED" },
  });
  expect(calls).toBe(2);
});

test("sanitizes malformed runtime permission hints without creating a broad request", async () => {
  definitions = [createDefinition({
    authority: async () => [testCapability],
    execute: async () => ({
      status: "authority_required",
      missing: [{ ...testCapability, path: "vault/secrets/*" }],
      request: { requestId: "ignored" },
      approval: { kind: "openkey", requestId: "ignored", fallback: "ignored" },
    }),
  })];
  resolver = async () => ({
    ok: true,
    context: {
      summary: {
        profile: "delegate",
        host: "https://node.example",
        posture: "delegate-session",
        operatorType: "agent",
        sessionDid: "did:key:session",
      },
      runtime: { node: {}, granted: [testCapability] },
    },
  });

  const result = await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" });

  expect(result).toMatchObject({ status: "error", error: { code: "PERMISSION_HINT_INVALID" } });
  expect(invocationTrace).toEqual([]);
});

test("returns a safe error envelope for invalid invocation targets", async () => {
  const canary = "invocation-target-private-canary";
  const invalidTargets: readonly Readonly<{ name: string; target: unknown }>[] = [
    { name: "null", target: null },
    { name: "primitive", target: "not-an-invocation-target" },
    { name: "invalid field", target: { profile: 1 } },
    {
      name: "throwing getter",
      target: {
        get profile() {
          throw new Error(canary);
        },
      },
    },
    {
      name: "throwing proxy",
      target: new Proxy({}, {
        get() {
          throw new Error(canary);
        },
      }),
    },
    {
      name: "private key getter",
      target: {
        profile: "pinned-profile",
        get privateKey() {
          throw new Error(canary);
        },
      },
    },
  ];

  for (const { name, target } of invalidTargets) {
    const result = await invokeOperation(
      "tinycloud.test.get",
      1,
      target as InvocationTarget,
      { name: "valid" },
    );

    expect(result, name).toEqual({
      status: "error",
      operation: {
        operationId: "tinycloud.test.get",
        operationVersion: 1,
      },
      context: {
        profile: "unresolved",
        host: "unresolved",
        posture: "unauthenticated",
      },
      error: {
        code: "INPUT_INVALID",
        message: "The invocation target is invalid.",
        retryable: false,
      },
    });
    expect(JSON.stringify(result), name).not.toContain(canary);
  }
});

test("returns a safe PROFILE_NOT_FOUND result for a deleted pinned profile", async () => {
  definitions = [createDefinition()];
  resolver = async () => ({
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

  const result = await invokeOperation(
    "tinycloud.test.get",
    1,
    { profile: "deleted" },
    { name: "valid" },
  );

  expect(result).toEqual({
    status: "error",
    operation: {
      operationId: "tinycloud.test.get",
      operationVersion: 1,
    },
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

test("validates successful handler output", async () => {
  definitions = [
    createDefinition({
      execute: async () => ({ status: "ok", output: { value: 42 } } as never),
    }),
  ];

  const result = await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" });

  expect(result).toMatchObject({
    status: "error",
    error: { code: "OUTPUT_INVALID" },
  });
});

test("sanitizes unexpected handler exceptions", async () => {
  const canary = "private-handler-canary";
  definitions = [
    createDefinition({
      execute: async () => {
        throw new Error(`unexpected failure: ${canary}`);
      },
    }),
  ];

  const result = await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" });

  expect(result).toMatchObject({
    status: "error",
    error: {
      code: "INTERNAL_ERROR",
      message: "The operation could not be completed.",
    },
  });
  expect(JSON.stringify(result)).not.toContain(canary);
});

test("returns the four canonical operation outcomes", async () => {
  const outcomes = [
    createDefinition({ execute: async () => ({ status: "ok", output: { value: "ok" } }) }),
    createDefinition({
      authority: async () => [testCapability],
      execute: async () => ({
        status: "authority_required",
        missing: [testCapability],
        request: { requestId: "request-1" },
        approval: { kind: "openkey", requestId: "request-1", fallback: "tc auth grant" },
      }),
    }),
    createDefinition({
      execute: async () => ({
        status: "setup_required",
        setup: { kind: "secret_manager", url: "https://secrets.tinycloud.xyz" },
      }),
    }),
    createDefinition({
      execute: async () => ({
        status: "error",
        error: { code: "SESSION_NOT_FOUND", message: "No session.", retryable: true },
      }),
    }),
  ];

  const statuses: string[] = [];
  for (const definition of outcomes) {
    definitions = [definition];
    resolver = async () => ({
      ok: true,
      context: {
        summary: {
          profile: "delegate",
          host: "https://node.example",
          posture: "delegate-session",
          operatorType: "agent",
          sessionDid: "did:key:session",
        },
        runtime: {
          node: {},
          granted: definition === outcomes[1] ? [testCapability] : [],
        },
      },
    });
    const result = await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" });
    statuses.push(result.status);
  }

  expect(statuses).toEqual(["ok", "authority_required", "setup_required", "error"]);
});

test("uses RFC 8785 astral/BMP key ordering for retry digests", async () => {
  const supplementary = "\u{10000}";
  const privateUse = "\ue000";
  definitions = [
    createDefinition({
      authority: async () => [testCapability],
      execute: async () => ({
        status: "authority_required",
        missing: [testCapability],
        request: { requestId: "request-1" },
        approval: { kind: "openkey", requestId: "request-1", fallback: "tc auth grant" },
      }),
    }),
  ];
  resolver = async () => ({
    ok: true,
    context: {
      summary: {
        profile: "delegate",
        host: "https://node.example",
        posture: "delegate-session",
        operatorType: "agent",
        sessionDid: "did:key:session",
      },
      runtime: { node: {}, granted: [testCapability] },
    },
  });

  const first = await invokeOperation("tinycloud.test.get", 1, {}, {
    name: "valid",
    metadata: { [privateUse]: 2, [supplementary]: 1, b: 2, a: 1 },
  });
  const second = await invokeOperation("tinycloud.test.get", 1, {}, {
    metadata: { a: 1, b: 2, [supplementary]: 1, [privateUse]: 2 },
    name: "valid",
  });

  expect(first.status).toBe("authority_required");
  expect(second.status).toBe("authority_required");
  if (first.status !== "authority_required" || second.status !== "authority_required") {
    throw new Error("expected retry descriptors");
  }
  expect(first.retry.inputDigest).toBe(second.retry.inputDigest);
  expect(first.retry.inputDigest).toBe(
    "4f5260790930e280d38949139664cdca06890aae14708530fe412c1effd6d64a",
  );
});

test("keeps the CLI private-key override out of all kernel-safe channels", async () => {
  const privateKeyCanary = "0xprivate-key-canary";
  let targetSeenByProfile: InvocationTarget | undefined;
  let handlerContext: OperationContext | undefined;
  const persistedStateProbe: Record<string, unknown> = {};

  resolver = async (target) => {
    targetSeenByProfile = target;
    const resolution: RuntimeResolution = {
      ok: true as const,
      context: {
        summary: {
          profile: "delegate",
          host: "https://node.example",
          posture: "delegate-session",
          operatorType: "agent" as const,
          sessionDid: "did:key:session",
        },
        runtime: { node: {}, granted: [testCapability] },
      },
    };
    // The only state-shaped value the kernel can retain is the resolved safe summary.
    persistedStateProbe.context = resolution.context;
    return resolution;
  };
  definitions = [
    createDefinition({
      authority: async () => [testCapability],
      execute: async (context) => {
        handlerContext = context;
        return {
          status: "authority_required",
          missing: [testCapability],
          request: { requestId: "request-1" },
          approval: { kind: "openkey", requestId: "request-1", fallback: "tc auth grant" },
        };
      },
    }),
  ];

  const result = await invokeOperation(
    "tinycloud.test.get",
    1,
    {
      profile: "delegate",
      host: "https://node.example",
      allowOwnerProfile: true,
      privateKey: privateKeyCanary,
      ...({ node: "forbidden", grants: ["forbidden"] } as Record<string, unknown>),
    } as InvocationTarget,
    { name: "valid" },
  );

  expect(targetSeenByProfile).toEqual({
    profile: "delegate",
    host: "https://node.example",
    allowOwnerProfile: true,
    privateKey: privateKeyCanary,
  });
  expect(handlerContext).toMatchObject({
    summary: {
      profile: "delegate",
      host: "https://node.example",
      posture: "delegate-session",
      operatorType: "agent",
    },
  });

  const diagnostic = createSafeOperationDiagnostic(definitions[0]!, {
    operation: result.operation,
    context: result.context,
    input: { name: "valid" },
    output: { value: "safe" },
  });
  const safeChannels = {
    retry: result.status === "authority_required" ? result.retry : undefined,
    context: result.context,
    genericError: result.status === "error" ? result.error : undefined,
    diagnostic,
    persistedStateProbe,
  };

  expect(JSON.stringify(safeChannels)).not.toContain(privateKeyCanary);
});

test("package root exports only registry-keyed invocation", async () => {
  const packageRoot = await import("./index.js");
  expect(Object.keys(packageRoot)).toEqual(["invokeOperation"]);
});

function createDefinition(
  overrides: Partial<OperationDefinition<TestInput, TestOutput>> = {},
): OperationDefinition<TestInput, TestOutput> {
  return {
    id: "tinycloud.test.get",
    version: 1,
    title: "Test get",
    description: "A synthetic definition confined to this test module.",
    input: z.object({
      name: z.string(),
      metadata: z.record(z.unknown()).optional(),
    }),
    output: z.object({ value: z.string() }),
    effects: ["read"],
    postures: [
      "owner-openkey",
      "delegate-session",
      "local-owner-key",
      "unauthenticated",
    ],
    exposure: {
      cli: { status: "required" },
      mcp: { status: "required" },
      skill: { status: "required" },
      docs: { status: "required" },
    },
    sensitivity: { input: [], output: [] },
    authority: async () => [],
    execute: async () => ({ status: "ok", output: { value: "ok" } }),
    ...overrides,
    runtime: overrides.runtime ?? "authenticated",
  };
}

const testCapability = {
  service: "tinycloud.kv",
  space: "secrets",
  path: "vault/secrets/API_KEY",
  actions: ["tinycloud.kv/get"],
};
