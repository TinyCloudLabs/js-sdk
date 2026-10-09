import type { PermissionEntry } from "@tinycloud/node-sdk";
import { kvPrefixCovers, requiresSecretsOptIn } from "@tinycloud/replica";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ownerLoginPermissions } from "./owner-key.js";
import { ownerSpaceId, sameLoginSpace } from "./scoped-login.js";
export interface ReplicationLoginOptions {
  prefixes: readonly string[];
  allowSecrets?: boolean;
  ownerDid?: string;
}

function unconstrained(caveats: PermissionEntry["caveats"]): boolean {
  return (caveats ?? []).every((caveat) => Object.keys(caveat).length === 0);
}

/** Add sync authority only where the request already contains unrestricted covering get authority. */
export function addReplicationLoginEntries(
  request: readonly PermissionEntry[],
  primarySpace: string,
  options: ReplicationLoginOptions,
): PermissionEntry[] {
  const result = [...request];
  for (const prefix of options.prefixes) {
    if (requiresSecretsOptIn(primarySpace, prefix) && options.allowSecrets !== true) {
      throw new CLIError("SECRETS_OPT_IN_REQUIRED", `Replication prefix ${JSON.stringify(prefix)} in ${primarySpace} requires --replication-allow-secrets.`, ExitCode.USAGE_ERROR);
    }
    const covering = request.filter((entry) =>
      entry.service === "tinycloud.kv" &&
      sameLoginSpace(entry.space ?? "", primarySpace, options.ownerDid) &&
      (entry.actions.includes("tinycloud.kv/get") || entry.actions.includes("tinycloud.kv/*")) &&
      kvPrefixCovers(entry.path, prefix),
    );
    if (!covering.length) {
      throw new CLIError("REPLICATION_PREFIX_OUTSIDE_SCOPE", `Replication prefix ${JSON.stringify(prefix)} has no covering get in the login request.`, ExitCode.USAGE_ERROR);
    }
    if (!covering.some((entry) => unconstrained(entry.caveats))) {
      throw new CLIError("REPLICATION_PREFIX_CAVEATED", `Replication prefix ${JSON.stringify(prefix)} is covered only by caveated get authority.`, ExitCode.USAGE_ERROR);
    }
    const service = "tinycloud.kv";
    const actions = [`${service}/get`, `${service}/sync`];
    const existing = result.find((entry) => entry.service === service && entry.space === primarySpace && entry.path === prefix &&
      actions.every((action) => entry.actions.includes(action)) && unconstrained(entry.caveats));
    if (!existing) result.push({ service, space: primarySpace, path: prefix, actions });
  }
  return result;
}

/** Resolve login-mode scope and augment it without mutating caller-owned manifests. */
export function buildReplicationLoginRequest(
  request: PermissionEntry[] | undefined,
  options: ReplicationLoginOptions,
): PermissionEntry[] | undefined {
  if (options.prefixes.length === 0) return request;
  if (request === undefined) {
    const space = options.ownerDid === undefined ? "default" : ownerSpaceId("default", options.ownerDid);
    const defaults: PermissionEntry[] = options.ownerDid === undefined
      ? [{ service: "tinycloud.kv", space, path: "", actions: ["tinycloud.kv/put", "tinycloud.kv/get", "tinycloud.kv/del", "tinycloud.kv/list", "tinycloud.kv/metadata"] }]
      : ownerLoginPermissions(options.ownerDid);
    return addReplicationLoginEntries(defaults, space, options);
  }
  const primary = request.find((entry) => entry.service === "tinycloud.kv" && entry.space !== undefined)?.space ??
    request.find((entry) => entry.space !== undefined)?.space;
  if (!primary) {
    throw new CLIError("INVALID_LOGIN_SCOPE", "Replication login needs a primary space in the requested manifest.", ExitCode.USAGE_ERROR);
  }
  return addReplicationLoginEntries(request, primary, options);
}
