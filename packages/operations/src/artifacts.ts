import { randomUUID } from "node:crypto";

import type { PermissionEntry } from "@tinycloud/sdk-core";
import { z } from "zod";

import {
  canonicalizeCapabilities,
  evaluateAuthority,
} from "./authority.js";
import type {
  OperationOperatorType,
  TinyCloudPosture,
} from "./contract.js";
import { readAuthRequests, updateProfileStore } from "./state.js";

export { evaluateAuthority } from "./authority.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

/** The shared wire schema for SDK PermissionEntry values, including signed ReCap caveats. */
export const PermissionEntrySchema = z.object({
  service: z.string().min(1),
  space: z.string().min(1).optional(),
  path: z.string(),
  actions: z.array(z.string().min(1)).min(1),
  caveats: z.array(z.record(z.unknown())).optional(),
  skipPrefix: z.boolean().optional(),
  expiry: z.string().min(1).optional(),
  description: z.string().optional(),
}).strict();

const CommandSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
}).strict();

const LegacyPermissionRequestArtifactSchema = z.object({
  kind: z.literal("tinycloud.auth.request"),
  version: z.literal(1),
  requestId: z.string(),
  sessionDid: z.string().min(1),
  requested: z.array(PermissionEntrySchema),
  requestedExpiry: z.union([z.string(), z.number().finite()]).optional(),
}).strict();

const PortableDelegationSchema: z.ZodType<Record<string, unknown>> = z.lazy(() => z.object({
  cid: z.string().min(1),
  spaceId: z.string().min(1),
  path: z.string(),
  actions: z.array(z.string().min(1)).min(1),
  delegateDID: z.string().min(1),
  ownerAddress: z.string().min(1),
  chainId: z.number().int().positive(),
  expiry: z.union([z.string().datetime({ offset: true }), z.date()]),
  delegationHeader: z.object({ Authorization: z.string().min(1) }).strict(),
  host: z.string().min(1).optional(),
  disableSubDelegation: z.boolean().optional(),
  publicDelegation: PortableDelegationSchema.optional(),
  resources: z.array(PermissionEntrySchema).optional(),
}).passthrough());

/** Canonical wire-format v1 request retained for CLI and OpenKey compatibility. */
export const PermissionRequestArtifactSchema = z.object({
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
  requestedExpiry: z.union([z.string().min(1), z.number().finite()]).optional(),
  requested: z.array(PermissionEntrySchema),
  command: CommandSchema.optional(),
}).strict();

/** Canonical structured v1 delegation import accepted by the auth operation. */
export const DelegationImportArtifactSchema = z.object({
  kind: z.literal("tinycloud.auth.delegation"),
  version: z.literal(1),
  requestId: z.string().min(1),
  delegationCid: z.string().min(1).optional(),
  delegation: PortableDelegationSchema,
  // This field is presentation metadata only. A later import operation obtains
  // effective permissions from validated, installed delegation authority.
  permissions: z.array(PermissionEntrySchema).optional(),
  expiry: z.string().datetime({ offset: true }).optional(),
  prompted: z.boolean().optional(),
}).strict();

export type PermissionRequestArtifact = z.infer<typeof PermissionRequestArtifactSchema>;
export type DelegationImportArtifact = z.infer<typeof DelegationImportArtifactSchema>;
/** The minimal public node-sdk request shape accepted by the legacy reader. */
export type LegacyPermissionRequestArtifact = z.infer<typeof LegacyPermissionRequestArtifactSchema>;
export type ArtifactClock = () => Date;
export type RequestIdSource = () => string;

/** Invocation-owned values used to safely complete a legacy request record. */
export interface LegacyRequestContext {
  readonly profile: string;
  readonly host: string;
  readonly sessionDid: string;
  readonly posture: TinyCloudPosture;
  readonly operatorType: OperationOperatorType;
  readonly ownerDid?: string;
  readonly spaceId?: string;
  readonly now?: Date;
}

export interface PermissionRequestIdentityInput {
  readonly profile: string;
  readonly sessionDid: string;
  readonly host: string;
  readonly missing: readonly PermissionEntry[];
}

export interface BuildPermissionRequestArtifactInput extends PermissionRequestIdentityInput {
  readonly posture: TinyCloudPosture;
  readonly operatorType: OperationOperatorType;
  readonly ownerDid?: string;
  readonly spaceId?: string;
  readonly requestedExpiry?: string | number;
  readonly command?: { readonly argv: readonly string[]; readonly cwd: string };
  readonly now?: ArtifactClock;
  readonly createRequestId?: RequestIdSource;
}

export interface CreateOrReusePermissionRequestInput extends BuildPermissionRequestArtifactInput {
  readonly granted: readonly PermissionEntry[];
  readonly replace?: boolean;
}

export type PermissionRequestResolution =
  | Readonly<{ status: "satisfied"; reused: false }>
  | Readonly<{ status: "created"; reused: boolean; request: PermissionRequestArtifact }>;

/** Parses a request artifact without accepting a newer wire format as v1. */
export function validatePermissionRequestArtifact(value: unknown): PermissionRequestArtifact {
  return PermissionRequestArtifactSchema.parse(value);
}

