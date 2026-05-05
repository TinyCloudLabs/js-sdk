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
 * `service` uses the long form (e.g. `"tinycloud.kv"`, `"tinycloud.sql"`).
 * `"tinycloud.vault"` is an SDK-only shorthand that expands to the KV
 * resources the vault service uses; it is never encoded as a recap service.
 */
export interface PermissionEntry {
  /** Service namespace, e.g. "tinycloud.kv", "tinycloud.sql", "tinycloud.duckdb", "tinycloud.capabilities". */
  service: string;
  /** Space name or full space URI. Defaults to "applications" inside manifests. */
  space?: string;
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
  /** User/agent-facing context for why this permission is requested. */
  description?: string;
}

export type ManifestSecretActions =
  | true
  | string
  | string[]
  | {
      actions?: string | string[];
      expiry?: string;
      description?: string;
    };

/**
 * The valid values for `Manifest.defaults`.
 *
 * - `false` → no auto-included permissions
 * - `true` → standard tier (KV + SQL read/write + capabilities:read)
 * - `"admin"` → standard + SQL ddl
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
  manifest_version?: 1;
  /** Application identifier / namespace prefix. Required. */
  app_id: string;
  /** Display name. Required. */
  name: string;
  /** Description of what the app or delegate does. Optional. */
  description?: string;
  /** DID of this manifest's delegate target. Optional. Required only for delegation materialization. */
  did?: string;
  /** URL to app icon. Optional. */
  icon?: string;
  /** App version string. Optional. */
  appVersion?: string;
  /** Default expiry for permissions. ms-format ("30d", "2h", "1y"). Default "30d". */
  expiry?: string;
  /** Space name or full space URI. Optional, defaults to "applications". */
  space?: string;
  /**
   * Path prefix auto-prepended to permission paths. Optional, defaults to
   * `app_id`. Set to `""` to disable entirely. Individual permissions can opt
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
  /**
   * Secret name shorthand. Entries resolve to encrypted vault KV resources in
   * the `secrets` space.
   */
  secrets?: Record<string, ManifestSecretActions>;
}

/**
 * A resolved permission entry with fully-expanded paths and action URNs.
 * This is the shape the delegation flow compares against parsed recap
 * capabilities, and the shape the session-key delegation path actually uses.
 */
export interface ResourceCapability {
  /** Long-form service, e.g. "tinycloud.kv". */
  service: string;
  /** Space name or URI. Short names are resolved to full SpaceIds at sign-in time. */
  space: string;
  /** Path with the manifest prefix applied (or skipped per `skipPrefix`). */
  path: string;
  /** Full-URN actions, e.g. ["tinycloud.kv/get", "tinycloud.kv/put"]. */
  actions: string[];
  /** Per-entry expiry override in milliseconds. */
  expiryMs?: number;
  /** User/agent-facing context copied from the source permission entry. */
  description?: string;
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
  /** Application identifier copied from manifest.app_id. */
  app_id: string;
  /** Delegate DID copied from manifest.did, when present. */
  did?: string;
  /** Effective default space for this manifest. */
  space: string;
  /** All session-key resources with paths fully resolved (prefix applied). */
  resources: ResourceCapability[];
  /** Default expiry for the session, in milliseconds. */
  expiryMs: number;
  /** Whether to include the public-space companion. */
  includePublicSpace: boolean;
  /** Delegate targets derived from manifests that declare `did`. */
  additionalDelegates: ResolvedDelegate[];
}

export interface ManifestRegistryRecord {
  /** KV key inside the account space. */
  key: string;
  /** App id this record describes. */
  app_id: string;
  /** Latest manifest payloads composed for this app id. */
  manifests: Manifest[];
}

export interface ComposeManifestOptions {
  /** Include implicit account-space registry permissions. Default true. */
  includeAccountRegistryPermissions?: boolean;
}

