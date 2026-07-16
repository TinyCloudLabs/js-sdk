import { createHash } from "node:crypto";

import type { PermissionEntry } from "@tinycloud/node-sdk";
import { jcsCanonicalize } from "@tinycloud/sdk-core/policy";
import type { ZodError } from "zod";

import {
  type ApprovalAction,
  type CapabilityRequirement,
  type InvocationTarget,
  type OperationContextSummary,
  type OperationDefinition,
  type OperationRef,
  type OperationResult,
  type OperationRuntimeRequirement,
  type RuntimeOperationContext,
} from "./contract.js";
import {
  internalOperationError,
  operationError,
  sanitizeOperationError,
  sanitizeThrownOperationError,
} from "./errors.js";
import {
  canonicalizeCapabilities,
  evaluateAuthority,
  validateExactCapabilities,
} from "./authority.js";
import {
  createOrReusePermissionRequest,
  type PermissionRequestArtifact,
} from "./artifacts.js";
import { redactOperationError } from "./redaction.js";
import { safeOriginHost } from "./safe-values.js";
import type { InvocationRuntimeResolution } from "./runtime.js";

/** The sole projection-facing execution API. */
export async function invokeOperation(
  operationId: string,
  operationVersion: number,
  invocationTarget: InvocationTarget,
  unknownInput: unknown,
): Promise<OperationResult<unknown>> {
  const operation: OperationRef = { operationId, operationVersion };
  const target = normalizeInvocationTarget(invocationTarget);
  if (target === undefined) {
    return errorResult(
      operation,
      unresolvedContextSummary(),
      operationError("INPUT_INVALID", "The invocation target is invalid."),
    );
  }
  // Load internal registry material only when invoking. This keeps the packed
  // root entrypoint free of auth/runtime SDK initialization until a call is
  // made, while preserving registry resolution before input or profile access.
  const { lookupOperation } = await import("./registry.js");
  const lookup = lookupOperation(operationId, operationVersion);

  // Registry resolution is deliberately complete before any input parsing or
  // profile access. An unrecognized operation must not cause an invocation to
  // consult profile state.
  if (lookup.status === "operation_not_found") {
    return errorResult(
      operation,
      unresolvedContextSummary(target),
      operationError(
        "OPERATION_NOT_FOUND",
        "The requested operation is not registered.",
      ),
    );
  }
  if (lookup.status === "operation_version_unsupported") {
    return errorResult(
      operation,
      unresolvedContextSummary(target),
      operationError(
        "OPERATION_VERSION_UNSUPPORTED",
        "The requested operation version is not supported.",
        { details: { supportedVersions: lookup.supportedVersions } },
      ),
    );
  }

  const definition = lookup.definition;
  const parsedInput = definition.input.safeParse(unknownInput);
  if (!parsedInput.success) {
    return errorResult(
      operation,
      unresolvedContextSummary(target),
      operationError(
        definition.invalidInputErrorCode ?? "INPUT_INVALID",
        "The operation input is invalid.",
        {
          details: zodIssueDetails(parsedInput.error),
        },
      ),
    );
  }

  // Only a registered operation with valid input may inspect the pinned
  // profile. Inspection is deliberately node-free, so owner opt-in and status
  // availability are decided before any authentication or external effect.
  const inspectionResolution = await resolveRuntime(target, "inspection");
  if (!inspectionResolution.ok) {
    return errorResult(
      operation,
      inspectionResolution.context,
      inspectionResolution.error,
    );
  }

  if (
    !definition.postures.includes(inspectionResolution.context.summary.posture)
  ) {
    return errorResult(
      operation,
      inspectionResolution.context.summary,
      operationError(
        "PROFILE_POSTURE_NOT_ALLOWED",
        "The active profile posture cannot execute this operation.",
      ),
    );
  }
  if (
    definition.runtime === "authenticated" &&
    isOwnerPosture(inspectionResolution.context.summary.posture) &&
    target.allowOwnerProfile !== true
  ) {
    return errorResult(
      operation,
      inspectionResolution.context.summary,
      operationError(
        "PROFILE_OWNER_OPT_IN_REQUIRED",
        "Owner-profile execution requires explicit opt-in.",
      ),
    );
  }

  const runtimeResolution =
    definition.runtime === "inspection"
      ? inspectionResolution
      : await resolveRuntime(target, "authenticated");
  if (!runtimeResolution.ok) {
    return errorResult(
      operation,
      runtimeResolution.context,
      runtimeResolution.error,
    );
  }
  if (definition.runtime === "authenticated") {
    const actualPosture = runtimeResolution.context.summary.posture;
    if (!definition.postures.includes(actualPosture)) {
      return errorResult(
        operation,
        runtimeResolution.context.summary,
        operationError(
          "PROFILE_POSTURE_NOT_ALLOWED",
          "The authenticated profile posture cannot execute this operation.",
        ),
      );
    }
    if (isOwnerPosture(actualPosture) && target.allowOwnerProfile !== true) {
      return errorResult(
        operation,
        runtimeResolution.context.summary,
        operationError(
          "PROFILE_OWNER_OPT_IN_REQUIRED",
          "Owner-profile execution requires explicit opt-in.",
        ),
      );
    }
  }
  const runtimeContext =
    runtimeResolution.context.runtime === undefined
      ? undefined
      : (runtimeResolution.context as RuntimeOperationContext);

  try {
    const planned = await definition.authority(
      (runtimeContext ?? runtimeResolution.context) as RuntimeOperationContext,
      parsedInput.data,
    );
    const required = exactCapabilities(planned);
    if (required === undefined) {
      return errorResult(
        operation,
        runtimeResolution.context.summary,
        operationError(
          "PERMISSION_HINT_INVALID",
          "The operation returned an invalid permission requirement.",
        ),
      );
    }

    const evaluation = evaluateAuthority(
      (runtimeContext?.runtime.granted ?? []) as unknown as PermissionEntry[],
      required as unknown as PermissionEntry[],
    );
    if (!evaluation.satisfied) {
      if (runtimeContext === undefined) {
        return errorResult(
          operation,
          runtimeResolution.context.summary,
          internalOperationError(),
        );
      }
      const authority = await persistAuthorityRequest(
        runtimeContext,
        evaluation.missing,
      );
      if (authority.status === "error") {
        return errorResult(
          operation,
          runtimeResolution.context.summary,
          authority.error,
        );
      }
      return authorityRequiredResult(
        operation,
        runtimeResolution.context.summary,
        parsedInput.data,
        authority.request,
        authority.missing,
        runtimeContext.runtime.node,
      );
    }

    const outcome = await definition.execute(
      runtimeResolution.context,
      parsedInput.data,
    );

    switch (outcome.status) {
      case "ok": {
        const parsedOutput = definition.output.safeParse(outcome.output);
        if (!parsedOutput.success) {
          return errorResult(
            operation,
            runtimeResolution.context.summary,
            operationError(
              "OUTPUT_INVALID",
              "The operation returned an invalid result.",
            ),
          );
        }
        return {
          status: "ok",
          operation,
          context: runtimeResolution.context.summary,
          output: parsedOutput.data,
        };
      }
      case "authority_required": {
        const hinted = exactCapabilities(outcome.missing);
        if (
          hinted === undefined ||
          !evaluateAuthority(
            required as unknown as PermissionEntry[],
            hinted as unknown as PermissionEntry[],
          ).satisfied
        ) {
          return errorResult(
            operation,
            runtimeResolution.context.summary,
            operationError(
              "PERMISSION_HINT_INVALID",
              "The node returned an invalid permission hint.",
            ),
          );
        }
        if (runtimeContext === undefined) {
          return errorResult(
            operation,
            runtimeResolution.context.summary,
            internalOperationError(),
          );
        }
        const authority = await persistAuthorityRequest(
          runtimeContext,
          hinted,
          true,
        );
        if (authority.status === "error") {
          return errorResult(
            operation,
            runtimeResolution.context.summary,
            authority.error,
          );
        }
        return authorityRequiredResult(
          operation,
          runtimeResolution.context.summary,
          parsedInput.data,
          authority.request,
          authority.missing,
          runtimeContext.runtime.node,
          outcome.requiresCallerInput ?? false,
        );
      }
      case "setup_required":
        return {
          status: "setup_required",
          operation,
          context: runtimeResolution.context.summary,
          setup: outcome.setup,
          retry: retryDescriptor(
            operation,
            parsedInput.data,
            outcome.requiresCallerInput ?? false,
          ),
        };
      case "error":
        return errorResult(
          operation,
          runtimeResolution.context.summary,
          redactOperationError(
            definition,
            sanitizeOperationError(outcome.error),
          ),
        );
      default:
        return errorResult(
          operation,
          runtimeResolution.context.summary,
          internalOperationError(),
        );
    }
  } catch (error) {
    return errorResult(
      operation,
      runtimeResolution.context.summary,
      redactOperationError(definition, sanitizeThrownOperationError(error)),
    );
  }
}

