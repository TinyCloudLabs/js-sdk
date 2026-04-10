/**
 * TinyCloud App Manifest
 *
 * A declarative description of an app's identity and the capabilities it
 * needs. The manifest drives the SIWE recap at sign-in time, enabling a
 * single wallet prompt that covers the app's own permissions plus any
 * pre-declared delegations.
 *
 * The SDK does NOT fetch external manifests. Apps compose their own manifest
 * (optionally including backend or agent addenda) before handing it to the
 * SDK.
 *
 * Canonical spec: `.claude/specs/manifest.md`.
 *
 * @packageDocumentation
 */

import ms from "ms";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single permission entry inside a manifest. This is the shape apps write
 * in their `manifest.json` and the shape we compare against when performing
 * the capability-subset derivability check in the delegation flow.
 *
 * `service` uses the long form (e.g. `"tinycloud.kv"`, `"tinycloud.sql"`)
 * which matches the ability-namespace half of the full action URN.
 */
export interface PermissionEntry {
  /** Service namespace, e.g. "tinycloud.kv", "tinycloud.sql", "tinycloud.duckdb", "tinycloud.capabilities". */
  service: string;
  /** "default" for the user's personal space, or a specific space id. */
  space: string;
  /**
   * Service-specific path.
   * - tinycloud.kv: hierarchical prefix. "/" = all, "foo/" = prefix match, "foo" = exact key
   * - tinycloud.sql: database name/file (e.g. "data.sqlite") or "/" for all
   * - tinycloud.duckdb: database name/file
   * - tinycloud.capabilities: capability key URI or "/" for all
   */
  path: string;
  /**
   * Short action names (e.g. "get", "put", "read", "ddl"). The SDK expands
   * these to full URNs (e.g. `tinycloud.kv/get`) during resolution.
   * Already-expanded URNs are passed through unchanged.
   */
  actions: string[];
  /** When true, the manifest prefix is NOT prepended to `path`. Default false. */
  skipPrefix?: boolean;
  /** Per-entry expiry override, ms-format. */
  expiry?: string;
}

/**
 * A pre-declared delegation that will be included in the main SIWE recap as
 * an additional audience.
 */
export interface ManifestDelegation {
  /** DID of the delegate (e.g. a backend's wallet DID). */
  to: string;
  /** Informational display name. Optional. */
  name?: string;
  /** Expiry override for this delegation, ms-format. Optional. */
  expiry?: string;
  /**
   * Permissions to delegate. Same shape as the top-level `permissions`, and
   * the manifest prefix is inherited identically (unless `skipPrefix: true`).
   */
  permissions: PermissionEntry[];
}

/**
 * The valid values for `Manifest.defaults`.
 *
 * - `false` → no auto-included permissions
 * - `true` → standard tier (KV + SQL read/write + capabilities:read)
 * - `"admin"` → standard + SQL ddl + capabilities:admin
 * - `"all"` → everything the SDK supports (including DuckDB)
 *
 * Unknown string values silently fall back to `true`. Values are normalized
 * (lowercase + trim) before matching.
 */
export type ManifestDefaults = boolean | "admin" | "all";

/**
 * The raw manifest shape an app declares. See `.claude/specs/manifest.md`.
 */
export interface Manifest {
  /** Schema version. Optional, defaults to 1. */
  version?: number;
  /** Bundle identifier — reverse DNS. Required. */
  id: string;
  /** Display name. Required. */
  name: string;
  /** One-line description. Optional. */
  description?: string;
  /** URL to app icon. Optional. */
  icon?: string;
  /** App version string. Optional. */
  appVersion?: string;
  /** Default expiry for permissions. ms-format ("30d", "2h", "1y"). Default "30d". */
  expiry?: string;
  /**
   * Path prefix auto-prepended to permission paths. Optional, defaults to
   * `id`. Set to `""` to disable entirely. Individual permissions can opt
   * out with `skipPrefix: true`.
   */
  prefix?: string;
  /**
   * Default permission set to auto-include. Optional, defaults to `true`.
   * See {@link ManifestDefaults}.
   */
  defaults?: ManifestDefaults | string;
  /** Whether to include the public-space companion delegation. Default `true`. */
  includePublicSpace?: boolean;
  /**
   * Additional permissions beyond the defaults. Use for cross-space access,
   * DuckDB (opt-in), or `skipPrefix: true` entries.
   */
  permissions?: PermissionEntry[];
  /** Pre-delegations to other DIDs at sign-in. */
  delegations?: ManifestDelegation[];
}

