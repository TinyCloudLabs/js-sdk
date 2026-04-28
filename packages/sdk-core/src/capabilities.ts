/**
 * Capability subset checking and recap parsing.
 *
 * This module powers the capability-chain delegation flow. The key decision
 * a `delegateTo` call has to make is: "are the requested capabilities a
 * subset of what the current session already grants?"
 *
 * - If yes → issue the delegation via the session-key UCAN path (no wallet prompt).
 * - If no → raise {@link PermissionNotInManifestError} so the caller can
 *   trigger an escalation flow via `requestPermissions`.
 *
 * Canonical spec: `.claude/specs/capability-chain.md`.
 *
 * @packageDocumentation
 */

import {
  DEFAULT_MANIFEST_SPACE,
  type PermissionEntry,
  SERVICE_SHORT_TO_LONG,
  expandActionShortNames,
} from "./manifest";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a `delegateTo` call requests capabilities that the current
 * session does not already grant. The caller can catch this and trigger
 * `requestPermissions(missing)` to show an escalation modal.
 */
export class PermissionNotInManifestError extends Error {
  public readonly missing: PermissionEntry[];
  public readonly granted: PermissionEntry[];

  constructor(missing: PermissionEntry[], granted: PermissionEntry[]) {
    super(
      `Requested capabilities exceed current session. Missing ${missing.length} entries.`
    );
    this.name = "PermissionNotInManifestError";
    this.missing = missing;
    this.granted = granted;
  }
}

/**
 * Thrown when the current session has expired (or will expire within the
 * safety margin). The caller should trigger a fresh sign-in.
 */
export class SessionExpiredError extends Error {
  public readonly expiredAt: Date;

  constructor(expiredAt: Date) {
    super(`Session expired at ${expiredAt.toISOString()}`);
    this.name = "SessionExpiredError";
    this.expiredAt = expiredAt;
  }
}

// ---------------------------------------------------------------------------
// Space normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a space identifier to its short-name form.
 *
 * Recap resource URIs in a signed SIWE encode the space as a full URI of the
 * form `tinycloud:pkh:eip155:{chainId}:{address}:{name}` (e.g.
 * `tinycloud:pkh:eip155:1:0xd559...:default`). Manifest permissions and
 * backend-advertised permissions use the short `{name}` form (e.g.
 * `"default"`).
 *
 * Strict string comparison between these two forms would always fail, so we
 * normalize both sides to the short name before comparing. The trailing
 * segment after the last `:` in a `tinycloud:` URI is the space name.
 *
 * Short names (`"default"`, `"work-space"`) are returned unchanged.
 * Any non-`tinycloud:` string is returned unchanged. A malformed URI with a
 * trailing colon is returned unchanged (so the check degrades to a strict
 * mismatch rather than collapsing to an empty string).
 *
 * @internal
 */
export function normalizeSpace(space: string): string {
  if (!space.startsWith("tinycloud:")) {
    return space;
  }
  const lastColon = space.lastIndexOf(":");
  if (lastColon === -1 || lastColon === space.length - 1) {
    return space;
  }
  return space.slice(lastColon + 1);
}

// ---------------------------------------------------------------------------
// Subset check
// ---------------------------------------------------------------------------

export interface SubsetCheckResult {
  /** True when every requested entry is covered by a granted entry. */
  subset: boolean;
  /** Entries the granted set does not cover (empty when `subset` is true). */
  missing: PermissionEntry[];
}

/**
 * Check whether `requested` is a strict subset of `granted`.
 *
 * Matching rules for each `requested[i]`:
 * - `service` matches exactly.
 * - `space` matches exactly.
 * - Path containment:
 *     - If `granted.path` ends with `/`, it covers any `requested.path` that
 *       starts with `granted.path`.
 *     - Otherwise, the paths must match exactly.
 * - Action containment: every URN in `requested.actions` must appear in
 *   `granted.actions` (set subset).
 *
 * Any `requested` entry that does not find a matching `granted` entry is
 * added to `missing` and the overall result is non-subset.
 *
 * Both sides are expected to be in the canonical long-form shape (service
 * starts with `tinycloud.`, actions are full URNs). Use {@link parseRecapCapabilities}
 * or `expandActionShortNames` to normalize inputs first.
 */
export function isCapabilitySubset(
  requested: readonly PermissionEntry[],
  granted: readonly PermissionEntry[]
): SubsetCheckResult {
  const missing: PermissionEntry[] = [];

  for (const req of requested) {
    const match = granted.find((g) => canonicalizeEntryMatches(req, g));
    if (match === undefined) {
      missing.push(cloneEntry(req));
      continue;
    }
    // `match` is confirmed to cover `req`; nothing to record.
  }

  return { subset: missing.length === 0, missing };
}

/**
 * Returns true when `granted` fully covers `requested` — same service, same
 * space, path containment per spec, and action set containment.
 */
