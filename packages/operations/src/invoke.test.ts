import { beforeEach, expect, mock, test } from "bun:test";
import { z } from "zod";

import type {
  InvocationTarget,
  OperationContext,
  OperationDefinition,
} from "./contract.js";
import { createSafeOperationDiagnostic } from "./redaction.js";
import type { InvocationContextResolution } from "./profile.js";
import { jcsCanonicalize } from "../../sdk-core/src/policy/jcs.js";

type TestInput = {
  readonly name: string;
  readonly metadata?: Record<string, unknown>;
};
type TestOutput = { readonly value: string };

let definitions: readonly OperationDefinition<unknown, unknown>[] = [];
let resolver: (target: InvocationTarget) => Promise<InvocationContextResolution>;

mock.module("@tinycloud/sdk-core/policy", () => ({ jcsCanonicalize }));

mock.module("./registry.js", () => ({
  lookupOperation(operationId: string, operationVersion: number) {
    const matchingId = definitions.filter((definition) => definition.id === operationId);
    if (matchingId.length === 0) {
      return { status: "operation_not_found" };
    }
    const definition = matchingId.find(
      (candidate) => candidate.version === operationVersion,
    );
    return definition === undefined
      ? {
          status: "operation_version_unsupported",
          supportedVersions: matchingId.map((candidate) => candidate.version),
        }
      : { status: "found", definition };
  },
}));

mock.module("./profile.js", () => ({
  resolveInvocationContext(target: InvocationTarget) {
    return resolver(target);
  },
}));

const { invokeOperation } = await import("./invoke.js");

beforeEach(() => {
  definitions = [];
  resolver = async () => ({
    ok: true,
    context: {
      profile: "delegate",
      host: "https://node.example",
      posture: "delegate-session",
      operatorType: "agent",
      principalDid: "did:key:principal",
      sessionDid: "did:key:session",
      ownerDid: "did:key:owner",
    },
  });
});

test("rejects an unknown operation before it attempts input parsing", async () => {
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
});

test("rejects an unsupported operation version before it attempts input parsing", async () => {
  definitions = [createDefinition()];

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
});

test("validates unknown input before executing a known operation", async () => {
  let executed = false;
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
  expect(executed).toBe(false);
});

test("returns a safe PROFILE_NOT_FOUND result for a deleted pinned profile", async () => {
  definitions = [createDefinition()];
  resolver = async () => ({
    ok: false,
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
      execute: async () => ({
        status: "authority_required",
        missing: [{ capability: "tinycloud.kv/get" }],
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
      execute: async () => ({
        status: "authority_required",
        missing: [],
        request: { requestId: "request-1" },
        approval: { kind: "openkey", requestId: "request-1", fallback: "tc auth grant" },
      }),
    }),
  ];

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
    const resolution = {
      ok: true as const,
      context: {
        profile: "delegate",
        host: "https://node.example",
        posture: "delegate-session",
        operatorType: "agent" as const,
      },
    };
    // The only state-shaped value the kernel can retain is the resolved safe summary.
    persistedStateProbe.context = resolution.context;
    return resolution;
  };
  definitions = [
    createDefinition({
      execute: async (context) => {
        handlerContext = context;
        return {
          status: "authority_required",
          missing: [],
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
  expect(handlerContext).toEqual({
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
  };
}
