import { closeReplication, registeredReplications } from "../lib/replication-registry.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ExitCode, CONFIG_FILE, PROFILES_DIR, DEFAULT_PROFILE } from "../config/constants.js";
import { ProfileDeletedError, ProfileLockTimeoutError } from "@tinycloud/operations/state";
import { isSafeRecovery } from "@tinycloud/operations/recovery";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import {
  buildSecretRequestUrl,
  isSafeRequestAccessRecovery,
  isValidSecretName,
  SECRET_REQUEST_MAX_NAMES,
} from "@tinycloud/operations/secret-request";
import { operationWarnings, outputError, type ErrorOutputDetails } from "./formatter.js";
import { authorizationVerdictOf, parseCapabilityResource, SERVICE_LONG_TO_SHORT, validatedCapabilityOf } from "@tinycloud/sdk-core";
import { describeStorageRejection, storageRejection } from "./storage.js";
import { drainWarnings, mergeWarnings } from "./warnings.js";
import { emitDiagnostic, type DiagnosticFields } from "@tinycloud/operations/diagnostics";

const DIAGNOSTIC_ERROR_CLASSES: Readonly<Record<string, DiagnosticFields["error_class"]>> = {
  USAGE_ERROR: "input_invalid", INVALID_ARGUMENT: "input_invalid", SELF_COPY: "input_invalid", EMPTY_PLAN: "input_invalid",
  AUTH_REQUIRED: "auth_required", AUTH_EXPIRED: "auth_required", PASTE_CODE_MISSING: "auth_required",
  PERMISSION_DENIED: "permission_denied", DEVICE_AUTH_DENIED: "permission_denied", SCOPE_REJECTED: "permission_denied",
  NOT_FOUND: "not_found", KV_NOT_FOUND: "not_found", NETWORK_ERROR: "network", OPENKEY_UNREACHABLE: "network",
  STORAGE_FULL: "storage_full", KV_PRECONDITION_FAILED: "precondition", CANCELLED: "cancelled",
};

let activeProfileName: string | undefined;

/** Recorded by ProfileManager.resolveContext so hints can name the right profile. */
export function setActiveProfileName(name: string): void {
  activeProfileName = name;
}

export class CLIError extends Error {
  readonly status?: number;

  constructor(
    public code: string,
    message: string,
    public exitCode: number = ExitCode.ERROR,
    public metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CLIError";
    if (typeof metadata?.status === "number" && Number.isInteger(metadata.status) &&
      metadata.status >= 400 && metadata.status <= 599) this.status = metadata.status;
  }
}

/**
 * Convert a service or operation result once, before the CLI's own errors
 * become immutable decisions. A typed HTTP status decides first. Without one,
 * an operation's own typed decision (`AUTH_REQUIRED`, `PERMISSION_DENIED`,
 * for example an expired stored session or a node refusal operations already
 * classified) keeps its exit code.
 */
export function cliErrorFromService(
  error: { code: string; message: string; meta?: Record<string, unknown>; status?: number; statusCode?: number },
  message = error.message,
): CLIError {
  if (error instanceof CLIError) return error;
  const storageFull = storageFullError(error);
  if (storageFull) return storageFull;
  const meta = { ...error.meta };
  // Service metadata is not allowed to supply an arbitrary displayed command hint.
  delete meta.hint;
  const status = error.status ?? error.statusCode;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) meta.status = status;
  const verdict = authorizationVerdictOf({ ...error, meta });
  if (verdict === undefined && message.includes("Missing private key parameter in JWK")) {
    return missingPrivateKeyError();
  }
  const missingCapability = validatedCapabilityOf({ ...error, meta }) !== undefined;
  const denied = verdict === "forbidden" || (verdict === "unauthenticated" && missingCapability) ||
    (verdict === undefined && error.code === "PERMISSION_DENIED");
  const unauthenticated = !denied &&
    (verdict === "unauthenticated" || (verdict === undefined && error.code === "AUTH_REQUIRED"));
  return new CLIError(
    denied ? "PERMISSION_DENIED" : unauthenticated ? "AUTH_REQUIRED" : error.code,
    message,
    denied ? ExitCode.PERMISSION_DENIED : unauthenticated ? ExitCode.AUTH_REQUIRED : ExitCode.ERROR,
    meta,
  );
}