export interface ComposedManifestRequest {
  /** Validated manifests that were composed. */
  manifests: Manifest[];
  /** Full permission union requested from the user in one SIWE. */
  resources: ResourceCapability[];
  /** Delegations that can be materialized after sign-in. */
  delegationTargets: ResolvedDelegate[];
  /** Account-space registry records to write after successful sign-in. */
  registryRecords: ManifestRegistryRecord[];
  /** Effective session expiry, using the longest composed manifest expiry. */
  expiryMs: number;
  /** Whether to include the public-space companion behavior. */
  includePublicSpace: boolean;
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

/** Default manifest schema version. */
export const DEFAULT_MANIFEST_VERSION = 1;

/** Default space for manifest-declared app data. */
export const DEFAULT_MANIFEST_SPACE = "applications";

/** Account-space name used for installed-application registry records. */
export const ACCOUNT_REGISTRY_SPACE = "account";

/** Account-space KV prefix used for installed-application registry records. */
export const ACCOUNT_REGISTRY_PATH = "applications/";

const SECRETS_SPACE = "secrets";
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** SDK-only permission service for encrypted vault resources. */
export const VAULT_PERMISSION_SERVICE = "tinycloud.vault";

type VaultKVBase = "keys" | "vault";

interface VaultActionExpansion {
  bases: readonly VaultKVBase[];
  action: string;
}

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
      Object.entries(SERVICE_SHORT_TO_LONG).map(([s, l]) => [l, s]),
    ),
  );

/**
 * Default permission entries for the `true` / standard tier.
 *
 * `tinycloud.capabilities/read` is added separately for every requested
 * space, without the app path prefix. That keeps capability introspection
 * space-scoped instead of app-data scoped.
 */
const DEFAULT_STANDARD_ENTRIES: readonly PermissionEntry[] = [
  {
    service: "tinycloud.kv",
    space: DEFAULT_MANIFEST_SPACE,
    path: "/",
    actions: ["get", "put", "del", "list", "metadata"],
  },
  {
    service: "tinycloud.sql",
    space: DEFAULT_MANIFEST_SPACE,
    path: "/",
    actions: ["read", "write"],
  },
];

/**
 * Default permission entries for the `"admin"` tier: standard + sql/ddl.
 */
const DEFAULT_ADMIN_ENTRIES: readonly PermissionEntry[] = [
  {
    service: "tinycloud.kv",
    space: DEFAULT_MANIFEST_SPACE,
    path: "/",
    actions: ["get", "put", "del", "list", "metadata"],
  },
  {
    service: "tinycloud.sql",
    space: DEFAULT_MANIFEST_SPACE,
    path: "/",
    actions: ["read", "write", "ddl"],
  },
];

/**
 * Default permission entries for the `"all"` tier: admin + DuckDB.
 *
 * DuckDB is opt-in and only appears in this tier or in explicit manifest
 * `permissions` entries.
 */