/**
 * A resolved permission entry with fully-expanded paths and action URNs.
 * This is the shape the delegation flow compares against parsed recap
 * capabilities, and the shape the session-key delegation path actually uses.
 */
export interface ResourceCapability {
  /** Long-form service, e.g. "tinycloud.kv". */
  service: string;
  /** Space id — "default" stays as-is here; the caller resolves it to a full SpaceId at sign-in time. */
  space: string;
  /** Path with the manifest prefix applied (or skipped per `skipPrefix`). */
  path: string;
  /** Full-URN actions, e.g. ["tinycloud.kv/get", "tinycloud.kv/put"]. */
  actions: string[];
  /** Per-entry expiry override in milliseconds. */
  expiryMs?: number;
}

/**
 * A resolved delegation entry with fully-expanded permissions.
 */
export interface ResolvedDelegate {
  /** DID of the delegate. */
  did: string;
  /** Informational display name. Optional. */
  name?: string;
  /** Expiry in milliseconds (per-delegation > manifest default > 30 days). */
  expiryMs: number;
  /** Fully resolved permissions. */
  permissions: ResourceCapability[];
}

/**
 * The output of {@link resolveManifest}: a fully-expanded capability set
 * ready to drive the SIWE recap.
 */
export interface ResolvedCapabilities {
  /** Bundle identifier copied from manifest.id. */
  id: string;
  /** All session-key resources with paths fully resolved (prefix applied). */
  resources: ResourceCapability[];
  /** Default expiry for the session, in milliseconds. */
  expiryMs: number;
  /** Whether to include the public-space companion. */
  includePublicSpace: boolean;
  /** Additional delegate targets with resolved paths. */
  additionalDelegates: ResolvedDelegate[];
}

/**
 * Thrown when the manifest fails validation (missing id/name, bad expiry,
 * empty actions on a permission, etc).
 */
export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(`Manifest validation failed: ${message}`);
    this.name = "ManifestValidationError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default expiry when neither the manifest, delegation, nor permission
 * specifies one. Spec: 30 days.
 */
export const DEFAULT_EXPIRY = "30d";

/**
 * Default `defaults` value when the manifest omits it. Spec: standard tier.
 */
export const DEFAULT_DEFAULTS: ManifestDefaults = true;

/**
 * Known services and their short-form (recap URI) names. The TinyCloud
 * node encodes the recap resource URI with the short service name, while
 * action URNs and manifest entries use the long `tinycloud.<short>` form.
 * This table is the canonical bridge between the two.
 */
export const SERVICE_SHORT_TO_LONG: Readonly<Record<string, string>> =
  Object.freeze({
    kv: "tinycloud.kv",
    sql: "tinycloud.sql",
    duckdb: "tinycloud.duckdb",
    capabilities: "tinycloud.capabilities",
    hooks: "tinycloud.hooks",
  });

/**
 * Inverse of {@link SERVICE_SHORT_TO_LONG}.
 */
export const SERVICE_LONG_TO_SHORT: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(SERVICE_SHORT_TO_LONG).map(([s, l]) => [l, s])
    )
  );

/**
 * Default permission entries for the `true` / standard tier.
 *
 * `tinycloud.capabilities:read` is ALWAYS present in any non-false default
 * so delegation chains can be verified.
 */
