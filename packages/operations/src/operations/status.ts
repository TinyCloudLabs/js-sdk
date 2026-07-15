import { z } from "zod";

import type {
  OperationContext,
  OperationDefinition,
  OperationExecutionOutcome,
  OperationExposure,
  OperationSensitivity,
  TinyCloudPosture,
} from "../contract.js";
import { operationError } from "../errors.js";
import {
  additionalDelegationsPath,
  readJson,
  readProfile,
  readSession,
  readStoreMetadata,
} from "../state.js";

type StatusInput = Record<never, never>;

interface StatusOutput {
  readonly profile: string;
  readonly host: string;
  readonly posture: TinyCloudPosture;
  readonly operatorType?: "human" | "agent";
  readonly principalDid?: string;
  readonly sessionDid?: string;
  readonly ownerDid?: string;
  readonly space?: string;
  readonly session: {
    readonly present: boolean;
    readonly expired: boolean | null;
    readonly expiresAt: string | null;
  };
  readonly liveAdditionalDelegationCount: number;
}

const StatusInputSchema: z.ZodType<StatusInput> = z.object({}).strict();

const StatusOutputSchema: z.ZodType<StatusOutput> = z.object({
  profile: z.string().min(1),
  host: z.string().min(1),
  posture: z.enum([
    "owner-openkey",
    "delegate-session",
    "local-owner-key",
    "unauthenticated",
  ]),
  operatorType: z.enum(["human", "agent"]).optional(),
  principalDid: z.string().min(1).optional(),
  sessionDid: z.string().min(1).optional(),
  ownerDid: z.string().min(1).optional(),
  space: z.string().min(1).optional(),
  session: z.object({
    present: z.boolean(),
    expired: z.boolean().nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
  liveAdditionalDelegationCount: z.number().int().nonnegative(),
}).strict();

const STATUS_POSTURES: readonly TinyCloudPosture[] = [
  "owner-openkey",
  "delegate-session",
  "local-owner-key",
  "unauthenticated",
];

const STATUS_EXPOSURE: OperationExposure = {
  cli: { status: "required" },
  mcp: { status: "required" },
  skill: { status: "required" },
  docs: { status: "required" },
};

const STATUS_SENSITIVITY: OperationSensitivity = { input: [], output: [] };

/**
 * Internal I2 definition material. The registry integration owner imports this
 * collection; package entrypoints intentionally do not expose these handlers.
 */
export const statusOperationDefinitions: readonly OperationDefinition<StatusInput, StatusOutput>[] = [
  createStatusDefinition({
    id: "tinycloud.status.get",
    title: "TinyCloud status",
    description: "Inspect the selected TinyCloud profile's safe local status.",
  }),
  createStatusDefinition({
    id: "tinycloud.auth.status",
    title: "TinyCloud authentication status",
    description: "Inspect the selected TinyCloud profile's safe authentication status.",
  }),
];

function createStatusDefinition(params: Readonly<{
  id: "tinycloud.status.get" | "tinycloud.auth.status";
  title: string;
  description: string;
}>): OperationDefinition<StatusInput, StatusOutput> {
  return {
    id: params.id,
    version: 1,
    title: params.title,
    description: params.description,
    input: StatusInputSchema,
    output: StatusOutputSchema,
    effects: ["read"],
    runtime: "inspection",
    postures: STATUS_POSTURES,
    exposure: STATUS_EXPOSURE,
    sensitivity: STATUS_SENSITIVITY,
    authority: async () => [],
    execute: inspectPinnedProfileStatus,
  };
}

async function inspectPinnedProfileStatus(
  context: OperationContext,
  _input: StatusInput,
): Promise<OperationExecutionOutcome<StatusOutput>> {
  const profile = context.summary.profile;
  if (!(await pinnedProfileExists(profile))) return profileNotFound(profile);

  try {
    const [session, liveAdditionalDelegationCount] = await Promise.all([
      readSession<Record<string, unknown>>(profile),
      countLiveAdditionalDelegations(profile),
    ]);
    const sessionSummary = summarizeSession(session);

    return {
      status: "ok",
      output: {
        profile,
        host: context.summary.host,
        posture: context.summary.posture,
        ...(context.summary.operatorType === undefined
          ? {}
          : { operatorType: context.summary.operatorType }),
        ...(context.summary.principalDid === undefined
          ? {}
          : { principalDid: context.summary.principalDid }),
        ...(context.summary.sessionDid === undefined
          ? {}
          : { sessionDid: context.summary.sessionDid }),
        ...(context.summary.ownerDid === undefined
          ? {}
          : { ownerDid: context.summary.ownerDid }),
        ...(context.summary.space === undefined ? {} : { space: context.summary.space }),
        session: sessionSummary,
        liveAdditionalDelegationCount,
      },
    };
  } catch {
    // Store contents may contain keys, session material, or delegation bytes.
    // A state-inspection failure must not relay any part of that material.
    return {
      status: "error",
      error: operationError(
        "INTERNAL_ERROR",
        "The profile state could not be inspected.",
      ),
    };
  }
}

async function pinnedProfileExists(profile: string): Promise<boolean> {
  try {
    const storedProfile = await readProfile<Record<string, unknown>>(profile);
    return isRecord(storedProfile);
  } catch {
    return false;
  }
}

async function countLiveAdditionalDelegations(profile: string): Promise<number> {
  await readStoreMetadata(profile, "additional-delegations");
  const rawDelegations = await readJson<unknown>(additionalDelegationsPath(profile));
  if (rawDelegations === null) return 0;
  if (!Array.isArray(rawDelegations)) throw new TypeError("Invalid additional delegation store.");

  const now = Date.now();
  let count = 0;
  for (const entry of rawDelegations) {
    const expiry = storedDelegationExpiry(entry);
    if (expiry.getTime() > now) count += 1;
  }
  return count;
}

function summarizeSession(session: Record<string, unknown> | null): StatusOutput["session"] {
  if (session === null) return { present: false, expired: null, expiresAt: null };
  if (!isRecord(session)) throw new TypeError("Invalid session store.");

  const expiry = extractSessionExpiry(session);
  if (expiry === null) return { present: true, expired: null, expiresAt: null };

  return {
    present: true,
    expired: expiry.getTime() <= Date.now(),
    expiresAt: expiry.toISOString(),
  };
}

function storedDelegationExpiry(entry: unknown): Date {
  if (!isRecord(entry) || !isRecord(entry.delegation) || !("expiry" in entry.delegation)) {
    throw new TypeError("Invalid stored delegation.");
  }
  return parseExpiry(entry.delegation.expiry);
}

function extractSessionExpiry(session: Record<string, unknown>): Date | null {
  for (const field of ["expiresAt", "expiry", "expirationTime"] as const) {
    if (!(field in session) || session[field] === undefined || session[field] === null) continue;
    return parseExpiry(session[field]);
  }

  if (!("siwe" in session) || session.siwe === undefined || session.siwe === null) return null;
  if (typeof session.siwe !== "string") throw new TypeError("Invalid session expiry.");
  const match = session.siwe.match(/^Expiration Time:\s*(.+)$/im);
  return match === null ? null : parseExpiry(match[1].trim());
}

function parseExpiry(value: unknown): Date {
  const date = value instanceof Date
    ? value
    : typeof value === "number" && Number.isFinite(value)
    ? new Date(value > 0 && value < 1_000_000_000_000 ? value * 1_000 : value)
    : typeof value === "string" && value.trim() !== ""
    ? new Date(value)
    : null;
  if (date === null || Number.isNaN(date.getTime())) throw new TypeError("Invalid expiry.");
  return date;
}

function profileNotFound(profile: string): OperationExecutionOutcome<never> {
  return {
    status: "error",
    error: operationError(
      "PROFILE_NOT_FOUND",
      `Profile "${profile}" is not available.`,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