const DEFAULT_ALL_ENTRIES: readonly PermissionEntry[] = [
  {
    service: "tinycloud.kv",
    space: DEFAULT_MANIFEST_SPACE,
    path: "/",
    actions: ["get", "put", "del", "list", "metadata"],
  },
  {
    service: "tinycloud.sql",
    space: DEFAULT_MANIFEST_SPACE,
    path: "/",
    actions: ["read", "write", "ddl"],
  },
  {
    service: "tinycloud.duckdb",
    space: DEFAULT_MANIFEST_SPACE,
    path: "/",
    actions: ["read", "write"],
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
      `expiry must be a non-empty duration string (got ${JSON.stringify(duration)})`,
    );
  }
  // `ms` returns `undefined` for unparseable input and can return a number
  // or a string depending on the call signature; cast explicitly.
  const parsed = (ms as unknown as (v: string) => number | undefined)(duration);
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    throw new ManifestValidationError(
      `invalid expiry duration: ${JSON.stringify(duration)}`,
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
  actions: readonly string[],
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
 * Expand SDK virtual permission services into concrete recap-capable services.
 *
 * Today this handles `"tinycloud.vault"`, which is backed by KV resources:
 * - read/get: `keys/<path>` + `vault/<path>` with `tinycloud.kv/get`
 * - write/put: `keys/<path>` + `vault/<path>` with `tinycloud.kv/put`
 * - delete/del: `keys/<path>` + `vault/<path>` with `tinycloud.kv/del`
 * - list: `vault/<path>` with `tinycloud.kv/list`
 * - head: `vault/<path>` with `tinycloud.kv/get`
 * - metadata: `vault/<path>` with `tinycloud.kv/metadata`
 */
export function expandPermissionEntry(entry: PermissionEntry): PermissionEntry[] {
  if (entry.service !== VAULT_PERMISSION_SERVICE) {
    return [
      {
        ...entry,
        actions: expandActionShortNames(entry.service, entry.actions),
      },
    ];
  }

  return expandVaultPermissionEntry(entry);
}

/**
 * Expand a list of permission entries using {@link expandPermissionEntry}.
 */
export function expandPermissionEntries(
  entries: readonly PermissionEntry[],
): PermissionEntry[] {
  return entries.flatMap(expandPermissionEntry);
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
  skipPrefix: boolean,
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
  const fetchFn: typeof fetch | undefined = (
    globalThis as { fetch?: typeof fetch }
  ).fetch;
  if (typeof fetchFn !== "function") {
    throw new ManifestValidationError(
      "loadManifest requires a global fetch; pass the manifest object directly on runtimes without fetch",
    );
  }
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new ManifestValidationError(
      `failed to fetch manifest from ${url}: HTTP ${res.status}`,
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
  if (
    m.manifest_version !== undefined &&
    m.manifest_version !== DEFAULT_MANIFEST_VERSION
  ) {
    throw new ManifestValidationError(
      `manifest.manifest_version must be ${DEFAULT_MANIFEST_VERSION}`,
    );
  }
  if (typeof m.app_id !== "string" || m.app_id.length === 0) {
    throw new ManifestValidationError(
      "manifest.app_id is required and must be a non-empty string",
    );
  }
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new ManifestValidationError(
      "manifest.name is required and must be a non-empty string",
    );
  }
  if (
    m.did !== undefined &&
    (typeof m.did !== "string" || m.did.length === 0)
  ) {
    throw new ManifestValidationError(
      "manifest.did must be a non-empty DID string",
    );
  }
  if (
    m.space !== undefined &&
    (typeof m.space !== "string" || m.space.length === 0)
  ) {
    throw new ManifestValidationError(
      "manifest.space must be a non-empty string",
    );
  }
  if (m.expiry !== undefined) {
    // Will throw with a clear error if invalid.
    parseExpiry(m.expiry);
  }
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) {
      throw new ManifestValidationError(
        "manifest.permissions must be an array",
      );
    }
    m.permissions.forEach((p, i) =>
      validatePermissionEntry(p, `permissions[${i}]`),
    );
  }
  if (m.secrets !== undefined) {
    validateManifestSecrets(m.secrets);
  }
  return m;
}

function validateManifestSecrets(secrets: unknown): void {
  if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new ManifestValidationError("manifest.secrets must be an object");
  }

  for (const [name, spec] of Object.entries(secrets)) {
    if (!SECRET_NAME_RE.test(name)) {
      throw new ManifestValidationError(
        `manifest.secrets.${name} must match ${SECRET_NAME_RE.source}`,
      );
    }
    const actions = secretActionsFromSpec(name, spec as ManifestSecretActions);
    if (actions.length === 0) {
      throw new ManifestValidationError(
        `manifest.secrets.${name} actions must be non-empty`,
      );
    }
    for (const action of actions) {
      if (typeof action !== "string" || action.length === 0) {
        throw new ManifestValidationError(
          `manifest.secrets.${name} actions must be non-empty strings`,
        );
      }
    }
    if (
      spec !== null &&
      typeof spec === "object" &&
      !Array.isArray(spec) &&
      (spec as { expiry?: unknown }).expiry !== undefined
    ) {
      parseExpiry((spec as { expiry: string }).expiry);
    }
  }
}

