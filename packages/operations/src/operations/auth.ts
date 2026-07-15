import {
  activateValidatedRuntimeDelegation,
  type PermissionEntry,
  type PortableDelegation,
  type RuntimeDelegationActivator,
} from "@tinycloud/node-sdk";
import { z } from "zod";

import {
  canonicalizeCapabilities,
  evaluateAuthority,
  validateExactCapabilities,
} from "../authority.js";
import {
  createOrReusePermissionRequest,
  DelegationImportArtifactSchema,
  findPermissionRequest,
  listPermissionRequests,
  type DelegationImportArtifact,
  type PermissionRequestArtifact,
} from "../artifacts.js";
import type {
  OperationContext,
  OperationDefinition,
  OperationExecutionOutcome,
  OperationExposure,
  OperationSensitivity,
  RuntimeOperationContext,
  TinyCloudPosture,
} from "../contract.js";
import { operationError } from "../errors.js";
import { lookupOperation } from "../registry.js";
import {
  readSession,
  updateProfileStoreWhileLocked,
  withProfileLock,
} from "../state.js";

const PermissionEntrySchema = z.object({
  service: z.string().min(1),
  space: z.string().min(1).optional(),
  path: z.string(),
  actions: z.array(z.string().min(1)).min(1),
  skipPrefix: z.boolean().optional(),
  expiry: z.string().min(1).optional(),
  description: z.string().optional(),
}).strict();
const GrantedPermissionEntrySchema = PermissionEntrySchema.extend({
  caveats: z.array(z.record(z.unknown())).optional(),
}).strict();

type CapabilitiesInput = Record<never, never>;
type CapabilitiesOutput = { readonly capabilities: readonly PermissionEntry[] };
type AuthRequestInput =
  | Readonly<{ requestId: string }>
  | Readonly<{
    operationId: string;
    operationVersion: number;
    input?: unknown;
  }>;
type AuthRequestOutput = Readonly<{
  missing: readonly PermissionEntry[];
  request?: PermissionRequestArtifact;
}>;
type AuthImportOutput = Readonly<{
  cid: string;
  effectivePermissions: readonly PermissionEntry[];
  expiry: string;
  audience: string;
  host: string;
  activated: true;
  alreadyPresent: boolean;
}>;

const EmptyInputSchema: z.ZodType<CapabilitiesInput> = z.object({}).strict();
const CapabilitiesOutputSchema: z.ZodType<CapabilitiesOutput> = z.object({
  capabilities: z.array(GrantedPermissionEntrySchema),
}).strict();
const AuthRequestInputSchema: z.ZodType<AuthRequestInput> = z.union([
  z.object({ requestId: z.string().min(1) }).strict(),
  z.object({
    operationId: z.string().min(1),
    operationVersion: z.number().int().positive(),
    input: z.unknown(),
  }).strict().superRefine((value, issue) => {
    if (!Object.prototype.hasOwnProperty.call(value, "input")) {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: "Operation input is required." });
    }
  }),
]);
const PermissionRequestOutputSchema = z.object({
  kind: z.literal("tinycloud.auth.request"),
  version: z.literal(1),
  requestId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  profile: z.string().min(1),
  posture: z.enum(["owner-openkey", "delegate-session", "local-owner-key", "unauthenticated"]),
  operatorType: z.enum(["human", "agent"]),
  host: z.string().min(1),
  sessionDid: z.string().min(1),
  ownerDid: z.string().min(1).optional(),
  spaceId: z.string().min(1).optional(),
  requestedExpiry: z.union([z.string(), z.number()]).optional(),
  requested: z.array(PermissionEntrySchema).min(1),
  command: z.object({ argv: z.array(z.string()).min(1), cwd: z.string().min(1) }).strict().optional(),
}).strict();
const AuthRequestOutputSchema: z.ZodType<AuthRequestOutput> = z.object({
  missing: z.array(PermissionEntrySchema),
  request: PermissionRequestOutputSchema.optional(),
}).strict();
const AuthImportOutputSchema: z.ZodType<AuthImportOutput> = z.object({
  cid: z.string().min(1),
  effectivePermissions: z.array(PermissionEntrySchema),
  expiry: z.string().datetime({ offset: true }),
  audience: z.string().min(1),
  host: z.string().min(1),
  activated: z.literal(true),
  alreadyPresent: z.boolean(),
}).strict();