function normalizeInvocationTarget(
  target: unknown,
): InvocationTarget | undefined {
  if (typeof target !== "object" || target === null) return undefined;

  try {
    const candidate = target as InvocationTarget;
    const profile = candidate.profile;
    const host = candidate.host;
    const allowOwnerProfile = candidate.allowOwnerProfile;
    const privateKey = candidate.privateKey;

    if (
      (profile !== undefined && typeof profile !== "string") ||
      (host !== undefined && typeof host !== "string") ||
      (allowOwnerProfile !== undefined &&
        typeof allowOwnerProfile !== "boolean") ||
      (privateKey !== undefined && typeof privateKey !== "string")
    ) {
      return undefined;
    }

    return {
      ...(profile === undefined ? {} : { profile }),
      ...(host === undefined ? {} : { host }),
      ...(allowOwnerProfile === true ? { allowOwnerProfile: true } : {}),
      ...(privateKey === undefined ? {} : { privateKey }),
    };
  } catch {
    return undefined;
  }
}

async function resolveRuntime(
  target: InvocationTarget,
  requirement: OperationRuntimeRequirement,
): Promise<InvocationRuntimeResolution> {
  try {
    // Keep the root package loadable for projections that only inspect its
    // public invocation export. The SDK runtime is needed only once a valid
    // operation reaches runtime construction.
    const { createInvocationRuntime } = await import("./runtime.js");
    return await createInvocationRuntime(target, requirement);
  } catch (error) {
    return {
      ok: false,
      context: unresolvedContextSummary(target),
      error: sanitizeThrownOperationError(error),
    };
  }
}