export function wrapError(error: unknown): CLIError {
  // A write refused for storage reads the same for every command: one exit
  // code, the account totals when known, and the manage link. It is never a
  // network problem, so it never gets the switch-hosts hint.
  const storageFull = storageFullError(error);
  if (storageFull) return storageFull;
  if (error instanceof CLIError) return error;
  const message = error instanceof Error ? error.message : String(error);

  // A typed HTTP refusal wins over misleading response text, including text
  // that describes a different auth or local signing failure.
  const verdict = authorizationVerdictOf(error);
  if (verdict === "unauthenticated") {
    return new CLIError("AUTH_REQUIRED", message, ExitCode.AUTH_REQUIRED);
  }
  if (verdict === "forbidden") {
    return new CLIError("PERMISSION_DENIED", message, ExitCode.PERMISSION_DENIED);
  }

  // A genuinely untyped signer restore failure is local auth state. Never
  // interpret HTTP response text (or a command's deliberate CLIError) as JWK state.
  if (verdict === undefined && message.includes("Missing private key parameter in JWK")) {
    return missingPrivateKeyError();
  }

  // Any profile write (session, key, profile settings, stores) waits on the
  // profile lock; a timeout means another tc/MCP process held it, not that
  // the profile is broken.
  if (error instanceof ProfileLockTimeoutError) {
    return new CLIError(
      "PROFILE_LOCK_TIMEOUT",
      `${message} Another tc or MCP process held this profile's lock, so the change that needed it was not written.`,
      ExitCode.ERROR,
      { hint: "Wait for the other command to finish and retry. A crashed process's lock is reclaimed automatically after 30 s." },
    );
  }

  // A store write that waited out a `tc profile delete` of its profile.
  if (error instanceof ProfileDeletedError) {
    return new CLIError("PROFILE_NOT_FOUND", message);
  }

  // Map known error patterns to exit codes
  if (verdict === undefined && (message.includes("Not signed in") || message.includes("AUTH_EXPIRED") || message.includes("Session expired"))) {
    return new CLIError("AUTH_REQUIRED", message, ExitCode.AUTH_REQUIRED);
  }
  if (message.includes("NOT_FOUND") || message.includes("KV_NOT_FOUND")) {
    return new CLIError("NOT_FOUND", message, ExitCode.NOT_FOUND);
  }
  if (verdict === undefined && message.includes("PERMISSION_DENIED")) {
    return new CLIError("PERMISSION_DENIED", message, ExitCode.PERMISSION_DENIED);
  }
  if (message.includes("ECONNREFUSED") || message.includes("ETIMEDOUT") || message.includes("fetch failed")) {
    return new CLIError("NETWORK_ERROR", message, ExitCode.NETWORK_ERROR);
  }

  return new CLIError("ERROR", message, ExitCode.ERROR);
}

function missingPrivateKeyError(): CLIError {
  const profileName = activeProfileName ?? process.env.TC_PROFILE ?? DEFAULT_PROFILE;
  return new CLIError(
    "AUTH_REQUIRED",
    `Profile "${profileName}" cannot restore its session because its private key material is missing.`,
    ExitCode.AUTH_REQUIRED,
    { hint: `Sign in again with: ${CLI_NAME} --profile ${profileName} auth login --method openkey` },
  );
}

/**
 * The CLI error for a write refused because the owner's TinyCloud storage is
 * full. `progress` replaces "nothing was written" when earlier writes in the
 * same command already landed (e.g. `Insert into "t" failed after 3 row(s): `).
 */
export function storageFullError(error: unknown, progress?: string): CLIError | undefined {
  if (error instanceof CLIError && error.exitCode === ExitCode.STORAGE_FULL) return error;
  const rejection = storageRejection(error);
  if (!rejection) return undefined;
  const { message, hint } = describeStorageRejection(rejection, progress);
  return new CLIError(rejection.code, message, ExitCode.STORAGE_FULL, { hint });
}