const AUTH_POSTURES: readonly TinyCloudPosture[] = [
  "owner-openkey",
  "delegate-session",
  "local-owner-key",
];
const AUTH_EXPOSURE: OperationExposure = {
  cli: { status: "required" },
  mcp: { status: "required" },
  skill: { status: "required" },
  docs: { status: "required" },
};
const AUTH_CAPABILITIES_SENSITIVITY: OperationSensitivity = { input: [], output: [] };
const AUTH_REQUEST_SENSITIVITY: OperationSensitivity = { input: ["/input"], output: [] };
const AUTH_IMPORT_SENSITIVITY: OperationSensitivity = { input: [""], output: [] };

/**
 * Internal I2 auth definitions. Registry integration intentionally owns their
 * registration and root exports remain limited to invokeOperation.
 */
type AuthOperationDefinition =
  | OperationDefinition<CapabilitiesInput, CapabilitiesOutput>
  | OperationDefinition<AuthRequestInput, AuthRequestOutput>
  | OperationDefinition<DelegationImportArtifact, AuthImportOutput>;

export const authOperationDefinitions: readonly AuthOperationDefinition[] = [
  {
    id: "tinycloud.auth.capabilities",
    version: 1,
    title: "TinyCloud active capabilities",
    description: "Inspect validated active runtime capabilities for the selected profile.",
    input: EmptyInputSchema,
    output: CapabilitiesOutputSchema,
    effects: ["read"],
    runtime: "authenticated",
    postures: AUTH_POSTURES,
    exposure: AUTH_EXPOSURE,
    sensitivity: AUTH_CAPABILITIES_SENSITIVITY,
    authority: async () => [],
    execute: async (context: OperationContext): Promise<OperationExecutionOutcome<CapabilitiesOutput>> => ({
      status: "ok",
      output: {
        capabilities: canonicalizeCapabilities(
          (context.runtime?.granted ?? []) as unknown as PermissionEntry[],
        ),
      },
    }),
  },
  {
    id: "tinycloud.auth.request",
    version: 1,
    title: "Request TinyCloud capabilities",
    description: "Create or recover an exact stored request from a canonical operation planner.",
    input: AuthRequestInputSchema,
    output: AuthRequestOutputSchema,
    effects: ["local_write"],
    runtime: "authenticated",
    postures: AUTH_POSTURES,
    exposure: AUTH_EXPOSURE,
    sensitivity: AUTH_REQUEST_SENSITIVITY,
    authority: async () => [],
    execute: (context: OperationContext, input: AuthRequestInput) => requestExactAuthority(
      context as RuntimeOperationContext,
      input,
    ),
  },
  {
    id: "tinycloud.auth.import",
    version: 1,
    title: "Import TinyCloud delegation",
    description: "Validate, activate, and persist one request-bound runtime delegation.",
    input: DelegationImportArtifactSchema,
    output: AuthImportOutputSchema,
    effects: ["local_write"],
    runtime: "authenticated",
    postures: AUTH_POSTURES,
    exposure: AUTH_EXPOSURE,
    sensitivity: AUTH_IMPORT_SENSITIVITY,
    invalidInputErrorCode: "DELEGATION_ARTIFACT_INVALID",
    authority: async () => [],
    execute: (context: OperationContext, input: DelegationImportArtifact) => importRequestBoundDelegation(
      context as RuntimeOperationContext,
      input,
    ),
  },
];