function unresolvedContextSummary(
  target: InvocationTarget = {},
): OperationContextSummary {
  return {
    profile: typeof target.profile === "string" ? target.profile : "unresolved",
    host: safeOriginHost(target.host) ?? "unresolved",
    posture: "unauthenticated",
  };
}

function errorResult(
  operation: OperationRef,
  context: OperationContextSummary,
  error: ReturnType<typeof sanitizeOperationError>,
): OperationResult<never> {
  return { status: "error", operation, context, error };
}

function retryDescriptor(
  operation: OperationRef,
  input: unknown,
  requiresCallerInput: boolean,
): Readonly<{
  operationId: string;
  operationVersion: number;
  inputDigest: string;
  requiresCallerInput: boolean;
}> {
  return {
    operationId: operation.operationId,
    operationVersion: operation.operationVersion,
    inputDigest: createHash("sha256")
      .update(jcsCanonicalize(input), "utf8")
      .digest("hex"),
    requiresCallerInput,
  };
}

type PersistedAuthority =
  | Readonly<{
      status: "ok";
      request: PermissionRequestArtifact;
      missing: readonly CapabilityRequirement[];
    }>
  | Readonly<{
      status: "error";
      error: ReturnType<typeof sanitizeOperationError>;
    }>;

async function persistAuthorityRequest(
  context: RuntimeOperationContext,
  missing: readonly CapabilityRequirement[],
  force = false,
): Promise<PersistedAuthority> {
  const sessionDid = context.summary.sessionDid;
  if (sessionDid === undefined) {
    return {
      status: "error",
      error: operationError(
        "SESSION_NOT_FOUND",
        "The selected profile does not have an active session.",
      ),
    };
  }
  try {
    const resolution = await createOrReusePermissionRequest({
      profile: context.summary.profile,
      posture: context.summary.posture,
      operatorType: context.summary.operatorType ?? "human",
      host: context.summary.host,
      sessionDid,
      ...(context.summary.ownerDid === undefined
        ? {}
        : { ownerDid: context.summary.ownerDid }),
      ...(context.summary.space === undefined
        ? {}
        : { spaceId: context.summary.space }),
      missing: missing as unknown as PermissionEntry[],
      granted: (force
        ? []
        : context.runtime.granted) as unknown as PermissionEntry[],
    });
    if (resolution.status !== "created") {
      return {
        status: "error",
        error: operationError(
          "INTERNAL_ERROR",
          "The authority request could not be created.",
        ),
      };
    }
    return {
      status: "ok",
      request: resolution.request,
      missing: canonicalizeCapabilities(
        missing as unknown as PermissionEntry[],
      ) as CapabilityRequirement[],
    };
  } catch {
    return {
      status: "error",
      error: operationError(
        "INTERNAL_ERROR",
        "The authority request could not be created.",
      ),
    };
  }
}

function authorityRequiredResult(
  operation: OperationRef,
  context: OperationContextSummary,
  input: unknown,
  request: PermissionRequestArtifact,
  missing: readonly CapabilityRequirement[],
  node: unknown,
  requiresCallerInput = false,
): OperationResult<never> {
  return {
    status: "authority_required",
    operation,
    context,
    missing,
    request,
    approval: approvalAction(request, node),
    retry: retryDescriptor(operation, input, requiresCallerInput),
  };
}

function approvalAction(
  request: PermissionRequestArtifact,
  node: unknown,
): ApprovalAction {
  const maybeNode = node as {
    getOpenKeyApprovalUrl?: (artifact: PermissionRequestArtifact) => unknown;
  };
  let url: string | undefined;
  try {
    const candidate = maybeNode.getOpenKeyApprovalUrl?.(request);
    if (typeof candidate === "string" && candidate.length > 0) url = candidate;
  } catch {
    // The stored request remains the source of truth when a runtime does not
    // expose a canonical OpenKey URL.
  }
  return {
    kind: "openkey",
    requestId: request.requestId,
    ...(url === undefined ? {} : { url }),
    fallback: "tc auth grant <request-artifact>",
  };
}

function exactCapabilities(
  value: unknown,
): CapabilityRequirement[] | undefined {
  return validateExactCapabilities(value) as
    | CapabilityRequirement[]
    | undefined;
}

function isOwnerPosture(posture: OperationContextSummary["posture"]): boolean {
  return posture === "owner-openkey" || posture === "local-owner-key";
}

function zodIssueDetails(error: ZodError): Readonly<Record<string, unknown>> {
  return {
    // The canonical error channel carries only schema-owned issue codes.
    // Messages and paths can contain arbitrary input keys and values.
    issues: error.issues.map((issue) => ({ code: issue.code })),
  };
}
