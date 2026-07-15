import { createHash } from "node:crypto";

import { jcsCanonicalize } from "@tinycloud/sdk-core/policy";
import type { ZodError } from "zod";

import {
  type InvocationTarget,
  type OperationContextSummary,
  type OperationDefinition,
  type OperationRef,
  type OperationResult,
  safeOperationContextSummary,
} from "./contract.js";
import {
  internalOperationError,
  operationError,
  sanitizeOperationError,
  sanitizeThrownOperationError,
} from "./errors.js";
import { resolveInvocationContext } from "./profile.js";
import { redactOperationError } from "./redaction.js";
import { lookupOperation } from "./registry.js";

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
  const lookup = lookupOperation(operationId, operationVersion);
  const contextResolution = await resolveContext(target);

  // Registry resolution is deliberately complete before any input parsing.
  if (lookup.status === "operation_not_found") {
    return errorResult(
      operation,
      contextResolution.context,
      operationError("OPERATION_NOT_FOUND", "The requested operation is not registered."),
    );
  }
  if (lookup.status === "operation_version_unsupported") {
    return errorResult(
      operation,
      contextResolution.context,
      operationError(
        "OPERATION_VERSION_UNSUPPORTED",
        "The requested operation version is not supported.",
        { details: { supportedVersions: lookup.supportedVersions } },
      ),
    );
  }

  if (contextResolution.error !== undefined) {
    return errorResult(operation, contextResolution.context, contextResolution.error);
  }

  const definition = lookup.definition;
  const parsedInput = definition.input.safeParse(unknownInput);
  if (!parsedInput.success) {
    return errorResult(
      operation,
      contextResolution.context,
      operationError("INPUT_INVALID", "The operation input is invalid.", {
        details: zodIssueDetails(parsedInput.error),
      }),
    );
  }

  if (!definition.postures.includes(contextResolution.context.posture)) {
    return errorResult(
      operation,
      contextResolution.context,
      operationError(
        "PROFILE_POSTURE_NOT_ALLOWED",
        "The active profile posture cannot execute this operation.",
      ),
    );
  }

  try {
    const outcome = await definition.execute(
      { summary: contextResolution.context },
      parsedInput.data,
    );

    switch (outcome.status) {
      case "ok": {
        const parsedOutput = definition.output.safeParse(outcome.output);
        if (!parsedOutput.success) {
          return errorResult(
            operation,
            contextResolution.context,
            operationError(
              "OUTPUT_INVALID",
              "The operation returned an invalid result.",
            ),
          );
        }
        return {
          status: "ok",
          operation,
          context: contextResolution.context,
          output: parsedOutput.data,
        };
      }
      case "authority_required":
        return {
          status: "authority_required",
          operation,
          context: contextResolution.context,
          missing: outcome.missing,
          request: outcome.request,
          approval: outcome.approval,
          retry: retryDescriptor(
            operation,
            parsedInput.data,
            outcome.requiresCallerInput ?? false,
          ),
        };
      case "setup_required":
        return {
          status: "setup_required",
          operation,
          context: contextResolution.context,
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
          contextResolution.context,
          redactOperationError(definition, sanitizeOperationError(outcome.error)),
        );
      default:
        return errorResult(
          operation,
          contextResolution.context,
          internalOperationError(),
        );
    }
  } catch (error) {
    return errorResult(
      operation,
      contextResolution.context,
      redactOperationError(definition, sanitizeThrownOperationError(error)),
    );
  }
}

function normalizeInvocationTarget(target: unknown): InvocationTarget | undefined {
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
      (allowOwnerProfile !== undefined && typeof allowOwnerProfile !== "boolean") ||
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

async function resolveContext(
  target: InvocationTarget,
): Promise<Readonly<{ context: OperationContextSummary; error?: ReturnType<typeof sanitizeThrownOperationError> }>> {
  try {
    const resolved = await resolveInvocationContext(target);
    if (!resolved.ok) {
      return {
        context: unresolvedContextSummary(target),
        error: sanitizeOperationError(resolved.error),
      };
    }
    return { context: safeOperationContextSummary(resolved.context) };
  } catch (error) {
    return {
      context: unresolvedContextSummary(target),
      error: sanitizeThrownOperationError(error),
    };
  }
}

function unresolvedContextSummary(target: InvocationTarget = {}): OperationContextSummary {
  return {
    profile: target.profile ?? "unresolved",
    host: target.host ?? "unresolved",
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
    inputDigest: createHash("sha256").update(jcsCanonicalize(input), "utf8").digest("hex"),
    requiresCallerInput,
  };
}

function zodIssueDetails(error: ZodError): Readonly<Record<string, unknown>> {
  return {
    issues: error.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path.map(String),
    })),
  };
}
