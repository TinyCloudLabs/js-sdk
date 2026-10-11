export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

const SECRET_PREFIX = "secrets/";
const SCOPED_SECRET_PREFIX = "secrets/scoped/";
const RESERVED_SECRET_SCOPES = new Set(["default", "global"]);

export interface SecretScopeOptions {
  /** Optional logical scope. Omit for the global secret namespace. */
  scope?: string;
}

/** Canonical secret scope grammar shared with the TC-832 `/request` link. */
export const SECRET_SCOPE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Longest scope the TC-832 `/request` link accepts. */
export const MAX_SECRET_SCOPE_LENGTH = 64;

/** Scopes the TC-832 `/request` link refuses. */
export const TC832_RESERVED_SCOPES: readonly string[] = Object.freeze([
  "default",
  "global",
  "scoped",
]);

export interface SecretPutOptions extends SecretScopeOptions {
  /** Write only when no secret exists under this name; never overwrite. */
  ifAbsent?: boolean;
}

/**
 * Derive the canonical secret scope for an app id such as
 * `xyz.tinycloud.feed-workflows` → `xyz-tinycloud-feed-workflows`.
 */
export function appSecretScope(appId: string): string {
  if (appId.trim() === "") {
    throw new Error("App id must be non-empty to derive a secret scope.");
  }
  const scope = appId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (scope === "") {
    throw new Error(
      `App id ${JSON.stringify(appId)} must contain at least one letter or number.`,
    );
  }
  if (scope.length > MAX_SECRET_SCOPE_LENGTH) {
    throw new Error(
      `App id ${JSON.stringify(appId)} yields a secret scope longer than ${MAX_SECRET_SCOPE_LENGTH} characters.`,
    );
  }
  if (TC832_RESERVED_SCOPES.includes(scope)) {
    throw new Error(
      `App id ${JSON.stringify(appId)} yields the reserved secret scope ${JSON.stringify(scope)}.`,
    );
  }
  return scope;
}

export interface ResolvedSecretPath {
  /** Canonical env-style secret name. */
  name: string;
  /** Canonical scope. Undefined means global. */
  scope?: string;
  /** Key passed to the data vault service. */
  vaultKey: string;
  /** KV permission path that backs the encrypted vault entry. */
  permissionPaths: {
    vault: string;
  };
}

export interface ParsedSecretCatalogKey {
  name: string;
  scope?: string;
}

export function canonicalizeSecretScope(
  scope: string | undefined,
): string | undefined {
  if (scope === undefined) {
    return undefined;
  }

  const trimmed = scope.trim();
  if (trimmed === "") {
    throw new Error(
      "Secret scope must be non-empty; omit scope for global secrets.",
    );
  }

  const canonical = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (canonical === "") {
    throw new Error("Secret scope must contain at least one letter or number.");
  }
  if (RESERVED_SECRET_SCOPES.has(canonical)) {
    throw new Error(
      `Secret scope ${JSON.stringify(scope)} is reserved; omit scope for global secrets.`,
    );
  }

  return canonical;
}

export function resolveSecretPath(
  name: string,
  options: SecretScopeOptions = {},
): ResolvedSecretPath {
  const normalizedName = name.trim();
  if (!SECRET_NAME_RE.test(normalizedName)) {
    throw new Error(
      `Invalid secret name ${JSON.stringify(name)}. Secret names must match ${SECRET_NAME_RE.source}.`,
    );
  }

  const scope = canonicalizeSecretScope(options.scope);
  const vaultKey =
    scope === undefined
      ? `${SECRET_PREFIX}${normalizedName}`
      : `${SCOPED_SECRET_PREFIX}${scope}/${normalizedName}`;

  return {
    name: normalizedName,
    ...(scope !== undefined ? { scope } : {}),
    vaultKey,
    permissionPaths: {
      vault: `vault/${vaultKey}`,
    },
  };
}

export function resolveSecretListPrefix(
  options: SecretScopeOptions = {},
): string {
  const scope = canonicalizeSecretScope(options.scope);
  return scope === undefined
    ? "vault/secrets/"
    : `vault/secrets/scoped/${scope}/`;
}

/** Parse a key relative to `secrets/` into its canonical catalog identity. */
export function parseSecretCatalogKey(
  key: string,
): ParsedSecretCatalogKey | undefined {
  if (SECRET_NAME_RE.test(key)) {
    return { name: key };
  }

  const parts = key.split("/");
  if (parts.length !== 3 || parts[0] !== "scoped") {
    return undefined;
  }

  const [, rawScope, name] = parts;
  if (!name || !SECRET_NAME_RE.test(name)) {
    return undefined;
  }

  try {
    const scope = canonicalizeSecretScope(rawScope);
    if (scope === undefined || scope !== rawScope) {
      return undefined;
    }
    return { name, scope };
  } catch {
    return undefined;
  }
}
