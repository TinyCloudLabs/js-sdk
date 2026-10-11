import type { TinyCloudPosture } from "./contract.js";

/**
 * What a caller does to recover from an operation error it cannot retry. The
 * single source of truth for recovery commands: operations attach it to error
 * details, and projections render hints from it.
 */
export type OperationRecovery =
  | { readonly action: "sign_in"; readonly command?: string }
  | {
    readonly action: "complete_migration";
    readonly command?: string;
    readonly operationId: typeof MIGRATION_OPERATION_ID;
  };

/**
 * Profile names that may appear in a command. Profile names are any single
 * path segment, so a name outside this token gets a recovery without a
 * `command`: an agent never receives a command built from an unsafe string.
 */
export const SAFE_PROFILE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Runs the authenticated runtime on the profile's own restored session, which completes its migration. */
const MIGRATION_OPERATION_ID = "tinycloud.auth.capabilities";

const SIGN_IN_TEMPLATES: Readonly<Record<"local" | "openkey" | "scoped", (profile: string) => string>> = {
  local: (profile) => `tc --profile ${profile} auth login --method local`,
  openkey: (profile) => `tc --profile ${profile} auth login --method openkey`,
  scoped: (profile) => `tc --profile ${profile} auth login --method openkey --paste --manifest <manifest.json>`,
};

const migrationCommand = (profile: string): string => `tc --profile ${profile} auth caps`;

/**
 * The persistent login (one that writes a stored session) for a profile of
 * this posture. A delegate profile needs its owner to approve a scoped login.
 */
export function signInRecovery(profile: string, posture: TinyCloudPosture): OperationRecovery {
  if (!SAFE_PROFILE_TOKEN.test(profile)) return { action: "sign_in" };
  const template = posture === "local-owner-key"
    ? SIGN_IN_TEMPLATES.local
    : posture === "delegate-session"
    ? SIGN_IN_TEMPLATES.scoped
    : SIGN_IN_TEMPLATES.openkey;
  return { action: "sign_in", command: template(profile) };
}

/** One authenticated command on the profile's own session finishes its one-time binding migration. */
export function migrationRecovery(profile: string): OperationRecovery {
  return SAFE_PROFILE_TOKEN.test(profile)
    ? { action: "complete_migration", command: migrationCommand(profile), operationId: MIGRATION_OPERATION_ID }
    : { action: "complete_migration", operationId: MIGRATION_OPERATION_ID };
}

/**
 * Exact-shape check used by the error-detail redaction policies: exact keys, a
 * fixed `action`, and a `command` equal to one of the fixed templates for a
 * safe profile token.
 */
export function isSafeRecovery(
  value: unknown,
  action: OperationRecovery["action"],
): value is OperationRecovery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.action !== action) return false;
  const keys = Object.keys(record);
  const allowed = action === "sign_in" ? ["action", "command"] : ["action", "command", "operationId"];
  if (!keys.every((key) => allowed.includes(key))) return false;
  if (action === "complete_migration" && record.operationId !== MIGRATION_OPERATION_ID) return false;
  if (!("command" in record)) return true;
  const command = record.command;
  if (typeof command !== "string") return false;
  const profile = /^tc --profile (\S+) /.exec(command)?.[1];
  if (profile === undefined || !SAFE_PROFILE_TOKEN.test(profile)) return false;
  return action === "sign_in"
    ? Object.values(SIGN_IN_TEMPLATES).some((template) => template(profile) === command)
    : migrationCommand(profile) === command;
}
