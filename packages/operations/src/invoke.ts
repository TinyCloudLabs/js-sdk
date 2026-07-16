import { createHash } from "node:crypto";

import {
  makePkhSpaceId,
  parsePkhDid,
  parseSpaceUri,
  type PermissionEntry,
} from "@tinycloud/node-sdk";
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
  canonicalizeOperationCapabilities,
  evaluateOperationAuthority,
  isExactCapabilityMemberSubset,
  validateExactCapabilities,
} from "./authority.js";
import {
  createOrReusePermissionRequest,
  buildPermissionRequestArtifact,
  type PermissionRequestArtifact,
} from "./artifacts.js";
import { redactOperationError } from "./redaction.js";
import { safeOriginHost } from "./safe-values.js";
import type { InvocationRuntimeResolution } from "./runtime.js";
import {
  operationSpaceResolver,
  resolveSecretReferenceForOperation,
} from "./secrets.js";

/** The sole projection-facing execution API. */
export async function invokeOperation(
  operationId: string,
  operationVersion: number,
  invocationTarget: InvocationTarget,
  unknownInput: unknown,
): Promise<OperationResult<unknown>> {
  const prepared = await prepareInvocation(
    operationId,
    operationVersion,
    invocationTarget,
    unknownInput,
  );
  if (isPreparedError(prepared)) return prepared.result;
  return executePreparedInvocation(prepared);
}

/**
 * CLI-only local-owner acquisition path. The runtime is deliberately created
 * and retained inside operations so a grant is installed on the exact session
 * that performs the one retry. The explicit key remains a non-persisted target
 * value and no runtime object crosses the operations boundary.
 */
export async function invokeOperationWithLocalAuthorityRetry(
  operationId: string,
  operationVersion: number,
  invocationTarget: InvocationTarget,
  unknownInput: unknown,
): Promise<OperationResult<unknown>> {
  const target = normalizeInvocationTarget(invocationTarget);
  if (target === undefined) {
    return errorResult(
      { operationId, operationVersion },
      unresolvedContextSummary(),
      operationError("INPUT_INVALID", "The invocation target is invalid."),
    );
  }
  if (typeof target.privateKey !== "string" || target.privateKey.length === 0) {
    return errorResult(
      { operationId, operationVersion },
      unresolvedContextSummary(target),
      operationError(
        "PROFILE_POSTURE_NOT_ALLOWED",
        "Local authority retry requires an explicit private key.",
      ),
    );
  }

  const prepared = await prepareInvocation(
    operationId,
    operationVersion,
    target,
    unknownInput,
  );
  if (isPreparedError(prepared)) return prepared.result;

  if (
    prepared.operation.operationId !== "tinycloud.secrets.get" ||
    prepared.operation.operationVersion !== 1
  ) {
    return errorResult(
      prepared.operation,
      prepared.runtimeResolution.context.summary,
      operationError(
        "OPERATION_NOT_FOUND",
        "The local CLI authority helper supports only tinycloud.secrets.get@1.",
      ),
    );
  }

  const runtimeContext = prepared.runtimeResolution.context;
  if (runtimeContext.runtime === undefined) return internalOperationErrorResult(prepared);
  const operationContext = runtimeContext as RuntimeOperationContext;
  let planned: CapabilityRequirement[] | undefined;
  try {
    planned = exactCapabilities(await prepared.definition.authority(
      operationContext,
      prepared.parsedInput.data,
    ));
  } catch {
    return errorResult(
      prepared.operation,
      operationContext.summary,
      operationError(
        "PERMISSION_HINT_INVALID",
        "The local CLI authority plan is invalid.",
      ),
    );
  }
  const planStatus = planned === undefined
    ? "invalid"
    : isExactLocalSecretsGetPlan(prepared, planned, operationContext);
  if (planStatus === "ineligible") {
    return errorResult(
      prepared.operation,
      operationContext.summary,
      operationError(
        "PROFILE_POSTURE_NOT_ALLOWED",
        "The explicit private key cannot authorize the requested owner space.",
      ),
    );
  }
  if (planStatus !== "valid") {
    return errorResult(
      prepared.operation,
      operationContext.summary,
      operationError(
        "PERMISSION_HINT_INVALID",
        "The local CLI authority plan is invalid.",
      ),
    );
  }

  const first = await executePreparedInvocation(prepared, { deferAuthorityRequest: true });
  if (first.status !== "authority_required") {
    return first;
  }
  if (
    operationContext.summary.posture !== "local-owner-key" ||
    !requirementsBelongToAuthenticatedOwner(
      first.missing as unknown as PermissionEntry[],
      operationContext.summary.space,
    )
  ) {
    return localAuthorityFailure(prepared);
  }

  try {
    const grantRuntimePermissions = (operationContext.runtime.node as {
      grantRuntimePermissions?: (
        permissions: PermissionEntry[],
      ) => Promise<unknown>;
    }).grantRuntimePermissions;
    if (typeof grantRuntimePermissions !== "function") {
      return localAuthorityFailure(prepared);
    }
    await grantRuntimePermissions.call(
      operationContext.runtime.node,
      first.missing as unknown as PermissionEntry[],
    );

    const resolveSpace = operationSpaceResolver(
      operationContext.runtime.node,
      operationContext.summary.space,
    );
    const refreshedGranted = refreshLiveRuntimeAuthority(
      operationContext.runtime.node,
      first.missing as unknown as PermissionEntry[],
      planned as unknown as PermissionEntry[],
      resolveSpace,
    );
    if (refreshedGranted === undefined) {
      return localAuthorityFailure(prepared);
    }
    const retryContext: RuntimeOperationContext = {
      ...operationContext,
      runtime: {
        ...operationContext.runtime,
        granted: refreshedGranted,
      },
    };
    const retry = await executePreparedInvocation({
      ...prepared,
      runtimeResolution: { ok: true, context: retryContext },
    }, { deferAuthorityRequest: true });
    return retry.status === "authority_required"
      ? localAuthorityFailure(prepared)
      : retry;
  } catch {
    return localAuthorityFailure(prepared);
  }
}

