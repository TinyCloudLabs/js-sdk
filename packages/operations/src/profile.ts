import {
  DEFAULT_PROFILE,
  readJson,
  readProfile,
  tinycloudConfigPath,
} from "./state.js";

const DEFAULT_HOST = "https://node.tinycloud.xyz";

export type TinyCloudPosture =
  | "owner-openkey"
  | "delegate-session"
  | "local-owner-key"
  | "unauthenticated";

export type TinyCloudOperatorType = "human" | "agent";

/**
 * This intentionally contains only selection inputs. In particular, callers
 * may carry a CLI private-key override elsewhere, but profile resolution never
 * reads or returns it.
 */
export interface InvocationTarget {
  profile?: string;
  host?: string;
  allowOwnerProfile?: boolean;
  privateKey?: string;
}

export interface SafeInvocationContext {
  profile: string;
  host: string;
  posture: TinyCloudPosture;
  operatorType: TinyCloudOperatorType;
  principalDid?: string;
  sessionDid?: string;
  ownerDid?: string;
  space?: string;
}

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

interface StoredProfile {
  host?: unknown;
  did?: unknown;
  sessionDid?: unknown;
  ownerDid?: unknown;
  spaceId?: unknown;
  posture?: unknown;
  operatorType?: unknown;
  authMethod?: unknown;
}

/**
 * Resolves one selected profile to safe identity data. Resolution is deliberately
 * one-way: after selecting a name, any missing, malformed, or unreadable
 * profile is PROFILE_NOT_FOUND rather than a reason to choose another profile.
 */
export async function resolveInvocationContext(
  target: InvocationTarget = {},
): Promise<InvocationContextResolution> {
  const profile = await resolveProfileName(target);
  let storedProfile: StoredProfile | null;
  try {
    storedProfile = await readProfile<StoredProfile>(profile);
  } catch {
    return profileNotFound(profile);
  }

  if (storedProfile === null || !isRecord(storedProfile)) {
    return profileNotFound(profile);
  }

  const host = firstString(target.host, process.env.TC_HOST, storedProfile.host, DEFAULT_HOST);
  const posture = resolvePosture(storedProfile);

  return {
    ok: true,
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

function resolvePosture(profile: StoredProfile): TinyCloudPosture {
  if (isPosture(profile.posture)) return profile.posture;
  if (profile.authMethod === "local") return "local-owner-key";
  return "owner-openkey";
}

function profileNotFound(profile: string): InvocationContextResolution {
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

function isOperatorType(value: unknown): value is TinyCloudOperatorType {
  return value === "human" || value === "agent";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
