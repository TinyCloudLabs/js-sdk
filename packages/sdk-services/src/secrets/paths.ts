export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

const SECRET_PREFIX = "secrets/";
const SCOPED_SECRET_PREFIX = "secrets/scoped/";
const RESERVED_SECRET_SCOPES = new Set(["default", "global"]);

export interface SecretScopeOptions {
  /** Optional logical scope. Omit for the global secret namespace. */
  scope?: string;
}

export interface ResolvedSecretPath {
  /** Canonical env-style secret name. */
  name: string;
  /** Canonical scope. Undefined means global. */
  scope?: string;
  /** Key passed to the data vault service. */
  vaultKey: string;
  /** KV permission paths that back the encrypted vault entry. */
  permissionPaths: {
    keys: string;
    vault: string;
  };
}

export function canonicalizeSecretScope(scope: string | undefined): string | undefined {
  if (scope === undefined) {
    return undefined;
  }

  const trimmed = scope.trim();
  if (trimmed === "") {
    throw new Error("Secret scope must be non-empty; omit scope for global secrets.");
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
  const vaultKey = scope === undefined
    ? `${SECRET_PREFIX}${normalizedName}`
    : `${SCOPED_SECRET_PREFIX}${scope}/${normalizedName}`;

  return {
    name: normalizedName,
    ...(scope !== undefined ? { scope } : {}),
    vaultKey,
    permissionPaths: {
      keys: `keys/${vaultKey}`,
      vault: `vault/${vaultKey}`,
    },
  };
}
