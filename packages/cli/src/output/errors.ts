import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ExitCode, CONFIG_FILE, PROFILES_DIR, DEFAULT_PROFILE } from "../config/constants.js";
import { ProfileDeletedError, ProfileLockTimeoutError } from "@tinycloud/operations/state";
import { operationWarnings, outputError } from "./formatter.js";
import { authorizationVerdictOf, parseCapabilityResource, SERVICE_LONG_TO_SHORT, validatedCapabilityOf } from "@tinycloud/sdk-core";

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
    { hint: `Sign in again with: tc --profile ${profileName} auth login --method openkey` },
  );
}

export function handleError(error: unknown): never {
  const cliError = wrapError(error);
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
  if (cliError.status !== undefined && authMeta !== undefined) meta.status = cliError.status;
  const capability = validatedCapabilityOf({ meta: authMeta });
  if (capability) {
    meta.resource = capability.resource;
    meta.requiredAction = capability.requiredAction;
  }
  outputError(cliError.code, cliError.message, hint, {
    ...(Object.keys(meta).length ? { meta } : {}),
    warnings: operationWarnings(cliError.metadata?.warnings),
  });
  process.exit(cliError.exitCode);
}

function buildAuthHint(error: CLIError): string | undefined {
  const capability = validatedCapabilityOf({ meta: error.metadata });
  if (!capability) return undefined;

  const spec = capSpecFromAuthMeta(capability.resource, capability.requiredAction);
  if (!spec) return undefined;
  return [
    "The active session is missing a TinyCloud capability.",
    `Request it with: tc auth request --cap '${spec.replaceAll("'", "'\\''")}'`,
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
    lines.push(`No other profiles configured. Run \`tc profile create <name>\` or \`tc init\`.`);
  } else {
    lines.push(`Switch to a reachable profile:`);
    const longest = Math.max(...others.map((p) => p.name.length));
    for (const { name, host } of others) {
      lines.push(`  tc profile switch ${name.padEnd(longest)}   # ${host}`);
    }
  }
  lines.push(`Or override per-command with --host or TC_HOST.`);
  return lines.join("\n");
}
