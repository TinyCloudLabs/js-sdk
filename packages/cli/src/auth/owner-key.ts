import type { PermissionEntry } from "@tinycloud/node-sdk";
import type { ProfileConfig } from "../config/types.js";
import { theme } from "../output/theme.js";
import { ownerSpaceId } from "./scoped-login.js";

/**
 * Whether the OpenKey key that approved a login is the account's primary key.
 * OpenKey reports it as a top-level `primary` boolean on the delegation it
 * returns (callback body, paste code, device relay). It is unsigned metadata
 * read from OpenKey's records: it never names the owner or grants authority,
 * which come only from the signed SIWE. Older OpenKey deployments omit it.
 */
export function openKeyPrimaryFlag(delegation: Record<string, unknown>): boolean | undefined {
  return typeof delegation.primary === "boolean" ? delegation.primary : undefined;
}

/**
 * The profile with the owner-key flag from this login: set when OpenKey said,
 * and removed when it did not, so a re-login never keeps an earlier answer.
 */
export function withOwnerKeyPrimary(profile: ProfileConfig, primary: boolean | undefined): ProfileConfig {
  const { ownerKeyPrimary: _previous, ...rest } = profile;
  return primary === undefined ? rest : { ...rest, ownerKeyPrimary: primary };
}

/** The stderr warning for a login approved by a key that is not the account's primary key. */
export function nonPrimaryKeyWarning(ownerDid: string): string {
  const address = ownerDid.split(":")[4] ?? ownerDid;
  return `${theme.warn("Warning:")} you signed in with OpenKey key ${address} (${ownerDid}), which is not your account's primary OpenKey key. ` +
    "This key is a separate owner with its own spaces and data, so this profile does not see the data stored under your primary key.\n" +
    "To use your primary key, log in again and choose the primary key in OpenKey, for example into a new profile: tc init --name <profile>\n";
}

/** Warn on stderr only when OpenKey said the approving key is not primary; stdout stays untouched. */
export function warnIfNotPrimaryKey(ownerDid: string | undefined, primary: boolean | undefined): void {
  if (primary !== false || ownerDid === undefined) return;
  process.stderr.write(nonPrimaryKeyWarning(ownerDid));
}

/**
 * The request a plain `tc auth login --owner <did>` sends to OpenKey: the
 * abilities OpenKey signs for a login without a request (kv, sql and
 * capabilities read on the `default` space root), on `owner`'s space URI.
 * OpenKey infers the expected signer from owner-qualified spaces, so it
 * preselects that owner's key; the signed owner is still checked after
 * approval.
 */
export function ownerLoginPermissions(owner: string): PermissionEntry[] {
  const space = ownerSpaceId("default", owner);
  return [
    { service: "tinycloud.kv", space, path: "", actions: ["tinycloud.kv/put", "tinycloud.kv/get", "tinycloud.kv/del", "tinycloud.kv/list", "tinycloud.kv/metadata"] },
    { service: "tinycloud.sql", space, path: "", actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"] },
    { service: "tinycloud.capabilities", space, path: "", actions: ["tinycloud.capabilities/read"] },
  ];
}