const DEFAULT_STANDARD_ENTRIES: readonly Omit<PermissionEntry, "skipPrefix">[] =
  [
    {
      service: "tinycloud.kv",
      space: "default",
      path: "/",
      actions: ["get", "put", "del", "list", "metadata"],
    },
    {
      service: "tinycloud.sql",
      space: "default",
      path: "/",
      actions: ["read", "write"],
    },
    {
      service: "tinycloud.capabilities",
      space: "default",
      path: "/",
      actions: ["read"],
    },
  ];

/**
 * Default permission entries for the `"admin"` tier: standard + sql/ddl +
 * capabilities/admin.
 */
const DEFAULT_ADMIN_ENTRIES: readonly Omit<PermissionEntry, "skipPrefix">[] = [
  {
    service: "tinycloud.kv",
    space: "default",
    path: "/",
    actions: ["get", "put", "del", "list", "metadata"],
  },
  {
    service: "tinycloud.sql",
    space: "default",
    path: "/",
    actions: ["read", "write", "ddl"],
  },
  {
    service: "tinycloud.capabilities",
    space: "default",
    path: "/",
    actions: ["read", "admin"],
  },
];

/**
 * Default permission entries for the `"all"` tier: admin + DuckDB.
 *
 * DuckDB is opt-in and only appears in this tier or in explicit manifest
 * `permissions` entries.
 */
const DEFAULT_ALL_ENTRIES: readonly Omit<PermissionEntry, "skipPrefix">[] = [
  {
    service: "tinycloud.kv",
    space: "default",
    path: "/",
    actions: ["get", "put", "del", "list", "metadata"],
  },
  {
    service: "tinycloud.sql",
    space: "default",
    path: "/",
    actions: ["read", "write", "ddl"],
  },
  {
    service: "tinycloud.duckdb",
    space: "default",
    path: "/",
    actions: ["read", "write"],
  },
  {
    service: "tinycloud.capabilities",
    space: "default",
    path: "/",
    actions: ["read", "admin"],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an ms-format duration string (e.g. "30d", "2h", "1y") into
 * milliseconds.
 *
 * @throws {ManifestValidationError} on empty string, non-string input, or
 * any input `ms()` cannot parse.
 */
export function parseExpiry(duration: string): number {
  if (typeof duration !== "string" || duration.length === 0) {
    throw new ManifestValidationError(
      `expiry must be a non-empty duration string (got ${JSON.stringify(duration)})`
    );
  }
  // `ms` returns `undefined` for unparseable input and can return a number
  // or a string depending on the call signature; cast explicitly.
  const parsed = (ms as unknown as (v: string) => number | undefined)(
    duration
  );
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    throw new ManifestValidationError(
      `invalid expiry duration: ${JSON.stringify(duration)}`
    );
  }
  return parsed;
}

/**
 * Expand a list of action short names (or already-expanded URNs) into full
 * ability URNs of the form `<service>/<action>`.
 *
 * Examples:
 *   `expandActionShortNames("tinycloud.kv", ["get", "put"])`
 *     → `["tinycloud.kv/get", "tinycloud.kv/put"]`
 *   `expandActionShortNames("tinycloud.kv", ["tinycloud.kv/get"])`
 *     → `["tinycloud.kv/get"]` (passed through unchanged)
 */
export function expandActionShortNames(
  service: string,
  actions: readonly string[]
): string[] {
  return actions.map((a) => {
    if (a.includes("/")) {
      // Already a full URN — pass through.
      return a;
    }
    return `${service}/${a}`;
  });
}

/**
 * Apply the manifest prefix to a permission path per the spec rules.
 *
 * - `skipPrefix: true` → path is returned as-is
 * - `prefix === ""` → path is returned as-is
 * - path starts with "/" → `prefix + path`  (e.g. "com.listen.app" + "/" → "com.listen.app/")
 * - otherwise → `prefix + "/" + path`  (e.g. "com.listen.app" + "data.sqlite" → "com.listen.app/data.sqlite")
 */
export function applyPrefix(
  prefix: string,
  path: string,
  skipPrefix: boolean
): string {
  if (skipPrefix) {
    return path;
  }
  if (prefix === "") {
    return path;
  }
  if (path.startsWith("/")) {
    return `${prefix}${path}`;
  }
  return `${prefix}/${path}`;
}

/**
 * Fetch and parse a manifest from a URL (browser) or file path (node).
 * The runtime decides the fetch strategy via `globalThis.fetch`; this is
 * platform-agnostic. Callers that want custom loading should JSON.parse a
 * Manifest themselves and skip this helper.
 *
 * @throws if the fetch fails, the JSON is invalid, or the manifest fails
 * validation.
 */
export async function loadManifest(url: string): Promise<Manifest> {
  const fetchFn: typeof fetch | undefined = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof fetchFn !== "function") {
    throw new ManifestValidationError(
      "loadManifest requires a global fetch; pass the manifest object directly on runtimes without fetch"
    );
  }
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new ManifestValidationError(
      `failed to fetch manifest from ${url}: HTTP ${res.status}`
    );
  }
  const json = (await res.json()) as unknown;
  return validateManifest(json);
}