async function requestExactAuthority(
  context: RuntimeOperationContext,
  input: AuthRequestInput,
): Promise<OperationExecutionOutcome<AuthRequestOutput>> {
  const sessionDid = context.summary.sessionDid;
  if (sessionDid === undefined) return missingSession();

  if ("requestId" in input) {
    try {
      const request = await findPermissionRequest(context.summary.profile, input.requestId, {
        sessionDid,
        host: context.summary.host,
      });
      if (request === null) {
        return invalidInput("The requested authority request is not available for this session.");
      }
      if (request.profile !== context.summary.profile) {
        return invalidInput("The requested authority request is not available for this profile.");
      }
      const required = exactCapabilities(request.requested);
      if (required === undefined) {
        return operationFailure(
          "PERMISSION_HINT_INVALID",
          "The stored authority request has invalid capabilities.",
        );
      }
      if (evaluateAuthority(
        context.runtime.granted as unknown as PermissionEntry[],
        required,
      ).satisfied) {
        return { status: "ok", output: { missing: [] } };
      }
      return { status: "ok", output: { missing: required, request } };
    } catch {
      return internalFailure();
    }
  }

  const target = lookupOperation(input.operationId, input.operationVersion);
  if (target.status === "operation_not_found") {
    return operationFailure("OPERATION_NOT_FOUND", "The requested operation is not registered.");
  }
  if (target.status === "operation_version_unsupported") {
    return operationFailure(
      "OPERATION_VERSION_UNSUPPORTED",
      "The requested operation version is not supported.",
    );
  }
  if (target.definition.id === "tinycloud.auth.request") {
    return invalidInput("Authority requests cannot plan themselves.");
  }
  if (!target.definition.postures.includes(context.summary.posture)) {
    return operationFailure(
      "PROFILE_POSTURE_NOT_ALLOWED",
      "The active profile posture cannot execute this operation.",
    );
  }

  const parsed = target.definition.input.safeParse(input.input);
  if (!parsed.success) return invalidInput("The operation input is invalid.");

  try {
    const planned = await target.definition.authority(context, parsed.data);
    const required = exactCapabilities(planned);
    if (required === undefined) {
      return operationFailure(
        "PERMISSION_HINT_INVALID",
        "The operation returned an invalid permission requirement.",
      );
    }
    const evaluation = evaluateAuthority(
      context.runtime.granted as unknown as PermissionEntry[],
      required,
    );
    if (evaluation.satisfied) {
      // Do not call the artifact store: even a retention-only write is not an
      // allowed side effect for an already-authorized request.
      return { status: "ok", output: { missing: [] } };
    }
    const request = await createOrReusePermissionRequest({
      profile: context.summary.profile,
      posture: context.summary.posture,
      operatorType: context.summary.operatorType ?? "human",
      host: context.summary.host,
      sessionDid,
      ...(context.summary.ownerDid === undefined ? {} : { ownerDid: context.summary.ownerDid }),
      ...(context.summary.space === undefined ? {} : { spaceId: context.summary.space }),
      missing: evaluation.missing,
      granted: context.runtime.granted as unknown as PermissionEntry[],
    });
    if (request.status === "satisfied") return { status: "ok", output: { missing: [] } };
    return {
      status: "ok",
      output: { missing: evaluation.missing, request: request.request },
    };
  } catch {
    return internalFailure();
  }
}

async function importRequestBoundDelegation(
  context: RuntimeOperationContext,
  input: DelegationImportArtifact,
): Promise<OperationExecutionOutcome<AuthImportOutput>> {
  try {
    return await withProfileLock(context.summary.profile, async () => {
      const sessionDid = await currentSessionDid(context.summary.profile);
      if (sessionDid === undefined) return missingSession();
      if (
        context.summary.sessionDid === undefined ||
        !samePrincipal(context.summary.sessionDid, sessionDid)
      ) {
        return audienceMismatch(sessionDid, context.summary.sessionDid ?? "unknown");
      }

      const requests = await listPermissionRequests(context.summary.profile);
      const request = requests.find((candidate) => candidate.requestId === input.requestId);
      if (request === undefined || request.profile !== context.summary.profile) {
        return operationFailure(
          "DELEGATION_ARTIFACT_INVALID",
          "The delegation does not reference a stored request for this profile.",
        );
      }
      if (normalizeHost(request.host) !== normalizeHost(context.summary.host)) {
        return hostMismatch(context.summary.host, request.host);
      }
      if (!samePrincipal(request.sessionDid, sessionDid)) {
        return audienceMismatch(sessionDid, request.sessionDid);
      }

      const rawDelegation = input.delegation as unknown as Record<string, unknown>;
      const explicitHost = rawDelegation.host;
      if (explicitHost !== undefined && typeof explicitHost !== "string") {
        return invalidDelegation();
      }
      if (typeof explicitHost === "string" && normalizeHost(explicitHost) !== normalizeHost(request.host)) {
        return hostMismatch(request.host, explicitHost);
      }
      const expiry = normalizeExpiry(rawDelegation.expiry);
      if (expiry === undefined) return invalidDelegation();
      if (expiry.getTime() <= Date.now()) return expiredDelegation();
      if (input.delegationCid !== undefined && input.delegationCid !== rawDelegation.cid) {
        return invalidDelegation();
      }
      if (typeof rawDelegation.delegateDID !== "string" || !samePrincipal(rawDelegation.delegateDID, sessionDid)) {
        return audienceMismatch(sessionDid, String(rawDelegation.delegateDID ?? "unknown"));
      }

      const delegation = {
        ...rawDelegation,
        expiry,
        host: explicitHost ?? request.host,
      } as PortableDelegation;
      let activated: Awaited<ReturnType<typeof activateValidatedRuntimeDelegation>>;
      try {
        activated = await activateValidatedRuntimeDelegation(
          context.runtime.node as RuntimeDelegationActivator,
          delegation,
          { host: request.host },
        );
      } catch {
        return operationFailure(
          "DELEGATION_REJECTED",
          "The delegation was rejected by the TinyCloud runtime.",
        );
      }

      const effectivePermissions = canonicalizeCapabilities(activated.effectivePermissions);
      if (!evaluateAuthority(request.requested, effectivePermissions).satisfied) {
        return operationFailure(
          "DELEGATION_REJECTED",
          "The delegation exceeds the stored authority request.",
        );
      }

      const sessionAfterActivation = await currentSessionDid(context.summary.profile);
      if (sessionAfterActivation === undefined || !samePrincipal(sessionAfterActivation, sessionDid)) {
        return audienceMismatch(sessionAfterActivation ?? "unknown", sessionDid);
      }
      const alreadyPresent = await updateProfileStoreWhileLocked<Record<string, unknown>, boolean>(
        context.summary.profile,
        "additional-delegations",
        (records) => {
          const exists = records.some((entry) => delegationCid(entry) === activated.cid);
          return {
            records: exists
              ? records
              : [...records, {
                delegation: activated.delegation,
                permissions: activated.effectivePermissions,
              }],
            result: exists,
          };
        },
      );
      return {
        status: "ok",
        output: {
          cid: activated.cid,
          effectivePermissions,
          expiry: activated.expiry.toISOString(),
          audience: activated.audience,
          host: activated.host,
          activated: true,
          alreadyPresent,
        },
      };
    });
  } catch {
    return internalImportFailure();
  }
}