/** Parses a structured active-session import artifact without accepting a newer wire format as v1. */
export function validateDelegationImportArtifact(value: unknown): DelegationImportArtifact {
  return DelegationImportArtifactSchema.parse(value);
}

export function isPermissionRequestArtifact(value: unknown): value is PermissionRequestArtifact {
  return PermissionRequestArtifactSchema.safeParse(value).success;
}

export function isDelegationImportArtifact(value: unknown): value is DelegationImportArtifact {
  return DelegationImportArtifactSchema.safeParse(value).success;
}

function normalizeLegacyPermissionRequest(
  value: LegacyPermissionRequestArtifact,
  context: LegacyRequestContext,
): PermissionRequestArtifact {
  if (principal(value.sessionDid) !== principal(context.sessionDid)) {
    throw new TypeError("Stored authority request belongs to a different session.");
  }
  const createdAt = context.now ?? new Date();
  if (Number.isNaN(createdAt.getTime())) {
    throw new TypeError("The legacy authority request has no usable creation time.");
  }
  return {
    kind: "tinycloud.auth.request",
    version: 1,
    requestId: value.requestId,
    createdAt: createdAt.toISOString(),
    profile: context.profile,
    posture: context.posture,
    operatorType: context.operatorType,
    host: context.host,
    sessionDid: context.sessionDid,
    ...(context.ownerDid === undefined ? {} : { ownerDid: context.ownerDid }),
    ...(context.spaceId === undefined ? {} : { spaceId: context.spaceId }),
    ...(value.requestedExpiry === undefined ? {} : { requestedExpiry: value.requestedExpiry }),
    requested: canonicalizeCapabilities(value.requested),
  } as PermissionRequestArtifact;
}

function principal(value: string): string {
  return value.split("#", 1)[0]!;
}

/**
 * Stable exact identity used only for request reuse. It binds a request to its
 * selected profile, active session DID, host, and canonical missing subset.
 */
export function createPermissionRequestIdentity(input: PermissionRequestIdentityInput): string {
  return JSON.stringify({
    profile: input.profile,
    sessionDid: input.sessionDid,
    host: input.host,
    missing: canonicalizeCapabilities(input.missing),
  });
}

/** Builds an on-disk-compatible v1 record. Omitted values stay omitted. */
export function buildPermissionRequestArtifact(
  input: BuildPermissionRequestArtifactInput,
): PermissionRequestArtifact {
  const now = input.now ?? (() => new Date());
  const createdAt = now();
  if (Number.isNaN(createdAt.getTime())) throw new TypeError("The artifact clock returned an invalid date.");
  const requested = canonicalizeCapabilities(input.missing);
  if (requested.length === 0) throw new TypeError("Permission requests require at least one missing capability.");

  return validatePermissionRequestArtifact({
    kind: "tinycloud.auth.request",
    version: 1,
    requestId: input.createRequestId?.() ?? defaultRequestId(createdAt),
    createdAt: createdAt.toISOString(),
    profile: input.profile,
    posture: input.posture,
    operatorType: input.operatorType,
    host: input.host,
    sessionDid: input.sessionDid,
    ...(input.ownerDid !== undefined ? { ownerDid: input.ownerDid } : {}),
    ...(input.spaceId !== undefined ? { spaceId: input.spaceId } : {}),
    ...(input.requestedExpiry !== undefined ? { requestedExpiry: input.requestedExpiry } : {}),
    requested,
    ...(input.command !== undefined
      ? { command: { argv: [...input.command.argv], cwd: input.command.cwd } }
      : {}),
  });
}

/** Reads only valid canonical v1 records and refuses malformed stored artifacts. */
export async function listPermissionRequests(
  profile: string,
  context?: LegacyRequestContext,
): Promise<PermissionRequestArtifact[]> {
  return (await readAuthRequests<unknown>(profile)).map((value) => {
    const canonical = PermissionRequestArtifactSchema.safeParse(value);
    if (canonical.success) return canonical.data;
    const legacy = LegacyPermissionRequestArtifactSchema.safeParse(value);
    if (!legacy.success) throw new TypeError("Stored authority request is malformed.");
    if (context === undefined) {
      throw new TypeError("Legacy authority requests require the selected invocation context.");
    }
    return normalizeLegacyPermissionRequest(legacy.data, context);
  });
}

export async function findPermissionRequest(
  profile: string,
  requestId: string,
  identity: Pick<PermissionRequestIdentityInput, "sessionDid" | "host"> &
    Partial<Omit<LegacyRequestContext, "profile" | "host" | "sessionDid">>,
): Promise<PermissionRequestArtifact | null> {
  const records = await listPermissionRequests(profile, {
    profile,
    host: identity.host,
    sessionDid: identity.sessionDid,
    posture: identity.posture ?? "delegate-session",
    operatorType: identity.operatorType ?? "human",
    ...(identity.ownerDid === undefined ? {} : { ownerDid: identity.ownerDid }),
    ...(identity.spaceId === undefined ? {} : { spaceId: identity.spaceId }),
  });
  return records.find((record) =>
    record.requestId === requestId &&
    record.sessionDid === identity.sessionDid &&
    record.host === identity.host,
  ) ?? null;
}

