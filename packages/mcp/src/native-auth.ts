import { timingSafeEqual } from "node:crypto";

import type { PermissionEntry } from "@tinycloud/node-sdk";

export const NATIVE_SERVICE_CREDENTIAL_HEADER = "X-TinyCloud-Service-Credential";
export const NATIVE_OWNER_DID_HEADER = "X-TinyCloud-Owner-DID";
export const NATIVE_GRANT_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const NATIVE_GRANT_REQUIRED = "native_grant_required";
export const NATIVE_GRANT_EXPIRED = "native_grant_expired";
export const NATIVE_GRANT_REJECTED = "native_grant_rejected";
export const NATIVE_SERVICE_UNAUTHORIZED = "native_service_unauthorized";
export const NATIVE_SERVICE_UNAVAILABLE = "native_service_unavailable";
export const NATIVE_GRANT_VALIDATION_UNAVAILABLE = "native_grant_validation_unavailable";
export const MAX_NATIVE_GRANT_BODY_BYTES = 256 * 1024;

export function serviceCredentialMatches(supplied: string | null, configured: string | undefined): boolean {
  if (supplied === null || configured === undefined) return false;
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const configuredBytes = Buffer.from(configured, "utf8");
  return suppliedBytes.byteLength === configuredBytes.byteLength &&
    timingSafeEqual(suppliedBytes, configuredBytes);
}
const OWNER_APPLICATIONS_SPACE = /^tinycloud:pkh:eip155:([1-9][0-9]*):(0x[0-9a-f]{40}):applications$/i;
const SQL_PATH = "xyz.tinycloud.tinychat/connectors";
const KV_PREFIX = "xyz.tinycloud.tinychat/connectors/";

export function canonicalOwnerDid(value: string): string | undefined {
  const match = /^did:pkh:eip155:([1-9][0-9]*):(0x[0-9a-f]{40})$/i.exec(value);
  if (!match) return undefined;
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId)) return undefined;
  return `did:pkh:eip155:${chainId}:${match[2]!.toLowerCase()}`;
}

/** Derive the owner solely from the signed applications-space capabilities. */
export function nativeOwnerForConnectorGrant(
  permissions: readonly PermissionEntry[],
): string | undefined {
  if (permissions.length !== 2) return undefined;
  const sqlEntries = permissions.filter((permission) => permission.service === "tinycloud.sql");
  const kvEntries = permissions.filter((permission) => permission.service === "tinycloud.kv");
  if (sqlEntries.length !== 1 || kvEntries.length !== 1) return undefined;
  const sql = sqlEntries[0]!;
  const kv = kvEntries[0]!;
  if (typeof sql.space !== "string" || typeof kv.space !== "string" ||
    sql.path !== SQL_PATH || kv.path !== KV_PREFIX) return undefined;
  if (!actionsEqual(sql.actions, ["tinycloud.sql/read"]) ||
    !actionsEqual(kv.actions, ["tinycloud.kv/get", "tinycloud.kv/list"])) return undefined;
  if (hasCaveats(sql) || hasCaveats(kv)) return undefined;

  const sqlSpace = ownerFromApplicationsSpace(sql.space);
  const kvSpace = ownerFromApplicationsSpace(kv.space);
  return sqlSpace !== undefined && sqlSpace === kvSpace ? sqlSpace : undefined;
}

function ownerFromApplicationsSpace(space: string): string | undefined {
  const match = OWNER_APPLICATIONS_SPACE.exec(space);
  if (!match) return undefined;
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId)) return undefined;
  return `did:pkh:eip155:${chainId}:${match[2]!.toLowerCase()}`;
}

function actionsEqual(actual: readonly string[], expected: readonly string[]): boolean {
  const actualActions = [...actual].sort();
  const expectedActions = [...expected].sort();
  return actualActions.length === expectedActions.length &&
    actualActions.every((value, index) => value === expectedActions[index]);
}

function hasCaveats(permission: PermissionEntry): boolean {
  return Object.hasOwn(permission, "caveats") && permission.caveats !== undefined;
}