function exactCapabilities(value: unknown): PermissionEntry[] | undefined {
  return validateExactCapabilities(value);
}

function normalizeExpiry(value: unknown): Date | undefined {
  const expiry = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  return expiry !== undefined && !Number.isNaN(expiry.getTime()) ? expiry : undefined;
}

function normalizeHost(host: string): string {
  return host.replace(/\/+$/, "");
}

function samePrincipal(left: string, right: string): boolean {
  return left.split("#", 1)[0] === right.split("#", 1)[0];
}

function delegationCid(value: Record<string, unknown>): string | undefined {
  const delegation = value.delegation;
  if (delegation === null || typeof delegation !== "object") return undefined;
  const cid = (delegation as { cid?: unknown }).cid;
  return typeof cid === "string" ? cid : undefined;
}

async function currentSessionDid(profile: string): Promise<string | undefined> {
  const session = await readSession<Record<string, unknown>>(profile);
  if (session === null || typeof session.verificationMethod !== "string") return undefined;
  return session.verificationMethod.split("#", 1)[0] || undefined;
}

function missingSession(): OperationExecutionOutcome<never> {
  return operationFailure("SESSION_NOT_FOUND", "The selected profile does not have an active session.");
}

function invalidDelegation(): OperationExecutionOutcome<never> {
  return operationFailure("DELEGATION_ARTIFACT_INVALID", "The delegation artifact is invalid.");
}

function expiredDelegation(): OperationExecutionOutcome<never> {
  return operationFailure("DELEGATION_EXPIRED", "The delegation has expired.");
}

function audienceMismatch(expectedSessionDid: string, artifactAudience: string): OperationExecutionOutcome<never> {
  return operationFailure("DELEGATION_AUDIENCE_MISMATCH", "The delegation is for a different session.", {
    expectedSessionDid,
    artifactAudience,
  });
}

function hostMismatch(expectedHost: string, artifactHost: string): OperationExecutionOutcome<never> {
  return operationFailure("DELEGATION_HOST_MISMATCH", "The delegation is for a different host.", {
    expectedHost,
    artifactHost,
  });
}

function invalidInput(message: string): OperationExecutionOutcome<never> {
  return operationFailure("INPUT_INVALID", message);
}

function internalFailure(): OperationExecutionOutcome<never> {
  return operationFailure("INTERNAL_ERROR", "The authority request could not be completed.");
}

function internalImportFailure(): OperationExecutionOutcome<never> {
  return operationFailure("INTERNAL_ERROR", "The delegation import could not be completed.");
}

function operationFailure(
  code: Parameters<typeof operationError>[0],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): OperationExecutionOutcome<never> {
  return { status: "error", error: operationError(code, message, { ...(details === undefined ? {} : { details }) }) };
}