function validatePermissionEntry(p: unknown, path: string): void {
  if (p === null || typeof p !== "object") {
    throw new ManifestValidationError(`${path} must be an object`);
  }
  const entry = p as PermissionEntry;
  if (typeof entry.service !== "string" || entry.service.length === 0) {
    throw new ManifestValidationError(`${path}.service is required`);
  }
  if (
    entry.space !== undefined &&
    (typeof entry.space !== "string" || entry.space.length === 0)
  ) {
    throw new ManifestValidationError(
      `${path}.space must be a non-empty string`,
    );
  }
  if (typeof entry.path !== "string") {
    throw new ManifestValidationError(
      `${path}.path is required (use "" or "/" for root)`,
    );
  }
  if (!Array.isArray(entry.actions) || entry.actions.length === 0) {
    throw new ManifestValidationError(
      `${path}.actions must be a non-empty array`,
    );
  }
  for (const action of entry.actions) {
    if (typeof action !== "string" || action.length === 0) {
      throw new ManifestValidationError(
        `${path}.actions must contain non-empty strings`,
      );
    }
    if (entry.service === VAULT_PERMISSION_SERVICE) {
      vaultActionExpansion(action);
    }
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
  value: Manifest["defaults"] | undefined,
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
function defaultEntriesForTier(tier: ManifestDefaults): PermissionEntry[] {
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
    ...(e.skipPrefix !== undefined ? { skipPrefix: e.skipPrefix } : {}),
  }));
}

/**
 * Resolve a raw manifest into a {@link ResolvedCapabilities} object: expand
 * shortform actions, apply the prefix, merge defaults, and compute effective
 * expiries. Pure function — does no I/O.
 *
 * Resolution semantics (spec):
 * - `prefix` defaults to `app_id`; set to `""` to disable prefix application entirely.
 * - `space` defaults to `applications`; per-permission `space` overrides it.
 * - `defaults` defaults to `true` (standard tier); unknown string values fall back to `true`.
 * - Per-entry expiry overrides per-delegation overrides manifest > `DEFAULT_EXPIRY`.
 * - Default entries use `skipPrefix: false` so they inherit the manifest prefix.
 */
export function resolveManifest(input: Manifest): ResolvedCapabilities {
  const manifest = validateManifest(input);

  const prefix =
    manifest.prefix !== undefined ? manifest.prefix : manifest.app_id;
  const space = manifest.space ?? DEFAULT_MANIFEST_SPACE;
  const expiryMs = parseExpiry(manifest.expiry ?? DEFAULT_EXPIRY);
  const includePublicSpace = manifest.includePublicSpace ?? true;
  const tier = normalizeDefaults(manifest.defaults);

  const defaultEntries = defaultEntriesForTier(tier);
  const explicitEntries = manifest.permissions ?? [];
  const secretEntries = secretEntriesForManifest(manifest.secrets);

  // Merge order: defaults first, then explicit entries, so explicit entries
  // for the same (service, space, path) tuple override defaults.
  const allEntries: PermissionEntry[] = [
    ...defaultEntries,
    ...explicitEntries,
    ...secretEntries,
  ];

  const resources: ResourceCapability[] = withCapabilitiesReadForSpaces(
    allEntries.flatMap((entry) => resolveEntry(entry, prefix, expiryMs, space)),
  );

  const additionalDelegates: ResolvedDelegate[] =
    manifest.did === undefined
      ? []
      : [
          {
            did: manifest.did,
            name: manifest.name,
            expiryMs,
            permissions: resources.map(cloneResourceCapability),
          },
        ];

  return {
    app_id: manifest.app_id,
    ...(manifest.did !== undefined ? { did: manifest.did } : {}),
    space,
    resources,
    expiryMs,
    includePublicSpace,
    additionalDelegates,
  };
}