/**
 * Atomically returns the newest identical unresolved request, or writes a new
 * v1 record. Retention, stale-session pruning, covered-record pruning, and
 * partial-grant supersession all happen in the same existing profile lock.
 */
export async function createOrReusePermissionRequest(
  input: CreateOrReusePermissionRequestInput,
): Promise<PermissionRequestResolution> {
  const missing = evaluateAuthority(input.granted, input.missing).missing;
  const now = input.now ?? (() => new Date());
  const observedNow = now();
  if (Number.isNaN(observedNow.getTime())) throw new TypeError("The artifact clock returned an invalid date.");

  return updateProfileStore<unknown, PermissionRequestResolution>(
    input.profile,
    "auth-requests",
    (rawRecords) => {
      const records = rawRecords.map((value) => {
        const canonical = PermissionRequestArtifactSchema.safeParse(value);
        if (canonical.success) return canonical.data;
        const legacy = LegacyPermissionRequestArtifactSchema.safeParse(value);
        if (!legacy.success) throw new TypeError("Stored authority request is malformed.");
        return normalizeLegacyPermissionRequest(legacy.data, {
          profile: input.profile,
          host: input.host,
          sessionDid: input.sessionDid,
          posture: input.posture,
          operatorType: input.operatorType,
          ...(input.ownerDid === undefined ? {} : { ownerDid: input.ownerDid }),
          ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
          now: observedNow,
        });
      });
      const retained = prunePermissionRequests(records, {
        profile: input.profile,
        sessionDid: input.sessionDid,
        granted: input.granted,
        now: observedNow,
      });

      if (missing.length === 0) {
        return { records: retained, result: { status: "satisfied", reused: false } };
      }

      const identity = createPermissionRequestIdentity({ ...input, missing });
      const withoutSuperseded = retained.filter((record) => !isSupersededBy(record, input, missing));
      const equivalent = newestEquivalentRequest(withoutSuperseded, identity);
      if (equivalent !== undefined && input.replace !== true) {
        return { records: withoutSuperseded, result: { status: "created", reused: true, request: equivalent } };
      }

      const next = withoutSuperseded.filter((record) =>
        input.replace !== true || permissionRequestArtifactIdentity(record) !== identity,
      );
      const request = buildPermissionRequestArtifact({ ...input, missing, now: () => observedNow });
      return {
        records: [...next, request],
        result: { status: "created", reused: false, request },
      };
    },
  );
}

export interface PrunePermissionRequestsInput {
  readonly profile: string;
  readonly sessionDid: string;
  readonly granted: readonly PermissionEntry[];
  readonly now: Date;
}

/** Pure retention policy used by the locked persistence operation. */
export function prunePermissionRequests(
  records: readonly PermissionRequestArtifact[],
  input: PrunePermissionRequestsInput,
): PermissionRequestArtifact[] {
  const cutoff = input.now.getTime() - THIRTY_DAYS_MS;
  return records.filter((record) => {
    const createdAt = Date.parse(record.createdAt);
    if (!Number.isFinite(createdAt) || createdAt < cutoff) return false;
    if (record.profile === input.profile && record.sessionDid !== input.sessionDid) return false;
    // Empty request arrays are historical CLI records. They carry no
    // authority, but remain readable and are retained byte-for-byte by the
    // shared format-1 writer for compatibility.
    if (record.requested.length === 0) return true;
    return !evaluateAuthority(input.granted, record.requested).satisfied;
  });
}

function newestEquivalentRequest(
  records: readonly PermissionRequestArtifact[],
  identity: string,
): PermissionRequestArtifact | undefined {
  let newest: PermissionRequestArtifact | undefined;
  for (const record of records) {
    if (permissionRequestArtifactIdentity(record) !== identity) continue;
    if (newest === undefined || record.createdAt >= newest.createdAt) newest = record;
  }
  return newest;
}

function isSupersededBy(
  record: PermissionRequestArtifact,
  input: CreateOrReusePermissionRequestInput,
  missing: readonly PermissionEntry[],
): boolean {
  if (
    record.profile !== input.profile ||
    record.sessionDid !== input.sessionDid ||
    record.host !== input.host
  ) {
    return false;
  }
  const remaining = evaluateAuthority(input.granted, record.requested).missing;
  return remaining.length > 0 &&
    permissionRequestArtifactIdentity(record) !==
      createPermissionRequestIdentity({ ...input, missing }) &&
    createPermissionRequestIdentity({ ...input, missing: remaining }) ===
      createPermissionRequestIdentity({ ...input, missing });
}

function permissionRequestArtifactIdentity(record: PermissionRequestArtifact): string {
  return createPermissionRequestIdentity({
    profile: record.profile,
    sessionDid: record.sessionDid,
    host: record.host,
    missing: record.requested,
  });
}

function defaultRequestId(now: Date): string {
  return `req_${now.getTime().toString(36)}_${randomUUID().replace(/-/g, "")}`;
}
