/**
 * Internal helpers for TinyCloudNode.delegateTo and the legacy
 * createDelegation compatibility shim. Exported from their own module so
 * they are easy to unit-test without spinning up a full TinyCloudNode.
 *
 * None of these are part of the public API — the module path is not
 * re-exported from `@tinycloud/node-sdk` or `@tinycloud/node-sdk/core`.
 *
 * @packageDocumentation
 */

import {
  actionContains,
  ENCRYPTION,
  type PermissionEntry,
  parseExpiry,
  isNetworkId,
  parseNetworkId,
  SiweMessage,
  EXPIRY,
} from "@tinycloud/sdk-core";

/**
 * Convert legacy `createDelegation` params into one {@link PermissionEntry}
 * per service. Groups action URNs by their `tinycloud.<service>` prefix and
 * emits one entry per group. Actions whose prefix is not `tinycloud.*` are
 * dropped (preserving the wallet-path behaviour, which also ignores
 * unrecognised URN prefixes).
 *
 * Used by the legacy compatibility shim in `createDelegation` to hand off
 * to `delegateTo` on the fast (subset) path.
 */
export function legacyParamsToPermissionEntries(
  actions: readonly string[],
  path: string,
  spaceIdOverride: string | undefined,
): PermissionEntry[] {
  const byService = new Map<string, string[]>();
  for (const a of actions) {
    // Action URNs look like `tinycloud.kv/get`, `tinycloud.sql/read`, etc.
    // Split on the first `/` to get the service namespace.
    const slashIdx = a.indexOf("/");
    if (slashIdx === -1) {
      continue;
    }
    const service = a.slice(0, slashIdx);
    if (!service.startsWith("tinycloud.")) {
      continue;
    }
    const list = byService.get(service);
    if (list === undefined) {
      byService.set(service, [a]);
    } else {
      list.push(a);
    }
  }
  const space = spaceIdOverride ?? "default";
  const entries: PermissionEntry[] = [];
  for (const [service, actionList] of byService) {
    entries.push({
      service,
      space,
      path,
      actions: actionList,
    });
  }
  return entries;
}

/**
 * Default lifetime for a delegation when no explicit expiry is provided.
 * Sourced from the SESSION tier — runtime grants are always capped at the
 * parent session's expiry, so they can't usefully be longer than SESSION
 * even if a caller asks. See `@tinycloud/sdk-core/expiry.ts`.
 */
export const DEFAULT_DELEGATION_EXPIRY_MS = EXPIRY.SESSION_MS;

/** Longest a decrypt-bearing grant may last. Decrypt grants over this are refused, never clamped. */
export const DECRYPT_GRANT_MAX_EXPIRY_MS = 60 * 60 * 1000;

/** `code` carried by the decrypt expiry refusal. */
export const DECRYPT_EXPIRY_TOO_LONG = "DECRYPT_EXPIRY_TOO_LONG";

/** The refusal every decrypt-expiry guard throws, before any prepare, sign, or network call. */
export function decryptExpiryTooLongError(): Error {
  return Object.assign(new Error("decrypt grants last at most one hour"), {
    code: DECRYPT_EXPIRY_TOO_LONG,
  });
}

/**
 * Per-share network name `share-<shareId>`, with the shareId shape share-sdk
 * enforces (`packages/share-sdk/src/share-network.ts`). node-sdk does not depend
 * on share-sdk, so the shape is mirrored here; keep the two in step.
 */
const SHARE_NETWORK_NAME_RE = /^share-[a-z0-9][a-z0-9-]{15,35}$/;

/**
 * Whether `actions` on the network id `path` grant decrypt subject to the
 * one-hour cap. Decrypt on a per-share network (`share-<shareId>`) lasts as
 * long as that share's own grant, so it is exempt. Decrypt on any other
 * network, including `:default`, and any `path` that is not a network id, is
 * capped. Decrypt is matched by literal URN or covering wildcard, per
 * `actionContains`.
 */
export function grantsCappedDecrypt(path: string, actions: readonly string[]): boolean {
  if (!actions.some((action) => actionContains(action, ENCRYPTION.DECRYPT))) {
    return false;
  }
  return !(isNetworkId(path) && SHARE_NETWORK_NAME_RE.test(parseNetworkId(path).name));
}

/**
 * Whether any entry needs the one-hour decrypt cap (see {@link grantsCappedDecrypt}).
 * Entries must already be expanded (`expandPermissionEntries`) so short names
 * are full URNs. The cap is call-wide: one capped entry caps the whole call.
 * Internal only: not re-exported from the package index.
 */
export function includesDecrypt(entries: readonly PermissionEntry[]): boolean {
  return entries.some((entry) => grantsCappedDecrypt(entry.path, entry.actions));
}

/**
 * Whether a wasm `abilities` map (service -> path -> actions) grants decrypt
 * subject to the one-hour cap, judged per network path. Internal only: the
 * sink guard in `createDelegationWrapper` uses it.
 */
export function abilitiesIncludeDecrypt(
  abilities: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>,
): boolean {
  return Object.values(abilities).some((paths) =>
    Object.entries(paths).some(([path, actions]) => grantsCappedDecrypt(path, actions)),
  );
}

/**
 * Resolve the `expiry` option of {@link DelegateToOptions} into a concrete
 * millisecond duration from now. Default is {@link DEFAULT_DELEGATION_EXPIRY_MS}
 * (30 days, the SESSION tier).
 *
 * Accepts:
 *  - `undefined` → {@link DEFAULT_DELEGATION_EXPIRY_MS}
 *  - `number` → raw milliseconds (must be positive + finite)
 *  - `string` → parsed via {@link parseExpiry} (ms-format, e.g. `"7d"`)
 */
export function resolveExpiryMs(expiry: string | number | undefined): number {
  if (expiry === undefined) {
    return DEFAULT_DELEGATION_EXPIRY_MS;
  }
  if (typeof expiry === "number") {
    if (!Number.isFinite(expiry) || expiry <= 0) {
      throw new Error(
        `delegateTo expiry must be a positive finite number (got ${expiry})`,
      );
    }
    return expiry;
  }
  // string — parseExpiry throws ManifestValidationError on bad input.
  return parseExpiry(expiry);
}

/**
 * Extract the `expirationTime` field of a signed SIWE message as a `Date`.
 *
 * Returns `undefined` only when the SIWE genuinely has no `Expiration Time`
 * line (RFC-4501 permits it). Propagates parse errors — the SDK always
 * produces signed SIWEs during sign-in, so an unparseable `session.siwe`
 * means something is actively wrong and we do not want to silently skip
 * the expiry check.
 */
export function extractSiweExpiration(siwe: string): Date | undefined {
  const parsed = new SiweMessage(siwe);
  if (parsed.expirationTime === undefined || parsed.expirationTime === null) {
    return undefined;
  }
  const d = new Date(parsed.expirationTime);
  if (Number.isNaN(d.getTime())) {
    throw new Error(
      `Session SIWE has unparseable expirationTime: ${parsed.expirationTime}`,
    );
  }
  return d;
}