/**
 * Validate a manifest-shaped object and return it strongly-typed.
 * Throws {@link ManifestValidationError} on any hard failure.
 */
export function validateManifest(input: unknown): Manifest {
  if (input === null || typeof input !== "object") {
    throw new ManifestValidationError("manifest must be an object");
  }
  const m = input as Manifest;
  if (typeof m.id !== "string" || m.id.length === 0) {
    throw new ManifestValidationError("manifest.id is required and must be a non-empty string");
  }
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new ManifestValidationError("manifest.name is required and must be a non-empty string");
  }
  if (m.expiry !== undefined) {
    // Will throw with a clear error if invalid.
    parseExpiry(m.expiry);
  }
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) {
      throw new ManifestValidationError("manifest.permissions must be an array");
    }
    m.permissions.forEach((p, i) =>
      validatePermissionEntry(p, `permissions[${i}]`)
    );
  }
  if (m.delegations !== undefined) {
    if (!Array.isArray(m.delegations)) {
      throw new ManifestValidationError("manifest.delegations must be an array");
    }
    m.delegations.forEach((d, i) => {
      if (typeof d?.to !== "string" || d.to.length === 0) {
        throw new ManifestValidationError(
          `delegations[${i}].to is required and must be a non-empty DID string`
        );
      }
      if (d.expiry !== undefined) {
        parseExpiry(d.expiry);
      }
      if (!Array.isArray(d.permissions)) {
        throw new ManifestValidationError(
          `delegations[${i}].permissions must be an array`
        );
      }
      d.permissions.forEach((p, j) =>
        validatePermissionEntry(p, `delegations[${i}].permissions[${j}]`)
      );
    });
  }
  return m;
}

function validatePermissionEntry(p: unknown, path: string): void {
  if (p === null || typeof p !== "object") {
    throw new ManifestValidationError(`${path} must be an object`);
  }
  const entry = p as PermissionEntry;
  if (typeof entry.service !== "string" || entry.service.length === 0) {
    throw new ManifestValidationError(`${path}.service is required`);
  }
  if (typeof entry.space !== "string" || entry.space.length === 0) {
    throw new ManifestValidationError(`${path}.space is required`);
  }
  if (typeof entry.path !== "string") {
    throw new ManifestValidationError(
      `${path}.path is required (use "" or "/" for root)`
    );
  }
  if (!Array.isArray(entry.actions) || entry.actions.length === 0) {
    throw new ManifestValidationError(
      `${path}.actions must be a non-empty array`
    );
  }
  if (entry.expiry !== undefined) {
    parseExpiry(entry.expiry);
  }
}

/**
 * Normalize a `defaults` value: lowercase + trim, then match against known
 * tiers. Unknown string values silently fall back to `true` (standard).
 * Boolean values pass through.
 */
export function normalizeDefaults(
  value: Manifest["defaults"] | undefined
): ManifestDefaults {
  if (value === undefined) {
    return DEFAULT_DEFAULTS;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    // Spec says unknown values silently fall back to `true`.
    return true;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "admin" || normalized === "all") {
    return normalized;
  }
  // Anything else, including "true"/"false"/"standard"/garbage, falls back
  // to the standard tier per spec.
  return true;
}

