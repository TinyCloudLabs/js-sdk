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
  type PermissionEntry,
  parseExpiry,
  SiweMessage,
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
 * Resolve the `expiry` option of {@link DelegateToOptions} into a concrete
 * millisecond duration from now. Default is 1 hour to match the existing
 * `createDelegation` behaviour.
 *
 * Accepts:
 *  - `undefined` → 1 hour
 *  - `number` → raw milliseconds (must be positive + finite)
 *  - `string` → parsed via {@link parseExpiry} (ms-format, e.g. `"7d"`)
 */
export function resolveExpiryMs(expiry: string | number | undefined): number {
  if (expiry === undefined) {
    return 60 * 60 * 1000;
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