function normalizeSecretActions(actions: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (action: string) => {
    if (!seen.has(action)) {
      out.push(action);
      seen.add(action);
    }
  };

  for (const action of actions) {
    if (action === "read") {
      add("get");
      continue;
    }
    if (action === "write") {
      add("put");
      continue;
    }
    if (action === "delete") {
      add("del");
      continue;
    }
    if (
      action === "get" ||
      action === "put" ||
      action === "del" ||
      action === "list" ||
      action === "metadata"
    ) {
      add(action);
      continue;
    }
    if (
      action === "tinycloud.kv/get" ||
      action === "tinycloud.kv/put" ||
      action === "tinycloud.kv/del" ||
      action === "tinycloud.kv/list" ||
      action === "tinycloud.kv/metadata"
    ) {
      add(action);
      continue;
    }
    throw new ManifestValidationError(
      `unknown secret action ${JSON.stringify(action)}; expected read, write, delete, list, or metadata`,
    );
  }

  return out;
}

function secretActionsFromSpec(
  name: string,
  spec: ManifestSecretActions,
): string[] {
  if (spec === true) {
    return ["read"];
  }
  if (typeof spec === "string") {
    return [spec];
  }
  if (Array.isArray(spec)) {
    return spec;
  }
  if (spec === null || typeof spec !== "object") {
    throw new ManifestValidationError(
      `manifest.secrets.${name} must be true, a string action, an actions array, or an object`,
    );
  }
  if (spec.actions === undefined) {
    return ["read"];
  }
  if (typeof spec.actions === "string") {
    return [spec.actions];
  }
  if (Array.isArray(spec.actions)) {
    return spec.actions;
  }
  throw new ManifestValidationError(
    `manifest.secrets.${name}.actions must be a string or array`,
  );
}

function secretEntriesForManifest(
  secrets: Manifest["secrets"] | undefined,
): PermissionEntry[] {
  if (secrets === undefined) {
    return [];
  }

  const entries: PermissionEntry[] = [];
  for (const [name, spec] of Object.entries(secrets)) {
    const actions = secretActionsFromSpec(name, spec);
    const extra: { expiry?: string; description?: string } =
      spec !== true && typeof spec === "object" && !Array.isArray(spec)
        ? spec
        : {};
    for (const base of ["keys", "vault"]) {
      entries.push({
        service: "tinycloud.kv",
        space: SECRETS_SPACE,
        path: `${base}/secrets/${name}`,
        actions: normalizeSecretActions(actions),
        skipPrefix: true,
        ...(extra.expiry !== undefined ? { expiry: extra.expiry } : {}),
        ...(extra.description !== undefined
          ? { description: extra.description }
          : {}),
      });
    }
  }
  return entries;
}

/**
 * Expand a single permission entry into a {@link ResourceCapability}:
 * apply the prefix to the path and expand short actions into full URNs.
 */
function resolveEntry(
  entry: PermissionEntry,
  prefix: string,
  _inheritedExpiryMs: number,
  inheritedSpace: string,
): ResourceCapability[] {
  const resolvedPath = applyPrefix(
    prefix,
    entry.path,
    entry.skipPrefix === true,
  );
  const entryExpiryMs =
    entry.expiry !== undefined ? parseExpiry(entry.expiry) : undefined;
  return expandPermissionEntry({
    ...entry,
    space: entry.space ?? inheritedSpace,
    path: resolvedPath,
    skipPrefix: true,
  }).map((expanded) => ({
    service: expanded.service,
    space: expanded.space ?? inheritedSpace,
    path: expanded.path,
    actions: expanded.actions,
    // Only populate `expiryMs` when the entry had its own expiry override.
    // When absent, callers use the parent (delegation or manifest) expiry
    // which is carried on ResolvedDelegate.expiryMs / ResolvedCapabilities.expiryMs.
    ...(entryExpiryMs !== undefined ? { expiryMs: entryExpiryMs } : {}),
    ...(entry.description !== undefined
      ? { description: entry.description }
      : {}),
  }));
}

