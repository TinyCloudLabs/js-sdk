import { KV, type PermissionEntry } from "@tinycloud/sdk-core";

/**
 * Consent window (7 d). Mirrors CONSENT_WINDOW_MS in sdk-services/kv/replication/contractConstants.ts.
 * Not imported: sdk-services replica code must stay out of the web bundle (plan §2).
 * replicationReconsent.test.ts pins the two values together.
 */
export const REPLICATION_CONSENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const KV_SERVICE = "tinycloud.kv";

/** SIWE `issuedAt` of the sign-in that granted replication, or null when absent or unparseable. */
export function replicationConsentAnchorMs(siwe: string): number | null {
  const match = /^Issued At: (.+)$/m.exec(siwe);
  if (match === null) return null;
  const at = Date.parse(match[1]!.trim());
  return Number.isNaN(at) ? null : at;
}

/**
 * True once the consent deadline (anchor + 7 d) has been reached. Fails closed: a missing or
 * unparseable anchor counts as expired, so the caller requires a fresh sign-in instead of
 * trusting an unanchored restore.
 */
export function replicationConsentExpired(siwe: string, now: number): boolean {
  const anchor = replicationConsentAnchorMs(siwe);
  return anchor === null || now >= anchor + REPLICATION_CONSENT_WINDOW_MS;
}

export type RestoreAcceptanceInput = {
  /** Persisted SIWE of the restored session (carries the consent anchor). */
  siwe: string;
  now: number;
  /** Replica session stamp validated against the principal (S3 `restoreSessionStamp`). */
  stampValid: boolean;
  /** Restored session address and chain (candidate A). */
  sessionAddress: string;
  sessionChainId: number;
  /** Connected wallet (B). Undefined when no wallet is connected. */
  walletAddress: string | undefined;
  walletChainId: number | undefined;
  /** Primary space the node resolved for the restored session, undefined when unknown. */
  resolvedSpace: string | undefined;
  configuredSpace: string;
  /** Node reports get+sync covering every required prefix on the primary space. */
  coversRequired: boolean;
};

/**
 * Whether a restored session may be returned as a successful covered restore. Offline and
 * online follow the same rule; offline only skips network work, it never widens acceptance.
 * Every check fails closed: any miss means a fresh sign-in.
 */
export function replicationRestoreAccepted(input: RestoreAcceptanceInput): boolean {
  if (!input.stampValid) return false;
  if (replicationConsentExpired(input.siwe, input.now)) return false;
  if (input.resolvedSpace === undefined || input.resolvedSpace !== input.configuredSpace) return false;
  if (!input.coversRequired) return false;
  if (input.walletAddress === undefined || input.walletChainId === undefined) return false;
  if (input.walletAddress.toLowerCase() !== input.sessionAddress.toLowerCase()) return false;
  return input.walletChainId === input.sessionChainId;
}

/** Mirrors `requiresSecretsOptIn` in sdk-services/kv/replication/scope.ts (same four-line rule). */
function needsSecretsOptIn(space: string, prefix: string): boolean {
  if (prefix === "/") return true;
  if (space === "secrets" || space.endsWith(":secrets")) return true;
  return prefix.split("/", 1)[0] === "vault";
}

/** Prefixes node's authority sign-in will request: secrets-scoped prefixes are skipped unless `allowSecrets`. */
export function requiredReplicationPrefixes(
  prefixes: readonly string[],
  space: string,
  allowSecrets: boolean | undefined,
): string[] {
  return prefixes.filter((prefix) => allowSecrets === true || !needsSecretsOptIn(space, prefix));
}

/** The get+sync entries that replication requires on the primary space, one per prefix. */
export function replicationPermissionsFor(
  space: string,
  prefixes: readonly string[],
): PermissionEntry[] {
  return prefixes.map((prefix) => ({
    service: KV_SERVICE,
    space,
    path: prefix === "/" ? "" : prefix,
    actions: [KV.GET, KV.SYNC],
  }));
}