export function handleError(error: unknown): Promise<never> {
  const cliError = wrapError(error);
  emitDiagnostic({ type: "operation.step", outcome: cliError.code === "CANCELLED" ? "cancelled" : "failed", error_class: Object.hasOwn(DIAGNOSTIC_ERROR_CLASSES, cliError.code) ? DIAGNOSTIC_ERROR_CLASSES[cliError.code] : "unknown", exit_code: cliError.exitCode });
  // A pre-built hint on the error (e.g. the identity-aware SPACE_NOT_HOSTED
  // hint) takes precedence over the derived auth/network hints.
  const prebuilt = typeof cliError.metadata?.hint === "string"
    ? (cliError.metadata.hint as string)
    : undefined;
  const hint = prebuilt ?? buildAuthHint(cliError) ??
    (cliError.code === "NETWORK_ERROR" ? buildNetworkHint() : undefined);
  // Never expose arbitrary SDK/server metadata (or share adapter secrets).
  // Only the KV authorization fields used by the capability hint are public.
  const authMeta = cliError.code === "AUTH_REQUIRED" || cliError.code === "PERMISSION_DENIED"
    ? cliError.metadata
    : undefined;
  const meta: Record<string, unknown> = {};
  if (cliError.code === "GRANT_REVOKED_LOCAL_REMOVE_FAILED" &&
    typeof cliError.metadata?.causeCode === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(cliError.metadata.causeCode)) {
    meta.causeCode = cliError.metadata.causeCode;
  }
  if (cliError.status !== undefined && authMeta !== undefined) meta.status = cliError.status;
  const capability = validatedCapabilityOf({ meta: authMeta });
  if (capability) {
    meta.resource = capability.resource;
    meta.requiredAction = capability.requiredAction;
  }
  const deniedNames = cliError.metadata?.deniedNames;
  const recovery = safeCliRecovery(cliError.metadata?.recovery, {
    deniedNames: Array.isArray(deniedNames) && deniedNames.every((name) => typeof name === "string") ? deniedNames : [],
  });
  const setup = cliError.code === "NOT_FOUND" || cliError.code === "PERMISSION_DENIED"
    ? safeCliSetup(cliError.metadata?.setup)
    : undefined;
  const progress = cliError.code === "NETWORK_ERROR" || cliError.code === "CANCELLED"
    ? safeCliProgress(cliError.metadata?.progress)
    : undefined;
  outputError(cliError.code, cliError.message, hint, {
    ...(recovery ? { recovery } : {}),
    ...(setup ? { setup } : {}),
    ...(progress ? { progress } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
    warnings: mergeWarnings(drainWarnings(), operationWarnings(cliError.metadata?.warnings)),
  });
  if (registeredReplications().size === 0) return process.exit(cliError.exitCode);
  return closeReplication().then(() => process.exit(cliError.exitCode));
}

/**
 * The `error.recovery` a CLI error may print, validated by its `action`
 * (R7-1). `sign_in` and `complete_migration` use the operations redaction
 * policy; `request_access` must name only denied names from the status
 * output that produced it (`context.deniedNames`; `[]` for every other
 * caller, so they can never emit it). Anything else is dropped.
 */
export function safeCliRecovery(
  value: unknown,
  context: { readonly deniedNames: readonly string[] },
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("action" in value)) return undefined;
  const action = value.action;
  switch (action) {
    case "sign_in":
    case "complete_migration":
      return isSafeRecovery(value, action) ? { ...value } : undefined;
    case "request_access":
      return isSafeRequestAccessRecovery(value, context.deniedNames)
        ? { ...value, names: [...value.names] }
        : undefined;
    default:
      return undefined;
  }
}

const SETUP_KEYS: Record<string, true> = { url: true, names: true, scope: true, owner: true, action: true };

/**
 * Exactly `{url, names, scope?, owner, action: "add_secret"}`, where `url` is
 * the canonical `/request` link the builder produces for those fields.
 */
function safeCliSetup(value: unknown): ErrorOutputDetails["setup"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  // Plain JSON-like metadata object: the checks below validate every key read.
  const setup: Record<string, unknown> = { ...value };
  if (!Object.keys(setup).every((key) => SETUP_KEYS[key] === true)) return undefined;
  const { url, names, scope, owner, action } = setup;
  if (action !== "add_secret" || typeof url !== "string" || typeof owner !== "string") return undefined;
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) return undefined;
  if (scope !== undefined && typeof scope !== "string") return undefined;
  try {
    const link = buildSecretRequestUrl({ owner, names, ...(scope !== undefined ? { scope } : {}) });
    if (link.url !== url || link.owner !== owner || link.names.length !== names.length) return undefined;
  } catch {
    return undefined;
  }
  return { url, names: [...names], ...(scope !== undefined ? { scope } : {}), owner, action };
}

