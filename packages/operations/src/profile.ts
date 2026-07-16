import {
  DEFAULT_PROFILE,
  readJson,
  readProfile,
  tinycloudConfigPath,
} from "./state.js";
import type {
  InvocationTarget,
  OperationContextSummary,
  OperationOperatorType,
  TinyCloudPosture,
} from "./contract.js";

const DEFAULT_HOST = "https://node.tinycloud.xyz";

export type SafeInvocationContext = OperationContextSummary & {
  operatorType: OperationOperatorType;
};

export type InvocationContextResolution =
  | { ok: true; context: SafeInvocationContext }
  | {
    ok: false;
    error: {
      code: "PROFILE_NOT_FOUND";
      message: string;
      retryable: false;
    };
  };

interface GlobalConfig {
  defaultProfile?: unknown;
}

/** Validated profile material retained only inside runtime resolution. */
export type StoredProfile = {
  name: string;
  host: string;
  chainId: number;
  spaceName: string;
  did: string;
  createdAt: string;
  sessionDid?: unknown;
  ownerDid?: unknown;
  spaceId?: unknown;
  posture?: unknown;
  operatorType?: unknown;
  authMethod?: unknown;
  defaultSpace?: unknown;
  privateKey?: unknown;
  address?: unknown;
  openkeyHost?: unknown;
};

/** Profile snapshot plus its derived safe invocation context. */
export type InvocationProfileResolution =
  | { ok: true; profile: StoredProfile; context: SafeInvocationContext }
  | Extract<InvocationContextResolution, { ok: false }>;

/**
 * Resolves one selected profile to safe identity data. Resolution is deliberately
 * one-way: after selecting a name, any missing, malformed, or unreadable
 * profile is PROFILE_NOT_FOUND rather than a reason to choose another profile.
 */
export async function resolveInvocationContext(
  target: InvocationTarget = {},
): Promise<InvocationContextResolution> {
  const resolved = await resolveInvocationProfile(target);
  return resolved.ok ? { ok: true, context: resolved.context } : resolved;
}

/** Resolves the selected profile and its safe context from one profile read. */
export async function resolveInvocationProfile(
  target: InvocationTarget = {},
): Promise<InvocationProfileResolution> {
  const profile = await resolveProfileName(target);
  let storedProfile: StoredProfile | null;
  try {
    storedProfile = await readProfile<StoredProfile>(profile);
  } catch {
    return profileNotFound(profile);
  }

  if (!isStoredProfile(storedProfile)) {
    return profileNotFound(profile);
  }
  if (!isCoherentProfile(storedProfile)) {
    return profileNotFound(profile);
  }

  const host = firstString(target.host, process.env.TC_HOST, storedProfile.host, DEFAULT_HOST);
  const posture = resolvePosture(storedProfile);

  return {
    ok: true,
    profile: storedProfile,
    context: {
      profile,
      host,
      posture,
      operatorType: isOperatorType(storedProfile.operatorType) ? storedProfile.operatorType : "human",
      principalDid: maybeDid(storedProfile.did),
      sessionDid: maybeDid(storedProfile.sessionDid),
      ownerDid: maybeDid(storedProfile.ownerDid),
      space: typeof storedProfile.spaceId === "string" ? storedProfile.spaceId : undefined,
    },
  };
}

async function resolveProfileName(target: InvocationTarget): Promise<string> {
  if (typeof target.profile === "string") return target.profile;
  if (typeof process.env.TC_PROFILE === "string") return process.env.TC_PROFILE;

  try {
    const config = await readJson<GlobalConfig>(tinycloudConfigPath());
    if (typeof config?.defaultProfile === "string") return config.defaultProfile;
  } catch {
    // Config only chooses the initial name. A missing or malformed config falls
    // back to the documented default, never to another existing profile.
  }
  return DEFAULT_PROFILE;
}

/** Derives the effective posture without consulting any later profile read. */
export function resolvePosture(profile: Pick<StoredProfile, "posture" | "authMethod">): TinyCloudPosture {
  if (isPosture(profile.posture)) return profile.posture;
  if (profile.authMethod === "local") return "local-owner-key";
  return "owner-openkey";
}

function profileNotFound(profile: string): Extract<InvocationContextResolution, { ok: false }> {
  return {
    ok: false,
    error: {
      code: "PROFILE_NOT_FOUND",
      message: `Profile "${profile}" is not available.`,
      retryable: false,
    },
  };
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return DEFAULT_HOST;
}

function maybeDid(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const fragment = value.indexOf("#");
  return fragment === -1 ? value : value.slice(0, fragment);
}

function isPosture(value: unknown): value is TinyCloudPosture {
  return value === "owner-openkey" ||
    value === "delegate-session" ||
    value === "local-owner-key" ||
    value === "unauthenticated";
}

function isOperatorType(value: unknown): value is OperationOperatorType {
  return value === "human" || value === "agent";
}

/**
 * The CLI's original persisted profile format required these six fields.
 * Posture and operator fields arrived later, so they remain optional while
 * any present typed field must still have its documented shape.
 */
function isStoredProfile(value: unknown): value is StoredProfile {
  return isRecord(value) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.host) &&
    typeof value.chainId === "number" &&
    Number.isFinite(value.chainId) &&
    isNonEmptyString(value.spaceName) &&
    isNonEmptyString(value.did) &&
    isNonEmptyString(value.createdAt) &&
    isOptionalNonEmptyString(value.sessionDid) &&
    isOptionalNonEmptyString(value.ownerDid) &&
    isOptionalNonEmptyString(value.spaceId) &&
    isOptionalPosture(value.posture) &&
    isOptionalOperatorType(value.operatorType) &&
    isOptionalAuthMethod(value.authMethod) &&
    isOptionalNonEmptyString(value.defaultSpace) &&
    isOptionalNonEmptyString(value.privateKey) &&
    isOptionalNonEmptyString(value.address) &&
    isOptionalNonEmptyString(value.openkeyHost);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isOptionalPosture(value: unknown): boolean {
  return value === undefined || isPosture(value);
}

function isOptionalOperatorType(value: unknown): boolean {
  return value === undefined || isOperatorType(value);
}

function isOptionalAuthMethod(value: unknown): boolean {
  return value === undefined || value === "openkey" || value === "local";
}

/**
 * Local-key authentication is owner authentication. A persisted delegate or
 * OpenKey posture must never be allowed to select that path later in runtime
 * construction, so reject the inconsistent profile before policy inspection.
 */
function isCoherentProfile(profile: StoredProfile): boolean {
  if (profile.authMethod === "local") {
    return profile.posture === undefined || profile.posture === "local-owner-key";
  }
  if (profile.posture === "local-owner-key") {
    return profile.authMethod === "local";
  }
  return true;
}