type PreparedInvocation = Readonly<{
  operation: OperationRef;
  definition: OperationDefinition<any, any>;
  parsedInput: { data: any };
  runtimeResolution: Extract<InvocationRuntimeResolution, { ok: true }>;
}> | Readonly<{
  status: "error";
  result: OperationResult<never>;
}>;

function isPreparedError(
  prepared: PreparedInvocation,
): prepared is Extract<PreparedInvocation, { status: "error" }> {
  return "status" in prepared;
}

async function prepareInvocation(
  operationId: string,
  operationVersion: number,
  invocationTarget: InvocationTarget,
  unknownInput: unknown,
): Promise<PreparedInvocation> {
  const operation: OperationRef = { operationId, operationVersion };
  const target = normalizeInvocationTarget(invocationTarget);
  if (target === undefined) {
    return { status: "error", result: errorResult(
      operation,
      unresolvedContextSummary(),
      operationError("INPUT_INVALID", "The invocation target is invalid."),
    ) };
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
    return { status: "error", result: errorResult(
      operation,
      unresolvedContextSummary(target),
      operationError(
        "OPERATION_NOT_FOUND",
        "The requested operation is not registered.",
      ),
    ) };
  }
  if (lookup.status === "operation_version_unsupported") {
    return { status: "error", result: errorResult(
      operation,
      unresolvedContextSummary(target),
      operationError(
        "OPERATION_VERSION_UNSUPPORTED",
        "The requested operation version is not supported.",
        { details: { supportedVersions: lookup.supportedVersions } },
      ),
    ) };
  }

  const definition = lookup.definition;
  const parsedInput = definition.input.safeParse(unknownInput);
  if (!parsedInput.success) {
    return { status: "error", result: errorResult(
      operation,
      unresolvedContextSummary(target),
      operationError(
        definition.invalidInputErrorCode ?? "INPUT_INVALID",
        "The operation input is invalid.",
        {
          details: zodIssueDetails(parsedInput.error),
        },
      ),
    ) };
  }

  // Only a registered operation with valid input may inspect the pinned
  // profile. Inspection is deliberately node-free, so owner opt-in and status
  // availability are decided before any authentication or external effect.
  const inspectionResolution = await resolveRuntime(target, "inspection");
  if (!inspectionResolution.ok) {
    return { status: "error", result: errorResult(
      operation,
      inspectionResolution.context,
      inspectionResolution.error,
    ) };
  }

  if (
    target.privateKey === undefined &&
    !definition.postures.includes(inspectionResolution.context.summary.posture)
  ) {
    return { status: "error", result: errorResult(
      operation,
      inspectionResolution.context.summary,
      operationError(
        "PROFILE_POSTURE_NOT_ALLOWED",
        "The active profile posture cannot execute this operation.",
      ),
    ) };
  }
  if (
    target.privateKey === undefined &&
    definition.runtime === "authenticated" &&
    isOwnerPosture(inspectionResolution.context.summary.posture) &&
    target.allowOwnerProfile !== true
  ) {
    return { status: "error", result: errorResult(
      operation,
      inspectionResolution.context.summary,
      operationError(
        "PROFILE_OWNER_OPT_IN_REQUIRED",
        "Owner-profile execution requires explicit opt-in.",
      ),
    ) };
  }

  const runtimeResolution =
    definition.runtime === "inspection"
      ? inspectionResolution
      : await resolveRuntime(target, "authenticated");
  if (!runtimeResolution.ok) {
    return { status: "error", result: errorResult(
      operation,
      runtimeResolution.context,
      runtimeResolution.error,
    ) };
  }
  if (definition.runtime === "authenticated") {
    const actualPosture = runtimeResolution.context.summary.posture;
    if (!definition.postures.includes(actualPosture)) {
      return { status: "error", result: errorResult(
        operation,
        runtimeResolution.context.summary,
        operationError(
          "PROFILE_POSTURE_NOT_ALLOWED",
          "The authenticated profile posture cannot execute this operation.",
        ),
      ) };
    }
    if (isOwnerPosture(actualPosture) && target.allowOwnerProfile !== true) {
      return { status: "error", result: errorResult(
        operation,
        runtimeResolution.context.summary,
        operationError(
          "PROFILE_OWNER_OPT_IN_REQUIRED",
          "Owner-profile execution requires explicit opt-in.",
        ),
      ) };
    }
  }
  return {
    operation,
    definition,
    parsedInput,
    runtimeResolution,
  };
}

