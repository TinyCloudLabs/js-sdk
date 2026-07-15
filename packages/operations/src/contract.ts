import type { z } from "zod";

import type { OperationError, OperationErrorCode } from "./errors.js";

/** A stable, cross-surface operation identifier. */
export type OperationId = string;

/** JSON Pointer syntax from RFC 6901, including the empty pointer for a root value. */
export type JsonPointer = "" | `/${string}`;

export type OperationEffect =
  | "read"
  | "local_write"
  | "write"
  | "destructive"
  | "external";

export type TinyCloudPosture =
  | "owner-openkey"
  | "delegate-session"
  | "local-owner-key"
  | "unauthenticated";

export type OperationOperatorType = "human" | "agent";

export type SurfaceDisposition =
  | Readonly<{ status: "required" }>
  | Readonly<{ status: "excluded"; reason: string }>;

/**
 * Safe identity reported with every result. This deliberately excludes keys,
 * tokens, delegations, grants, and operation inputs or outputs.
 */
export interface OperationContextSummary {
  readonly profile: string;
  readonly host: string;
  readonly posture: TinyCloudPosture;
  readonly operatorType?: OperationOperatorType;
  readonly principalDid?: string;
  readonly sessionDid?: string;
  readonly ownerDid?: string;
  readonly space?: string;
}

/**
 * The profile foundation constructs this context for every invocation. The
 * invocation target never supplies an execution context or runtime object.
 */
export interface OperationContext {
  readonly summary: OperationContextSummary;
  /** Present for every normal invocation; optional for focused definition tests. */
  readonly runtime?: OperationRuntime;
}

/**
 * Per-invocation authority that is constructed inside operations. It is never
 * caller supplied and it is deliberately absent from result envelopes.
 */
export interface OperationRuntime {
  readonly node: unknown;
  readonly granted: readonly CapabilityRequirement[];
}

/** Context given to planners and handlers after runtime authentication. */
export interface RuntimeOperationContext extends OperationContext {
  readonly runtime: OperationRuntime;
}

export type AuthorityPlanningContext = RuntimeOperationContext;

/**
 * Capability details are finalized by the authority/artifacts increment. The
 * kernel intentionally preserves them as canonical operation-owned data.
 */
export type CapabilityRequirement = Readonly<Record<string, unknown>>;

export interface PermissionRequestArtifact {
  readonly requestId: string;
  readonly [key: string]: unknown;
}

export interface ApprovalAction {
  readonly kind: "openkey";
  readonly requestId: string;
  readonly url?: string;
  readonly fallback: string;
}

export interface SetupAction {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface OperationRef {
  readonly operationId: OperationId;
  readonly operationVersion: number;
}

export interface RetryDescriptor extends OperationRef {
  readonly inputDigest: string;
  readonly safeInput?: Readonly<Record<string, unknown>>;
  readonly requiresCallerInput: boolean;
}

export interface OperationSensitivity {
  readonly input: readonly JsonPointer[];
  readonly output: readonly JsonPointer[];
}

/**
 * An inspection operation may read safe local profile state without creating a
 * node or authenticating. Every other operation requires an authenticated
 * runtime before planning or execution.
 */
export type OperationRuntimeRequirement = "authenticated" | "inspection";

export interface OperationExposure {
  readonly cli: SurfaceDisposition;
  readonly mcp: SurfaceDisposition;
  readonly skill: SurfaceDisposition;
  readonly docs: SurfaceDisposition;
}

export interface OperationOkResult<O> {
  readonly status: "ok";
  readonly operation: OperationRef;
  readonly context: OperationContextSummary;
  readonly output: O;
}

export interface OperationAuthorityRequiredResult {
  readonly status: "authority_required";
  readonly operation: OperationRef;
  readonly context: OperationContextSummary;
  readonly missing: readonly CapabilityRequirement[];
  readonly request: PermissionRequestArtifact;
  readonly approval: ApprovalAction;
  readonly retry: RetryDescriptor;
}

export interface OperationSetupRequiredResult {
  readonly status: "setup_required";
  readonly operation: OperationRef;
  readonly context: OperationContextSummary;
  readonly setup: SetupAction;
  readonly retry: RetryDescriptor;
}

export interface OperationErrorResult {
  readonly status: "error";
  readonly operation: OperationRef;
  readonly context: OperationContextSummary;
  readonly error: OperationError;
}

export type OperationResult<O> =
  | OperationOkResult<O>
  | OperationAuthorityRequiredResult
  | OperationSetupRequiredResult
  | OperationErrorResult;

/**
 * Handler outcomes intentionally omit invocation-owned operation, context, and
 * retry metadata. The kernel attaches those values after validation.
 */
export type OperationExecutionOutcome<O> =
  | Readonly<{ status: "ok"; output: O }>
  | Readonly<{
      status: "authority_required";
      missing: readonly CapabilityRequirement[];
      request: PermissionRequestArtifact;
      approval: ApprovalAction;
      requiresCallerInput?: boolean;
    }>
  | Readonly<{
      status: "setup_required";
      setup: SetupAction;
      requiresCallerInput?: boolean;
    }>
  | Readonly<{ status: "error"; error: OperationError }>;

/**
 * Internal registry material. It is intentionally never re-exported by the
 * package root: projections can execute only by operation id and version.
 */
export interface OperationDefinition<I, O> {
  readonly id: OperationId;
  readonly version: 1;
  readonly title: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly effects: readonly OperationEffect[];
  readonly runtime: OperationRuntimeRequirement;
  readonly postures: readonly TinyCloudPosture[];
  readonly exposure: OperationExposure;
  readonly sensitivity: OperationSensitivity;
  /** A definition may give malformed transport artifacts a stable error code. */
  readonly invalidInputErrorCode?: OperationErrorCode;
  readonly authority: (
    context: AuthorityPlanningContext,
    input: I,
  ) => Promise<readonly CapabilityRequirement[]>;
  readonly execute: (
    context: OperationContext,
    input: I,
  ) => Promise<OperationExecutionOutcome<O>>;
}

/**
 * The only caller-controlled invocation settings. `privateKey` is a CLI-only,
 * nonpersistable override; it is deliberately excluded from result metadata,
 * retry descriptors, diagnostics, and all state written by this package.
 */
export interface InvocationTarget {
  readonly profile?: string;
  readonly host?: string;
  readonly allowOwnerProfile?: boolean;
  readonly privateKey?: string;
}

/**
 * Copy only the identity fields allowed in a public result. Keeping this
 * projection centralized prevents a profile/runtime implementation from
 * accidentally smuggling execution material into an envelope.
 */
export function safeOperationContextSummary(
  summary: OperationContextSummary,
): OperationContextSummary {
  return {
    profile: summary.profile,
    host: summary.host,
    posture: summary.posture,
    ...(summary.operatorType === undefined
      ? {}
      : { operatorType: summary.operatorType }),
    ...(summary.principalDid === undefined
      ? {}
      : { principalDid: summary.principalDid }),
    ...(summary.sessionDid === undefined ? {} : { sessionDid: summary.sessionDid }),
    ...(summary.ownerDid === undefined ? {} : { ownerDid: summary.ownerDid }),
    ...(summary.space === undefined ? {} : { space: summary.space }),
  };
}