function expandVaultPermissionEntry(entry: PermissionEntry): PermissionEntry[] {
  const byBase = new Map<VaultKVBase, string[]>();

  for (const action of entry.actions) {
    const expansion = vaultActionExpansion(action);
    for (const base of expansion.bases) {
      const actions = byBase.get(base) ?? [];
      if (!actions.includes(expansion.action)) {
        actions.push(expansion.action);
      }
      byBase.set(base, actions);
    }
  }

  return [...byBase.entries()].map(([base, actions]) => ({
    ...entry,
    service: "tinycloud.kv",
    path: vaultKVPath(base, entry.path),
    actions,
    skipPrefix: true,
  }));
}

function vaultActionExpansion(action: string): VaultActionExpansion {
  const normalized = normalizeVaultAction(action);
  if (normalized === "read" || normalized === "get") {
    return { bases: ["keys", "vault"], action: "tinycloud.kv/get" };
  }
  if (normalized === "write" || normalized === "put") {
    return { bases: ["keys", "vault"], action: "tinycloud.kv/put" };
  }
  if (normalized === "delete" || normalized === "del") {
    return { bases: ["keys", "vault"], action: "tinycloud.kv/del" };
  }
  if (normalized === "list") {
    return { bases: ["vault"], action: "tinycloud.kv/list" };
  }
  if (normalized === "head") {
    return { bases: ["vault"], action: "tinycloud.kv/get" };
  }
  if (normalized === "metadata") {
    return { bases: ["vault"], action: "tinycloud.kv/metadata" };
  }

  throw new ManifestValidationError(
    `unknown vault action ${JSON.stringify(action)}; expected read, write, delete, get, put, del, list, head, or metadata`,
  );
}

function normalizeVaultAction(action: string): string {
  if (action.startsWith(`${VAULT_PERMISSION_SERVICE}/`)) {
    return action.slice(`${VAULT_PERMISSION_SERVICE}/`.length);
  }
  if (action.startsWith("tinycloud.kv/")) {
    return action.slice("tinycloud.kv/".length);
  }
  if (action.includes("/")) {
    throw new ManifestValidationError(
      `unknown vault action ${JSON.stringify(action)}; expected a tinycloud.vault or tinycloud.kv action`,
    );
  }
  return action;
}

function vaultKVPath(base: VaultKVBase, path: string): string {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return `${base}/${normalized}`;
}

function cloneResourceCapability(
  entry: ResourceCapability,
): ResourceCapability {
  return {
    service: entry.service,
    space: entry.space,
    path: entry.path,
    actions: [...entry.actions],
    ...(entry.expiryMs !== undefined ? { expiryMs: entry.expiryMs } : {}),
    ...(entry.description !== undefined
      ? { description: entry.description }
      : {}),
  };
}

function clonePermissionEntry(entry: PermissionEntry): PermissionEntry {
  return {
    service: entry.service,
    ...(entry.space !== undefined ? { space: entry.space } : {}),
    path: entry.path,
    actions: [...entry.actions],
    ...(entry.skipPrefix !== undefined ? { skipPrefix: entry.skipPrefix } : {}),
    ...(entry.expiry !== undefined ? { expiry: entry.expiry } : {}),
    ...(entry.description !== undefined
      ? { description: entry.description }
      : {}),
  };
}