async function executePreparedInvocation(
  prepared: Exclude<PreparedInvocation, { status: "error" }>,
  options: Readonly<{ deferAuthorityRequest?: boolean }> = {},
): Promise<OperationResult<unknown>> {
  const { operation, definition, parsedInput, runtimeResolution } = prepared;
  const runtimeContext =
    runtimeResolution.context.runtime === undefined
      ? undefined
      : (runtimeResolution.context as RuntimeOperationContext);
  const resolveSpace = runtimeContext === undefined
    ? undefined
    : operationSpaceResolver(
      runtimeContext.runtime.node,
      runtimeContext.summary.space,
    );

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

    const evaluation = evaluateOperationAuthority(
      (runtimeContext?.runtime.granted ?? []) as unknown as PermissionEntry[],
      required as unknown as PermissionEntry[],
      resolveSpace,
    );
    if (!evaluation.satisfied) {
      if (runtimeContext === undefined) {
        return errorResult(
          operation,
          runtimeResolution.context.summary,
          internalOperationError(),
        );
      }
      if (options.deferAuthorityRequest) {
        try {
          const request = buildPermissionRequestArtifact({
            profile: runtimeContext.summary.profile,
            host: runtimeContext.summary.host,
            sessionDid: runtimeContext.summary.sessionDid!,
            posture: runtimeContext.summary.posture,
            operatorType: runtimeContext.summary.operatorType ?? "human",
            ...(runtimeContext.summary.ownerDid === undefined
              ? {}
              : { ownerDid: runtimeContext.summary.ownerDid }),
            ...(runtimeContext.summary.space === undefined
              ? {}
              : { spaceId: runtimeContext.summary.space }),
            missing: evaluation.missing as unknown as PermissionEntry[],
          });
          return authorityRequiredResult(
            operation,
            runtimeResolution.context.summary,
            parsedInput.data,
            request,
            evaluation.missing,
            runtimeContext.runtime.node,
          );
        } catch {
          return errorResult(
            operation,
            runtimeResolution.context.summary,
            internalOperationError(),
          );
        }
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
          !isExactCapabilityMemberSubset(
            hinted as unknown as PermissionEntry[],
            required as unknown as PermissionEntry[],
            resolveSpace,
          )
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
        if (options.deferAuthorityRequest) {
          try {
            const request = buildPermissionRequestArtifact({
              profile: runtimeContext.summary.profile,
              host: runtimeContext.summary.host,
              sessionDid: runtimeContext.summary.sessionDid!,
              posture: runtimeContext.summary.posture,
              operatorType: runtimeContext.summary.operatorType ?? "human",
              ...(runtimeContext.summary.ownerDid === undefined
                ? {}
                : { ownerDid: runtimeContext.summary.ownerDid }),
              ...(runtimeContext.summary.space === undefined
                ? {}
                : { spaceId: runtimeContext.summary.space }),
              missing: hinted as unknown as PermissionEntry[],
            });
            return authorityRequiredResult(
              operation,
              runtimeResolution.context.summary,
              parsedInput.data,
              request,
              hinted,
              runtimeContext.runtime.node,
              outcome.requiresCallerInput ?? false,
            );
          } catch {
            return errorResult(
              operation,
              runtimeResolution.context.summary,
              internalOperationError(),
            );
          }
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
    const resolveSpace = operationSpaceResolver(
      context.runtime.node,
      context.summary.space,
    );
    const canonicalMissing = canonicalizeOperationCapabilities(missing as unknown as PermissionEntry[], resolveSpace);
    const canonicalGranted = canonicalizeOperationCapabilities(context.runtime.granted as unknown as PermissionEntry[], resolveSpace);
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
      missing: canonicalMissing as unknown as PermissionEntry[],
      granted: (force
        ? []
        : canonicalGranted) as unknown as PermissionEntry[],
      resolveSpace,
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
      missing: canonicalMissing as CapabilityRequirement[],
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

function requirementsBelongToAuthenticatedOwner(
  requirements: readonly PermissionEntry[],
  authenticatedSpace: string | undefined,
): boolean {
  const authenticatedOwner = canonicalPkhOwner(authenticatedSpace);
  if (authenticatedOwner === undefined) return false;
  return requirements.every((requirement) => {
    if (requirement.service === "tinycloud.encryption") {
      return requirement.space === undefined;
    }
    const requirementOwner = canonicalPkhOwner(requirement.space);
    return requirement.service === "tinycloud.kv" && requirementOwner === authenticatedOwner;
  });
}

function canonicalPkhOwner(space: string | undefined): string | undefined {
  if (typeof space !== "string") return undefined;
  const parsedSpace = parseSpaceUri(space);
  if (parsedSpace === null) return undefined;
  try {
    const pkh = parsePkhDid(parsedSpace.owner);
    return pkh === null
      ? undefined
      : parseSpaceUri(makePkhSpaceId(pkh.address, pkh.chainId, parsedSpace.name))?.owner;
  } catch {
    return undefined;
  }
}

function isExactLocalSecretsGetPlan(
  prepared: Exclude<PreparedInvocation, { status: "error" }>,
  planned: readonly CapabilityRequirement[],
  context: RuntimeOperationContext,
): "valid" | "ineligible" | "invalid" {
  if (
    prepared.definition.id !== "tinycloud.secrets.get" ||
    prepared.definition.version !== 1 ||
    JSON.stringify(prepared.definition.effects) !== JSON.stringify(["read", "local_write"])
  ) return "invalid";

  const resolveSpace = operationSpaceResolver(context.runtime.node, context.summary.space);
  let reference;
  try {
    reference = resolveSecretReferenceForOperation(
      prepared.parsedInput.data,
      context.runtime.node,
      context.summary.space,
    );
  } catch {
    return "invalid";
  }
  const canonicalPlan = canonicalizeOperationCapabilities(
    planned as unknown as PermissionEntry[],
    resolveSpace,
  );
  if (canonicalPlan.length !== 2) return "invalid";
  const kv = canonicalPlan.find((permission) => permission.service === "tinycloud.kv");
  const decrypt = canonicalPlan.find((permission) => permission.service === "tinycloud.encryption");
  if (kv === undefined || decrypt === undefined) return "invalid";
  const requestedOwner = canonicalPkhOwner(kv.space);
  const authenticatedOwner = canonicalPkhOwner(context.summary.space);
  if (requestedOwner === undefined || authenticatedOwner === undefined || requestedOwner !== authenticatedOwner) {
    return "ineligible";
  }
  if (JSON.stringify(kv) !== JSON.stringify({
    service: "tinycloud.kv",
    space: resolveSpace(reference.space),
    path: reference.permissionPath,
    actions: ["tinycloud.kv/get"],
  })) return "invalid";
  if (
    JSON.stringify(decrypt) !== JSON.stringify({
      service: "tinycloud.encryption",
      path: decrypt.path,
      actions: ["tinycloud.encryption/decrypt"],
    }) ||
    typeof decrypt.path !== "string" ||
    !decrypt.path.startsWith("urn:tinycloud:encryption:")
  ) return "invalid";
  return "valid";
}

function refreshLiveRuntimeAuthority(
  node: unknown,
  requested: readonly PermissionEntry[],
  planned: readonly PermissionEntry[],
  resolveSpace: (space: string) => string,
): readonly CapabilityRequirement[] | undefined {
  const candidate = node as {
    hasRuntimePermissions?: (permissions: PermissionEntry[]) => unknown;
    getVerifiedSessionCapabilities?: () => unknown;
    getEffectiveRuntimePermissionEntries?: () => unknown;
  };
  if (typeof candidate.hasRuntimePermissions !== "function") return undefined;
  if (candidate.hasRuntimePermissions([...requested]) !== true) return undefined;
  if (typeof candidate.getVerifiedSessionCapabilities !== "function" ||
      typeof candidate.getEffectiveRuntimePermissionEntries !== "function") return undefined;

  const base = candidate.getVerifiedSessionCapabilities();
  const activated = candidate.getEffectiveRuntimePermissionEntries();
  if (!Array.isArray(base) || !Array.isArray(activated)) return undefined;
  const exactActivated = validateExactCapabilities(activated);
  if (
    exactActivated === undefined ||
    !isExactCapabilityMemberSubset(exactActivated, planned, resolveSpace) ||
    !isExactCapabilityMemberSubset(requested, exactActivated, resolveSpace)
  ) return undefined;
  const combined = canonicalizeOperationCapabilities(
    [...base, ...exactActivated],
    resolveSpace,
  );
  return evaluateOperationAuthority(combined, planned as unknown as PermissionEntry[], resolveSpace).satisfied
    ? combined
    : undefined;
}

function localAuthorityFailure(
  prepared: Exclude<PreparedInvocation, { status: "error" }>,
): OperationResult<never> {
  return errorResult(
    prepared.operation,
    prepared.runtimeResolution.context.summary,
    operationError(
      "NODE_ERROR",
      "The local owner could not acquire the requested secret permissions.",
      { retryable: true },
    ),
  );
}

function internalOperationErrorResult(
  prepared: Exclude<PreparedInvocation, { status: "error" }>,
): OperationResult<never> {
  return errorResult(
    prepared.operation,
    prepared.runtimeResolution.context.summary,
    internalOperationError(),
  );
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
