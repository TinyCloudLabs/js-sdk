import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ExitCode, CONFIG_FILE, PROFILES_DIR, DEFAULT_PROFILE } from "../config/constants.js";
import { outputError } from "./formatter.js";

let activeProfileName: string | undefined;

/** Recorded by ProfileManager.resolveContext so hints can name the right profile. */
export function setActiveProfileName(name: string): void {
  activeProfileName = name;
}

export class CLIError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode: number = ExitCode.ERROR,
    public metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CLIError";
  }
}

export function wrapError(error: unknown): CLIError {
  if (error instanceof CLIError) return error;

  const message = error instanceof Error ? error.message : String(error);

  // Map known error patterns to exit codes
  if (message.includes("Not signed in") || message.includes("AUTH_EXPIRED") || message.includes("Session expired")) {
    return new CLIError("AUTH_REQUIRED", message, ExitCode.AUTH_REQUIRED);
  }
  if (message.includes("NOT_FOUND") || message.includes("KV_NOT_FOUND")) {
    return new CLIError("NOT_FOUND", message, ExitCode.NOT_FOUND);
  }
  if (message.includes("PERMISSION_DENIED")) {
    return new CLIError("PERMISSION_DENIED", message, ExitCode.PERMISSION_DENIED);
  }
  if (message.includes("ECONNREFUSED") || message.includes("ETIMEDOUT") || message.includes("fetch failed")) {
    return new CLIError("NETWORK_ERROR", message, ExitCode.NETWORK_ERROR);
  }

  return new CLIError("ERROR", message, ExitCode.ERROR);
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
  outputError(cliError.code, cliError.message, hint);
  process.exit(cliError.exitCode);
}

function buildAuthHint(error: CLIError): string | undefined {
  const resource = error.metadata?.resource;
  const requiredAction = error.metadata?.requiredAction;
  if (typeof resource !== "string" || typeof requiredAction !== "string") {
    return undefined;
  }

  const spec = capSpecFromAuthMeta(resource, requiredAction);
  if (!spec) return undefined;
  return [
    "The active session is missing a TinyCloud capability.",
    `Request it with: tc auth request --cap "${spec}"`,
    "Then retry the original command.",
  ].join("\n");
}

function capSpecFromAuthMeta(resource: string, action: string): string | undefined {
  const slash = resource.indexOf("/");
  if (slash <= 0 || slash === resource.length - 1) return undefined;
  const spaceUri = resource.slice(0, slash);
  const rest = resource.slice(slash + 1);
  const nextSlash = rest.indexOf("/");
  if (nextSlash <= 0) return undefined;

  const serviceShort = rest.slice(0, nextSlash);
  const path = rest.slice(nextSlash + 1);
  const actionName = action.includes("/") ? action.slice(action.indexOf("/") + 1) : action;
  const spaceName = spaceUri.startsWith("tinycloud:")
    ? spaceUri.slice(spaceUri.lastIndexOf(":") + 1)
    : spaceUri;
  return `tinycloud.${serviceShort}:${spaceName}:${path}:${actionName}`;
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