/**
 * Return the default permission entries for the given tier. Entries are
 * deep-cloned so callers can mutate them without affecting the constants.
 */
function defaultEntriesForTier(
  tier: ManifestDefaults
): PermissionEntry[] {
  if (tier === false) {
    return [];
  }
  const source =
    tier === "admin"
      ? DEFAULT_ADMIN_ENTRIES
      : tier === "all"
        ? DEFAULT_ALL_ENTRIES
        : DEFAULT_STANDARD_ENTRIES;
  return source.map((e) => ({
    service: e.service,
    space: e.space,
    path: e.path,
    actions: [...e.actions],
  }));
}

/**
 * Resolve a raw manifest into a {@link ResolvedCapabilities} object: expand
 * shortform actions, apply the prefix, merge defaults, and compute effective
 * expiries. Pure function — does no I/O.
 *
 * Resolution semantics (spec):
 * - `prefix` defaults to `id`; set to `""` to disable prefix application entirely.
 * - `defaults` defaults to `true` (standard tier); unknown string values fall back to `true`.
 * - Per-entry expiry overrides per-delegation overrides manifest > `DEFAULT_EXPIRY`.
 * - Default entries use `skipPrefix: false` so they inherit the manifest prefix.
 * - Prefix inheritance applies identically to `permissions` and `delegations[*].permissions`.
 */
export function resolveManifest(
  input: Manifest
): ResolvedCapabilities {
  const manifest = validateManifest(input);

  const prefix = manifest.prefix !== undefined ? manifest.prefix : manifest.id;
  const expiryMs = parseExpiry(manifest.expiry ?? DEFAULT_EXPIRY);
  const includePublicSpace = manifest.includePublicSpace ?? true;
  const tier = normalizeDefaults(manifest.defaults);

  const defaultEntries = defaultEntriesForTier(tier);
  const explicitEntries = manifest.permissions ?? [];

  // Merge order: defaults first, then explicit entries, so explicit entries
  // for the same (service, space, path) tuple override defaults.
  const allEntries: PermissionEntry[] = [...defaultEntries, ...explicitEntries];

  const resources: ResourceCapability[] = allEntries.map((entry) =>
    resolveEntry(entry, prefix, expiryMs)
  );

  const additionalDelegates: ResolvedDelegate[] = (
    manifest.delegations ?? []
  ).map((d) => ({
    did: d.to,
    name: d.name,
    expiryMs: parseExpiry(d.expiry ?? manifest.expiry ?? DEFAULT_EXPIRY),
    permissions: d.permissions.map((entry) =>
      resolveEntry(
        entry,
        prefix,
        parseExpiry(d.expiry ?? manifest.expiry ?? DEFAULT_EXPIRY)
      )
    ),
  }));

  return {
    id: manifest.id,
    resources,
    expiryMs,
    includePublicSpace,
    additionalDelegates,
  };
}

/**
 * Expand a single permission entry into a {@link ResourceCapability}:
 * apply the prefix to the path and expand short actions into full URNs.
 */
function resolveEntry(
  entry: PermissionEntry,
  prefix: string,
  _inheritedExpiryMs: number
): ResourceCapability {
  const resolvedPath = applyPrefix(
    prefix,
    entry.path,
    entry.skipPrefix === true
  );
  const resolvedActions = expandActionShortNames(entry.service, entry.actions);
  const entryExpiryMs =
    entry.expiry !== undefined ? parseExpiry(entry.expiry) : undefined;
  return {
    service: entry.service,
    space: entry.space,
    path: resolvedPath,
    actions: resolvedActions,
    // Only populate `expiryMs` when the entry had its own expiry override.
    // When absent, callers use the parent (delegation or manifest) expiry
    // which is carried on ResolvedDelegate.expiryMs / ResolvedCapabilities.expiryMs.
    ...(entryExpiryMs !== undefined ? { expiryMs: entryExpiryMs } : {}),
  };
}