function canonicalizeEntryMatches(
  requested: PermissionEntry,
  granted: PermissionEntry
): boolean {
  if (requested.service !== granted.service) {
    return false;
  }
  // Normalize both sides so callers passing short names (`"default"`) match
  // recap-parsed full URIs (`"tinycloud:pkh:eip155:1:0xd559...:default"`) and
  // vice versa. Idempotent for short names.
  if (
    normalizeSpace(requested.space ?? DEFAULT_MANIFEST_SPACE) !==
    normalizeSpace(granted.space ?? DEFAULT_MANIFEST_SPACE)
  ) {
    return false;
  }
  if (!pathContains(granted.path, requested.path)) {
    return false;
  }
  // Normalize actions to full URN form on both sides before set comparison,
  // so a caller passing short names ("get") against a granted entry with
  // full URNs still behaves correctly.
  const reqActions = new Set(
    expandActionShortNames(requested.service, requested.actions)
  );
  const grantedActions = new Set(
    expandActionShortNames(granted.service, granted.actions)
  );
  for (const a of reqActions) {
    if (!grantedActions.has(a)) {
      return false;
    }
  }
  return true;
}

/**
 * Path containment per spec:
 * - `granted.path` ends with `/` → prefix match (requested starts with granted)
 * - otherwise → exact string match
 *
 * The empty string is treated as "no path constraint" and matches anything.
 * The single-character `"/"` also matches anything (it is a trailing-slash
 * prefix of zero-length).
 */
function pathContains(grantedPath: string, requestedPath: string): boolean {
  if (grantedPath === "" || grantedPath === "/") {
    return true;
  }
  if (grantedPath.endsWith("/")) {
    return requestedPath.startsWith(grantedPath);
  }
  return requestedPath === grantedPath;
}

function cloneEntry(entry: PermissionEntry): PermissionEntry {
  return {
    service: entry.service,
    ...(entry.space !== undefined ? { space: entry.space } : {}),
    path: entry.path,
    actions: [...entry.actions],
    ...(entry.skipPrefix !== undefined ? { skipPrefix: entry.skipPrefix } : {}),
    ...(entry.expiry !== undefined ? { expiry: entry.expiry } : {}),
  };
}

// ---------------------------------------------------------------------------
// Recap parsing (WASM wrapper)
// ---------------------------------------------------------------------------

/**
 * The raw shape returned from the WASM `parseRecapFromSiwe` export. The
 * Rust layer encodes the service in the short form (e.g. `"kv"`) because
 * that is what the SIWE recap resource URI actually contains. We normalize
 * to the manifest long form (`"tinycloud.kv"`) in {@link parseRecapCapabilities}.
 *
 * @internal
 */
export interface WasmRecapEntry {
  service: string;
  space: string;
  path: string;
  actions: string[];
}

/**
 * Signature of the WASM `parseRecapFromSiwe` export. Accepts the signed
 * SIWE message string and returns an array of raw recap entries. Throws if
 * the SIWE is malformed or the recap statement has been tampered.
 *
 * Exposed as an interface so the SDK can inject the web or node binding
 * without `capabilities.ts` needing to know which.
 */
export type ParseRecapFromSiwe = (siweString: string) => WasmRecapEntry[];

/**
 * Parse a signed SIWE message into an array of {@link PermissionEntry}
 * objects in the canonical long-form manifest shape.
 *
 * This is a thin wrapper around the WASM `parseRecapFromSiwe` export that:
 * 1. Normalizes short-form services (`"kv"`) to long-form (`"tinycloud.kv"`).
 * 2. Returns entries in a deterministic order (sorted by space, then service,
 *    then path) so downstream equality checks are stable.
 *
 * Returns an empty array when the SIWE has no recap resource (plain auth
 * SIWE); this matches the WASM function's behavior and the spec.
 *
 * @param parseWasm The WASM `parseRecapFromSiwe` binding.
 * @param siwe The signed SIWE message string (exactly what `session.siwe` stores).
 */
export function parseRecapCapabilities(
  parseWasm: ParseRecapFromSiwe,
  siwe: string
): PermissionEntry[] {
  const raw = parseWasm(siwe);
  if (!Array.isArray(raw)) {
    throw new Error(
      "parseRecapFromSiwe returned a non-array value; wasm binding may be out of sync"
    );
  }
  const normalized: PermissionEntry[] = raw.map((entry) => {
    const longService =
      SERVICE_SHORT_TO_LONG[entry.service] ??
      // Unknown short names pass through. If the recap already contained a
      // long-form service (e.g. a future tinycloud-node version emits long
      // form directly), don't double-prefix.
      (entry.service.startsWith("tinycloud.")
        ? entry.service
        : `tinycloud.${entry.service}`);
    return {
      service: longService,
      // The Rust layer emits the space as a full `tinycloud:pkh:...:name`
      // URI (the recap target URI). Normalize to the short name so the
      // returned entries match the shape manifests use.
      space: normalizeSpace(entry.space),
      path: entry.path,
      actions: [...entry.actions],
    };
  });

  // Sort for determinism (callers do equality checks on arrays of entries
  // in tests; deterministic ordering keeps those stable).
  normalized.sort((a, b) => {
    const aSpace = a.space ?? DEFAULT_MANIFEST_SPACE;
    const bSpace = b.space ?? DEFAULT_MANIFEST_SPACE;
    if (aSpace !== bSpace) return aSpace < bSpace ? -1 : 1;
    if (a.service !== b.service) return a.service < b.service ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return 0;
  });

  return normalized;
}
