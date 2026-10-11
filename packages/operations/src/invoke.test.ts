import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { jcsCanonicalize } from "@tinycloud/sdk-core/policy";
import { z } from "zod";

import type {
  InvocationTarget,
  OperationContext,
  OperationDefinition,
  OperationResult,
  OperationRuntimeRequirement,
  RuntimeOperationContext,
} from "./contract.js";
import type { OperationError } from "./errors.js";
import { createSafeOperationDiagnostic } from "./redaction.js";
import * as artifacts from "./artifacts.js";
import { invokeOperation } from "./invoke.js";
import * as registry from "./registry.js";
import * as runtime from "./runtime.js";
import { migrationRecovery, signInRecovery } from "./recovery.js";
import { secretsGetOperationDefinition } from "./operations/secrets-get.js";
import { secretsStatusOperationDefinition } from "./operations/secrets-status.js";
import { profileConfigPath, writeJsonAtomic } from "./state.js";

type TestInput = {
  readonly name: string;
  readonly metadata?: Record<string, unknown>;
};
type TestOutput = { readonly value: string };

let definitions: readonly OperationDefinition<TestInput, TestOutput>[] = [];
let invocationTrace: string[] = [];
type RuntimeResolution =
  | { ok: true; context: RuntimeOperationContext }
  | {
      ok: false;
      context: RuntimeOperationContext["summary"];
      error: { code: "PROFILE_NOT_FOUND"; message: string; retryable: false };
    };
let resolver: (
  target: InvocationTarget,
  requirement: OperationRuntimeRequirement,
) => Promise<RuntimeResolution>;

spyOn(registry, "lookupOperation").mockImplementation(
  (operationId, operationVersion) => {
    const matchingId = definitions.filter(
      (definition) => definition.id === operationId,
    );
    if (matchingId.length === 0) return { status: "operation_not_found" };
    const definition = matchingId.find(
      (candidate) => candidate.version === operationVersion,
    );
    return definition === undefined
      ? {
          status: "operation_version_unsupported",
          supportedVersions: matchingId.map((candidate) => candidate.version),
        }
      : {
          status: "found",
          definition: definition as unknown as OperationDefinition<
            unknown,
            unknown
          >,
        };
  },
);

const actualCreateInvocationRuntime = runtime.createInvocationRuntime;
spyOn(runtime, "createInvocationRuntime").mockImplementation(
  (
    target: InvocationTarget,
    requirement: OperationRuntimeRequirement = "authenticated",
  ) => resolver(target, requirement),
);

spyOn(artifacts, "createOrReusePermissionRequest").mockImplementation(
  async (input) => {
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
  },
);

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

  const result = await invokeOperation(
    "tinycloud.test.get",
    1,
    {},
    { name: 42 },
  );

  expect(result).toMatchObject({
    status: "error",
    error: { code: "INPUT_INVALID" },
  });
  expect(resolvedContext).toBe(false);
  expect(executed).toBe(false);
});

test("invoke-level invalid input diagnostics omit attacker-controlled issue details", async () => {
  const canary = "Bearer-private-auth-token-canary";
  definitions = [
    createDefinition({
      input: z.object({ name: z.string() }).strict(),
    }),
  ];

  const result = await invokeOperation(
    "tinycloud.test.get",
    1,
    {},
    { name: "valid", [canary]: canary },
  );

  expect(result).toMatchObject({
    status: "error",
    error: {
      code: "INPUT_INVALID",
      details: { issues: [{ code: "unrecognized_keys" }] },
    },
  });
  expect(JSON.stringify(result)).not.toContain(canary);
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
  definitions = [
    createDefinition({
      authority: async () => {
        invocationTrace.push("plan");
        return [testCapability];
      },
      execute: async () => {
        handlerRan = true;
        invocationTrace.push("handler");
        return { status: "ok", output: { value: "unreachable" } };
      },
    }),
  ];

  const result = await invokeOperation(
    "tinycloud.test.get",
    1,
    {},
    { name: "valid" },
  );

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
    definitions = [
      createDefinition({
        authority: async () => requirement as never,
        execute: async () => {
          handlerRan = true;
          return { status: "ok", output: { value: "unreachable" } };
        },
      }),
    ];

    const result = await invokeOperation(
      "tinycloud.test.get",
      1,
      {},
      { name: "valid" },
    );

    expect(result).toMatchObject({
      status: "error",
      error: { code: "PERMISSION_HINT_INVALID" },
    });
    expect(handlerRan).toBe(false);
  }
  expect(invocationTrace).toEqual([]);
});