function dedupeResources(
  resources: readonly ResourceCapability[],
): ResourceCapability[] {
  const byKey = new Map<string, ResourceCapability>();

  for (const resource of resources) {
    const key = `${resource.service}\u0000${resource.space}\u0000${resource.path}\u0000${resource.expiryMs ?? ""}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, cloneResourceCapability(resource));
      continue;
    }

    const seen = new Set(existing.actions);
    for (const action of resource.actions) {
      if (!seen.has(action)) {
        existing.actions.push(action);
        seen.add(action);
      }
    }
    if (
      existing.description === undefined &&
      resource.description !== undefined
    ) {
      existing.description = resource.description;
    }
  }

  return [...byKey.values()];
}

function capabilitiesReadPermission(space: string): ResourceCapability {
  return {
    service: "tinycloud.capabilities",
    space,
    path: "",
    actions: ["tinycloud.capabilities/read"],
  };
}

function withCapabilitiesReadForSpaces(
  resources: readonly ResourceCapability[],
): ResourceCapability[] {
  if (resources.length === 0) {
    return [];
  }

  const spaces = new Set(resources.map((resource) => resource.space));
  return dedupeResources([
    ...resources,
    ...[...spaces].map(capabilitiesReadPermission),
  ]);
}

function accountRegistryPermission(): ResourceCapability {
  return {
    service: "tinycloud.kv",
    space: ACCOUNT_REGISTRY_SPACE,
    path: ACCOUNT_REGISTRY_PATH,
    actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list"],
  };
}

/**
 * Compose one or more manifests into the single capability request that should
 * be signed. Fetching manifests is intentionally out of band; callers pass the
 * already-loaded manifest objects.
 */
export function composeManifestRequest(
  inputs: readonly Manifest[],
  options: ComposeManifestOptions = {},
): ComposedManifestRequest {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new ManifestValidationError(
      "composeManifestRequest requires at least one manifest",
    );
  }

  const includeAccountRegistryPermissions =
    options.includeAccountRegistryPermissions ?? true;
  const manifests = inputs.map(validateManifest);
  const resolved = manifests.map(resolveManifest);
  const resources = resolved.flatMap((entry) => entry.resources);
  const delegationTargets = resolved.flatMap((entry) =>
    entry.additionalDelegates.map((delegate) => ({
      ...delegate,
      permissions: dedupeResources(delegate.permissions),
    })),
  );

  if (includeAccountRegistryPermissions) {
    resources.push(accountRegistryPermission());
  }
  const resourcesWithImplicitCapabilities =
    withCapabilitiesReadForSpaces(resources);

  const manifestsByAppId = new Map<string, Manifest[]>();
  for (const manifest of manifests) {
    const current = manifestsByAppId.get(manifest.app_id);
    if (current === undefined) {
      manifestsByAppId.set(manifest.app_id, [manifest]);
    } else {
      current.push(manifest);
    }
  }

  const registryRecords: ManifestRegistryRecord[] =
    includeAccountRegistryPermissions
      ? [...manifestsByAppId.entries()].map(([app_id, appManifests]) => ({
          key: `${ACCOUNT_REGISTRY_PATH}${app_id}`,
          app_id,
          manifests: appManifests.map((manifest) => ({
            ...manifest,
            permissions: manifest.permissions?.map(clonePermissionEntry),
          })),
        }))
      : [];

  return {
    manifests,
    resources: resourcesWithImplicitCapabilities,
    delegationTargets,
    registryRecords,
    expiryMs: Math.max(...resolved.map((entry) => entry.expiryMs)),
    includePublicSpace: resolved.some((entry) => entry.includePublicSpace),
  };
}

// ---------------------------------------------------------------------------
// Abilities map construction (bridge to WASM prepareSession / createDelegation)
// ---------------------------------------------------------------------------

/**
 * The shape `prepareSession` and the multi-resource `createDelegation` WASM
 * export both accept:
 *
 * ```
 * { [shortService]: { [path]: [fullUrnAction, ...] } }
 * ```
 *
 * - `shortService` is the recap-level service segment (`"kv"`, `"sql"`,
 *   `"duckdb"`, `"capabilities"`, `"hooks"`) — not the manifest long form.
 * - `path` is the fully-resolved path (prefix already applied). An empty
 *   string means "no path segment" on the resource URI.
 * - Action strings are full URNs like `"tinycloud.kv/get"`.
 *
 * This is a single source of truth for both the session's own recap (at
 * sign-in) and the delegations it can derive (post sign-in). We re-use it
 * for both so one manifest drives both sides.
 */
export type AbilitiesMap = Record<string, Record<string, string[]>>;

/**
 * Per-space abilities map accepted by the newer WASM session config:
 *
 * ```
 * { [spaceIdOrName]: { [shortService]: { [path]: [fullUrnAction, ...] } } }
 * ```
 */
export type SpaceAbilitiesMap = Record<string, AbilitiesMap>;

/**
 * Convert a list of {@link ResourceCapability} entries (manifest
 * long-form service, full-URN actions) into the {@link AbilitiesMap}
 * shape the WASM layer expects.
 *
 * When multiple entries target the same `(service, path)` pair, their
 * action lists are merged and deduped. Entries whose service has no
 * short-form mapping in {@link SERVICE_LONG_TO_SHORT} are rejected with
 * a {@link ManifestValidationError} — the SDK does not silently drop
 * unknown services because the recap encoding would lose them.
 *
 * Paths are kept verbatim: this function does NOT collapse
 * `"com.listen.app/"` and `"com.listen.app"` or reinterpret empty /
 * slash strings. Callers that care about path canonicalization should
 * normalize before calling.
 */
export function resourceCapabilitiesToAbilitiesMap(
  resources: readonly ResourceCapability[],
): AbilitiesMap {
  const out: AbilitiesMap = {};
  for (const r of resources) {
    const shortService = SERVICE_LONG_TO_SHORT[r.service];
    if (shortService === undefined) {
      throw new ManifestValidationError(
        `unknown service '${r.service}' — no short-form mapping. Known services: ${Object.keys(SERVICE_LONG_TO_SHORT).join(", ")}`,
      );
    }
    if (out[shortService] === undefined) {
      out[shortService] = {};
    }
    const pathsMap = out[shortService];
    const existing = pathsMap[r.path];
    if (existing === undefined) {
      // Copy so downstream mutation can't leak back into the input.
      pathsMap[r.path] = [...r.actions];
    } else {
      // Merge + dedupe while preserving first-seen order.
      const seen = new Set(existing);
      for (const action of r.actions) {
        if (!seen.has(action)) {
          existing.push(action);
          seen.add(action);
        }
      }
    }
  }
  return out;
}

/**
 * Group resolved capabilities by `space`, then convert each group into a WASM
 * abilities map. Short space names are left as-is here; platform layers that
 * know the wallet address and chain id turn them into full SpaceIds.
 */
export function resourceCapabilitiesToSpaceAbilitiesMap(
  resources: readonly ResourceCapability[],
): SpaceAbilitiesMap {
  const grouped = new Map<string, ResourceCapability[]>();
  for (const resource of resources) {
    const entries = grouped.get(resource.space);
    if (entries === undefined) {
      grouped.set(resource.space, [resource]);
    } else {
      entries.push(resource);
    }
  }

  const out: SpaceAbilitiesMap = {};
  for (const [space, entries] of grouped.entries()) {
    out[space] = resourceCapabilitiesToAbilitiesMap(entries);
  }
  return out;
}

/**
 * Build the {@link AbilitiesMap} that a session should be signed with,
 * given a {@link ResolvedCapabilities} (i.e. the output of
 * {@link resolveManifest}).
 *
 * The resulting map is the **union** of:
 * 1. the app's own resources (`resolved.resources`), and
 * 2. every permission declared in every `additionalDelegates[*]` entry.
 *
 * The union is what makes the manifest's delegations ergonomic: at
 * sign-in, the session key acquires recap coverage for both the app's
 * runtime needs and every downstream delegation target. Post sign-in,
 * `delegateTo(backendDID, backendPermissions)` can then issue the
 * sub-delegation via the session key (no wallet prompt) because the
 * caps are already part of the granted set.
 *
 * Duplicate `(service, path, action)` triples across resources and
 * delegations are merged and deduped — the session SIWE doesn't need
 * them repeated.
 */
export function manifestAbilitiesUnion(
  resolved: ResolvedCapabilities,
): AbilitiesMap {
  const all: ResourceCapability[] = [...resolved.resources];
  for (const delegate of resolved.additionalDelegates) {
    for (const perm of delegate.permissions) {
      all.push(perm);
    }
  }
  return resourceCapabilitiesToAbilitiesMap(all);
}