function safeNameList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > SECRET_REQUEST_MAX_NAMES) return undefined;
  if (!value.every((name) => typeof name === "string" && isValidSecretName(name))) return undefined;
  if (new Set(value).size !== value.length) return undefined;
  return [...value];
}

/** Exactly `{present, pending}`, two disjoint lists of valid secret names. */
function safeCliProgress(value: unknown): ErrorOutputDetails["progress"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!("present" in value) || !("pending" in value) || Object.keys(value).length !== 2) return undefined;
  const present = safeNameList(value.present);
  const pending = safeNameList(value.pending);
  if (!present || !pending || present.some((name) => pending.includes(name))) return undefined;
  return { present, pending };
}

function buildAuthHint(error: CLIError): string | undefined {
  const capability = validatedCapabilityOf({ meta: error.metadata });
  if (!capability) return undefined;

  const spec = capSpecFromAuthMeta(capability.resource, capability.requiredAction);
  if (!spec) return undefined;
  return [
    "The active session is missing a TinyCloud capability.",
    `Request it with: ${CLI_NAME} auth request --cap '${spec.replaceAll("'", "'\\''")}'`,
    "Then retry the original command.",
  ].join("\n");
}

function capSpecFromAuthMeta(resource: string, action: string): string | undefined {
  const slash = action.indexOf("/");
  if (slash < 0) return undefined;
  const longService = action.slice(0, slash);
  const serviceShort = SERVICE_LONG_TO_SHORT[longService];
  if (!serviceShort) return undefined;
  const parsed = parseCapabilityResource(resource, serviceShort);
  if (!parsed) return undefined;
  const spaceName = parsed.space.slice(parsed.space.lastIndexOf(":") + 1);
  return `${longService}:${spaceName}:${parsed.path}:${action.slice(slash + 1)}`;
}

/**
 * Suggests alternate profiles when the active profile's host is unreachable.
 * Sync fs reads keep handleError synchronous so call sites don't need to await.
 *
 * Silent fallback to a default host is intentionally NOT done: different hosts
 * back different data stores, so an automatic switch could split or clobber
 * user data without their knowledge.
 */
function buildNetworkHint(): string | undefined {
  const readHost = (name: string): string | undefined => {
    try {
      const raw = readFileSync(join(PROFILES_DIR, name, "profile.json"), "utf8");
      return (JSON.parse(raw) as { host?: string }).host;
    } catch {
      return undefined;
    }
  };

  let activeName = activeProfileName ?? process.env.TC_PROFILE ?? DEFAULT_PROFILE;
  if (!activeProfileName) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { defaultProfile?: string };
      activeName = process.env.TC_PROFILE ?? cfg.defaultProfile ?? DEFAULT_PROFILE;
    } catch {
      // Config file not present yet — fall through with env/default.
    }
  }

  let names: string[];
  try {
    names = readdirSync(PROFILES_DIR);
  } catch {
    return undefined;
  }

  const activeHost = readHost(activeName);
  const others = names
    .filter((n) => n !== activeName)
    .map((n) => ({ name: n, host: readHost(n) }))
    .filter((p): p is { name: string; host: string } => Boolean(p.host));

  const lines: string[] = [];
  lines.push(activeHost ? `Active profile "${activeName}" → ${activeHost}` : `Active profile "${activeName}"`);

  if (others.length === 0) {
    lines.push(`No other profiles configured. Run \`${CLI_NAME} profile create <name>\` or \`${CLI_NAME} init\`.`);
  } else {
    lines.push(`Switch to a reachable profile:`);
    const longest = Math.max(...others.map((p) => p.name.length));
    for (const { name, host } of others) {
      lines.push(`  ${CLI_NAME} profile switch ${name.padEnd(longest)}   # ${host}`);
    }
  }
  lines.push(`Or override per-command with --host or TC_HOST.`);
  return lines.join("\n");
}