test("requires explicit opt-in before authenticating either owner posture", async () => {
  for (const posture of ["owner-openkey", "local-owner-key"] as const) {
    const requirements: OperationRuntimeRequirement[] = [];
    let planned = false;
    let executed = false;
    definitions = [
      createDefinition({
        postures: [posture],
        authority: async () => {
          planned = true;
          return [];
        },
        execute: async () => {
          executed = true;
          return { status: "ok", output: { value: "ok" } };
        },
      }),
    ];
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

    const blocked = await invokeOperation(
      "tinycloud.test.get",
      1,
      {},
      { name: "valid" },
    );
    expect(blocked).toMatchObject({
      status: "error",
      error: { code: "PROFILE_OWNER_OPT_IN_REQUIRED" },
    });
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
  definitions = [
    createDefinition({
      postures: ["owner-openkey", "delegate-session", "local-owner-key"],
    }),
  ];
  let calls = 0;
  resolver = async (_target, requirement) => {
    calls += 1;
    const posture =
      requirement === "inspection" && calls === 1
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

  const result = await invokeOperation(
    "tinycloud.test.get",
    1,
    {},
    { name: "valid" },
  );

  expect(result).toMatchObject({
    status: "error",
    context: { posture: "local-owner-key" },
    error: { code: "PROFILE_OWNER_OPT_IN_REQUIRED" },
  });
  expect(calls).toBe(2);
});

test("rejects incoherent local owner material before invocation can sign in or execute", async () => {
  const home = await mkdtemp(
    `${tmpdir()}/tinycloud-operations-invoke-posture-`,
  );
  const previousHome = process.env.TC_HOME;
  process.env.TC_HOME = home;
  let handlerRan = false;
  const signIn = spyOn(TinyCloudNode.prototype, "signIn").mockImplementation(
    async () => {
      throw new Error("owner sign-in must not be reached");
    },
  );
  definitions = [
    createDefinition({
      authority: async () => [],
      execute: async () => {
        handlerRan = true;
        return { status: "ok", output: { value: "must-not-run" } };
      },
    }),
  ];
  resolver = async (target, requirement) =>
    (await actualCreateInvocationRuntime(
      target,
      requirement,
    )) as RuntimeResolution;

  try {
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

    const result = await invokeOperation(
      "tinycloud.test.get",
      1,
      { profile: "incoherent" },
      { name: "valid" },
    );

    expect(result).toMatchObject({
      status: "error",
      context: { profile: "incoherent", posture: "unauthenticated" },
      error: { code: "PROFILE_NOT_FOUND" },
    });
    expect(signIn).not.toHaveBeenCalled();
    expect(handlerRan).toBe(false);
  } finally {
    signIn.mockRestore();
    if (previousHome === undefined) delete process.env.TC_HOME;
    else process.env.TC_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("sanitizes malformed runtime permission hints without creating a broad request", async () => {
  definitions = [
    createDefinition({
      authority: async () => [testCapability],
      execute: async () => ({
        status: "authority_required",
        missing: [{ ...testCapability, path: "vault/secrets/*" }],
        request: { requestId: "ignored" },
        approval: {
          kind: "openkey",
          requestId: "ignored",
          fallback: "ignored",
        },
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

  const result = await invokeOperation(
    "tinycloud.test.get",
    1,
    {},
    { name: "valid" },
  );

  expect(result).toMatchObject({
    status: "error",
    error: { code: "PERMISSION_HINT_INVALID" },
  });
  expect(invocationTrace).toEqual([]);
});

test("returns a safe error envelope for invalid invocation targets", async () => {
  const canary = "invocation-target-private-canary";
  const invalidTargets: readonly Readonly<{ name: string; target: unknown }>[] =
    [
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
        target: new Proxy(
          {},
          {
            get() {
              throw new Error(canary);
            },
          },
        ),
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
      execute: async () => ({ status: "ok", output: { value: 42 } }) as never,
    }),
  ];

  const result = await invokeOperation(
    "tinycloud.test.get",
    1,
    {},
    { name: "valid" },
  );

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

  const result = await invokeOperation(
    "tinycloud.test.get",
    1,
    {},
    { name: "valid" },
  );

  expect(result).toMatchObject({
    status: "error",
    error: {
      code: "INTERNAL_ERROR",
      message: "The operation could not be completed.",
    },
  });
  expect(JSON.stringify(result)).not.toContain(canary);
});

test("canonical invocation preserves safe delegation mismatch details in results and diagnostics", async () => {
  const transportCanary = "raw-delegation-auth-token-jwk-canary";
  const expectedHost = "https://expected.example";
  const artifactHost = "https://artifact.example";
  const expectedSessionDid =
    "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
  const artifactAudience =
    "did:pkh:eip155:1:0x2222222222222222222222222222222222222222";
  const definition = createDefinition({
    sensitivity: { input: [""], output: [] },
    execute: async (_context, input) =>
      ({
        status: "error",
        error: {
          code:
            input.name === "host"
              ? "DELEGATION_HOST_MISMATCH"
              : "DELEGATION_AUDIENCE_MISMATCH",
          message: "The delegation does not match the selected runtime.",
          retryable: false,
          details:
            input.name === "host"
              ? {
                  expectedHost,
                  artifactHost,
                  delegationHeader: transportCanary,
                  target: { token: transportCanary },
                }
              : {
                  expectedSessionDid,
                  artifactAudience,
                  jwk: transportCanary,
                  target: { input: transportCanary },
                },
        },
      }) as never,
  });
  definitions = [definition];

  for (const input of [{ name: "host" }, { name: "audience" }]) {
    const result = await invokeOperation("tinycloud.test.get", 1, {}, input);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected an error result");

    if (input.name === "host") {
      expect(result.error).toMatchObject({
        details: { expectedHost, artifactHost },
      });
    } else {
      expect(result.error).toMatchObject({
        details: { expectedSessionDid, artifactAudience },
      });
    }
    expect(JSON.stringify(result)).not.toContain(transportCanary);

    const diagnostic = createSafeOperationDiagnostic(definition, {
      operation: result.operation,
      context: result.context,
      input: {
        delegation: { authorization: transportCanary, jwk: transportCanary },
      },
      error: result.error,
    });
    expect(JSON.stringify(diagnostic)).not.toContain(transportCanary);
    expect(diagnostic.error).toEqual(result.error);
  }

  const canary = "raw-jwk-private-key-canary";
  definitions = [
    createDefinition({
      execute: async () =>
        ({
          status: "error",
          error: {
            code: "DELEGATION_HOST_MISMATCH",
            message: "The delegation does not match the selected runtime.",
            retryable: false,
            details: {
              expectedHost: `https://user:pass@safe.example/path?token=${canary}`,
              artifactHost: canary,
            },
          },
        }) as never,
    }),
  ];
  const hostile = await invokeOperation(
    "tinycloud.test.get",
    1,
    {},
    { name: "valid" },
  );
  expect(hostile).toMatchObject({
    status: "error",
    error: { code: "DELEGATION_HOST_MISMATCH" },
  });
  expect(
    hostile.status === "error" ? hostile.error.details : undefined,
  ).toBeUndefined();
  expect(JSON.stringify(hostile)).not.toContain(canary);
});

test("returns the four canonical operation outcomes", async () => {
  const outcomes = [
    createDefinition({
      execute: async () => ({ status: "ok", output: { value: "ok" } }),
    }),
    createDefinition({
      authority: async () => [testCapability],
      execute: async () => ({
        status: "authority_required",
        missing: [testCapability],
        request: { requestId: "request-1" },
        approval: {
          kind: "openkey",
          requestId: "request-1",
          fallback: "tc auth grant",
        },
      }),
    }),
    createDefinition({
      execute: async () => ({
        status: "setup_required",
        setup: {
          kind: "secret_manager",
          action: "add_secret",
          url: "https://secrets.tinycloud.xyz/request?owner=did%3Apkh%3Aeip155%3A1%3A0x1111111111111111111111111111111111111111&name=API_KEY&v=1",
          names: ["API_KEY"],
          owner: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
          secret: { name: "API_KEY", space: "secrets" },
          message: "Ask the owner to add this secret in Secret Manager, then retry the operation.",
        },
      }),
    }),
    createDefinition({
      execute: async () => ({
        status: "error",
        error: {
          code: "SESSION_NOT_FOUND",
          message: "No session.",
          retryable: true,
        },
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
    const result = await invokeOperation(
      "tinycloud.test.get",
      1,
      {},
      { name: "valid" },
    );
    statuses.push(result.status);
  }

  expect(statuses).toEqual([
    "ok",
    "authority_required",
    "setup_required",
    "error",
  ]);
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
        approval: {
          kind: "openkey",
          requestId: "request-1",
          fallback: "tc auth grant",
        },
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

  const first = await invokeOperation(
    "tinycloud.test.get",
    1,
    {},
    {
      name: "valid",
      metadata: { [privateUse]: 2, [supplementary]: 1, b: 2, a: 1 },
    },
  );
  const second = await invokeOperation(
    "tinycloud.test.get",
    1,
    {},
    {
      metadata: { a: 1, b: 2, [supplementary]: 1, [privateUse]: 2 },
      name: "valid",
    },
  );

  expect(first.status).toBe("authority_required");
  expect(second.status).toBe("authority_required");
  if (
    first.status !== "authority_required" ||
    second.status !== "authority_required"
  ) {
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
          approval: {
            kind: "openkey",
            requestId: "request-1",
            fallback: "tc auth grant",
          },
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
      ...({ node: "forbidden", grants: ["forbidden"] } as Record<
        string,
        unknown
      >),
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

const STATUS_OWNER = "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412";

/** One kv-probing node for the real status definition: every probe returns `probe()`. */
function statusNode(probe: () => unknown = () => ({ ok: true, data: "ciphertext" })) {
  return { kvForSpace: () => ({ get: async () => probe() }) };
}

function restoredSummary(posture: "delegate-session" | "owner-openkey" | "local-owner-key", profile = "agent") {
  return {
    profile,
    host: "https://node.example",
    posture,
    operatorType: posture === "delegate-session" ? "agent" as const : "human" as const,
    sessionDid: "did:key:session",
    ...(posture === "delegate-session" ? { principalDid: "did:key:session", ownerDid: STATUS_OWNER } : { principalDid: STATUS_OWNER }),
  };
}

function useStatusDefinition(): void {
  definitions = [secretsStatusOperationDefinition as unknown as OperationDefinition<TestInput, TestOutput>];
}

test("S2-T8(a) the registered status operation dispatches restored, never authenticated", async () => {
  useStatusDefinition();
  const requirements: OperationRuntimeRequirement[] = [];
  resolver = async (_target, requirement) => {
    requirements.push(requirement);
    return { ok: true, context: { summary: restoredSummary("delegate-session"), runtime: { node: statusNode(), granted: [] } } };
  };
  const result = await invokeOperation("tinycloud.secrets.status", 1, {}, { names: ["A"] });
  expect(result).toMatchObject({ status: "ok", output: { status: "ready" } });
  expect(requirements).toEqual(["inspection", "restored"]);
  expect(requirements).not.toContain("authenticated");

  const fixtureRequirements: OperationRuntimeRequirement[] = [];
  definitions = [createDefinition({ runtime: "restored" })];
  resolver = async (_target, requirement) => {
    fixtureRequirements.push(requirement);
    return { ok: true, context: { summary: restoredSummary("delegate-session"), runtime: { node: {}, granted: [] } } };
  };
  expect(await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" })).toMatchObject({ status: "ok" });
  expect(fixtureRequirements).toEqual(["inspection", "restored"]);
});

test("S2-T8(b) a restored owner-profile operation needs the explicit owner opt-in before runtime resolution", async () => {
  for (const posture of ["owner-openkey", "local-owner-key"] as const) {
    const requirements: OperationRuntimeRequirement[] = [];
    let executed = false;
    definitions = [createDefinition({
      runtime: "restored",
      postures: [posture],
      execute: async () => {
        executed = true;
        return { status: "ok", output: { value: "ok" } };
      },
    })];
    resolver = async (_target, requirement) => {
      requirements.push(requirement);
      return { ok: true, context: { summary: restoredSummary(posture, "owner"), runtime: { node: {}, granted: [] } } };
    };

    expect(await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" })).toMatchObject({
      status: "error",
      error: { code: "PROFILE_OWNER_OPT_IN_REQUIRED" },
    });
    expect(requirements).toEqual(["inspection"]);
    expect(executed).toBe(false);

    expect(await invokeOperation("tinycloud.test.get", 1, { allowOwnerProfile: true }, { name: "valid" }))
      .toMatchObject({ status: "ok", output: { value: "ok" } });
    expect(requirements).toEqual(["inspection", "inspection", "restored"]);
    expect(executed).toBe(true);
  }
});

test("S2-T8(c) a restored resolution that changes posture from inspection fails closed before execute", async () => {
  for (const [postures, code] of [
    [["delegate-session", "local-owner-key"], "PROFILE_OWNER_OPT_IN_REQUIRED"],
    [["delegate-session"], "PROFILE_POSTURE_NOT_ALLOWED"],
  ] as const) {
    let executed = false;
    definitions = [createDefinition({
      runtime: "restored",
      postures,
      execute: async () => {
        executed = true;
        return { status: "ok", output: { value: "ok" } };
      },
    })];
    resolver = async (_target, requirement) => ({
      ok: true,
      context: {
        summary: restoredSummary(requirement === "inspection" ? "delegate-session" : "local-owner-key", "race"),
        runtime: { node: {}, granted: [] },
      },
    });
    expect(await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" })).toMatchObject({
      status: "error",
      error: { code },
    });
    expect(executed).toBe(false);
  }
});

test("S2-T5 a definition deadline returns a retryable NODE_UNREACHABLE while the stalled runtime is abandoned", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let rejectStalled: (error: Error) => void = () => {};
  try {
    definitions = [createDefinition({ deadlineMs: 200 })];
    resolver = (_target, requirement) => requirement === "inspection"
      ? Promise.resolve({ ok: true, context: { summary: restoredSummary("delegate-session"), runtime: { node: {}, granted: [] } } })
      : new Promise((_resolve, reject) => { rejectStalled = reject; });
    const started = performance.now();
    const result = await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" });
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({
      status: "error",
      operation: { operationId: "tinycloud.test.get", operationVersion: 1 },
      error: { code: "NODE_UNREACHABLE", retryable: true, message: "The operation did not finish within 0.2 s." },
    });
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(300);

    // The abandoned work finally fails: nothing reports an unhandled rejection.
    rejectStalled(new Error("stalled replay failed"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toEqual([]);

    // Without a deadline the same slow runtime is awaited as before.
    definitions = [createDefinition()];
    resolver = (_target, requirement) => new Promise((resolve) => setTimeout(() => resolve({
      ok: true,
      context: { summary: restoredSummary("delegate-session"), runtime: { node: {}, granted: [] } },
    }), requirement === "inspection" ? 0 : 300));
    expect(await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" })).toMatchObject({
      status: "ok",
      output: { value: "ok" },
    });
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("S2-T10(a) a plain 401 status probe keeps the delegate sign-in recovery on the final envelope", async () => {
  useStatusDefinition();
  resolver = async () => ({
    ok: true,
    context: {
      summary: restoredSummary("delegate-session"),
      runtime: { node: statusNode(() => ({ ok: false, error: { code: "AUTH_UNAUTHORIZED", service: "kv", meta: { status: 401 } } })), granted: [] },
    },
  });
  const result = await invokeOperation("tinycloud.secrets.status", 1, { profile: "agent" }, { names: ["A"] });
  expect(result).toMatchObject({ status: "error", error: { code: "AUTH_REQUIRED" } });
  expect(errorOf(result).details).toEqual({
    recovery: {
      action: "sign_in",
      command: "tc --profile agent auth login --method openkey --paste --manifest <manifest.json>",
    },
  });
});

test("S2-T10(b) owner reasons survive on INPUT_INVALID next to the existing issues policy", async () => {
  useStatusDefinition();
  resolver = async () => ({
    ok: true,
    context: { summary: restoredSummary("delegate-session"), runtime: { node: statusNode(), granted: [] } },
  });
  const mismatch = await invokeOperation("tinycloud.secrets.status", 1, {}, {
    names: ["A"],
    owner: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
  });
  expect(errorOf(mismatch)).toMatchObject({ code: "INPUT_INVALID" });
  expect(errorOf(mismatch).details).toEqual({ reason: "OWNER_MISMATCH" });

  resolver = async () => ({
    ok: true,
    context: {
      summary: { profile: "agent", host: "https://node.example", posture: "delegate-session", sessionDid: "did:key:session", principalDid: "did:key:session" },
      runtime: { node: statusNode(), granted: [] },
    },
  });
  const unknown = await invokeOperation("tinycloud.secrets.status", 1, {}, { names: ["A"] });
  expect(errorOf(unknown).details).toEqual({ reason: "OWNER_DID_UNKNOWN" });

  definitions = [createDefinition({
    execute: async () => ({
      status: "error",
      error: { code: "INPUT_INVALID", message: "Invalid.", retryable: false, details: { issues: [{ code: "custom", message: "leak" }], reason: "OWNER_MISMATCH" } },
    }),
  })];
  const both = await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" });
  expect(errorOf(both).details).toEqual({ issues: [{ code: "custom" }], reason: "OWNER_MISMATCH" });
});

test("S2-T10(c) runtime-preparation errors pass the same allowlist", async () => {
  useStatusDefinition();
  const cases = [
    {
      error: { code: "SESSION_NOT_FOUND", message: "No session.", retryable: false, details: { recovery: signInRecovery("agent", "delegate-session"), path: "/home/x" } },
      details: { recovery: { action: "sign_in", command: "tc --profile agent auth login --method openkey --paste --manifest <manifest.json>" } },
    },
    {
      error: { code: "PROFILE_MIGRATION_REQUIRED", message: "Migrate.", retryable: false, details: { recovery: migrationRecovery("agent"), records: 3 } },
      details: { recovery: { action: "complete_migration", command: "tc --profile agent auth caps", operationId: "tinycloud.auth.capabilities" } },
    },
    {
      error: { code: "AUTH_REQUIRED", message: "Never signs in.", retryable: false, details: { reason: "explicit_key", key: "0xsecret" } },
      details: { reason: "explicit_key" },
    },
  ] as const;
  for (const { error, details } of cases) {
    resolver = async (_target, requirement) => requirement === "inspection"
      ? { ok: true, context: { summary: restoredSummary("delegate-session"), runtime: { node: {}, granted: [] } } }
      : { ok: false, context: restoredSummary("delegate-session"), error } as never;
    const result = await invokeOperation("tinycloud.secrets.status", 1, { profile: "agent" }, { names: ["A"] });
    expect(result).toMatchObject({ status: "error", error: { code: error.code } });
    expect(errorOf(result).details).toEqual(details);
  }
});

test("S2-T10(d) secrets.get not found for a local owner keeps its value-free KV_NOT_FOUND details", async () => {
  definitions = [secretsGetOperationDefinition as unknown as OperationDefinition<TestInput, TestOutput>];
  const space = "tinycloud:pkh:eip155:1:0xd559ccd9eb87c530a9a349262669386de93cf412:secrets";
  const node = {
    getEncryptionNetworkIdForSpace: () => "urn:tinycloud:encryption:did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:default",
    readSecret: async () => ({ status: "not_found" }),
  };
  const summary = restoredSummary("local-owner-key", "owner");
  const granted = await secretsGetOperationDefinition.authority(
    { summary, runtime: { node, granted: [] } },
    { name: "API_KEY", space },
  );
  resolver = async () => ({ ok: true, context: { summary, runtime: { node, granted: [...granted], localOwner: true } } });
  const result = await invokeOperation("tinycloud.secrets.get", 1, { allowOwnerProfile: true }, { name: "API_KEY", space });
  expect(result).toMatchObject({ status: "error", error: { code: "KV_NOT_FOUND" } });
  expect(errorOf(result).details).toEqual({
    names: ["API_KEY"],
    owner: STATUS_OWNER,
    recoveryKind: "put_locally",
  });
});

test("S2-T10(e) unknown keys, bad enums, forged commands and unsafe profile names are stripped", async () => {
  const valid = signInRecovery("agent", "owner-openkey");
  const envelope = async (code: string, details: Record<string, unknown>) => {
    definitions = [createDefinition({
      execute: async () => ({ status: "error", error: { code, message: "Refused.", retryable: false, details } as never }),
    })];
    return { error: errorOf(await invokeOperation("tinycloud.test.get", 1, {}, { name: "valid" })) };
  };

  expect((await envelope("AUTH_REQUIRED", { recovery: valid, extra: "x", token: "secret" })).error.details).toEqual({ recovery: valid });
  expect((await envelope("INPUT_INVALID", { reason: "SOMETHING_ELSE" })).error).not.toHaveProperty("details");
  for (const recovery of [
    { ...valid, extra: "x" },
    { action: "complete_migration", command: "tc --profile agent auth caps", operationId: "tinycloud.auth.capabilities" },
    { action: "sign_in", command: "tc --profile x; rm -rf ~ auth login --method local" },
    { action: "sign_in", command: "tc --profile agent auth login --method magic" },
  ]) {
    expect((await envelope("AUTH_REQUIRED", { recovery })).error).not.toHaveProperty("details");
  }
  for (const recovery of [
    { action: "complete_migration", command: "tc --profile x; rm -rf ~ auth caps", operationId: "tinycloud.auth.capabilities" },
    { action: "complete_migration", command: "tc --profile agent auth caps", operationId: "tinycloud.other" },
    { action: "complete_migration", command: "tc --profile agent auth caps", operationId: "tinycloud.auth.capabilities", tool: "tinycloud_auth_capabilities" },
  ]) {
    expect((await envelope("PROFILE_MIGRATION_REQUIRED", { recovery })).error).not.toHaveProperty("details");
  }

  const unsafe = signInRecovery("my profile", "local-owner-key");
  expect(unsafe).toEqual({ action: "sign_in" });
  expect((await envelope("SESSION_NOT_FOUND", { recovery: unsafe })).error.details).toEqual({ recovery: { action: "sign_in" } });
  expect(migrationRecovery("my profile")).toEqual({ action: "complete_migration", operationId: "tinycloud.auth.capabilities" });
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

/** The error of an error envelope; any other envelope fails the test. */
function errorOf(result: OperationResult<unknown>): OperationError {
  if (result.status !== "error") throw new Error(`expected an error envelope, got ${result.status}`);
  return result.error;
}
