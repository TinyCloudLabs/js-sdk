import { ErrorCodes, err, type Result, type ServiceError } from "../types";
import type { SecretType } from "./secretTypes";

/** Longest secret name: one key-path segment on the node, 64 bytes (TC-3801). */
export const MAX_SECRET_NAME_LENGTH = 64;

/** Secret names; at most {@link MAX_SECRET_NAME_LENGTH} characters. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

const SECRET_PREFIX = "secrets/";
const SCOPED_SECRET_PREFIX = "secrets/scoped/";
/** The one unscoped name whose key (`secrets/scoped`) is the parent of the scoped keys. */
const RESERVED_SECRET_NAME = "SCOPED";
const BOT_HISTORY_SCOPE = "tinychat-bot-history";
const RESERVED_SECRET_SCOPES = new Set(["default", "global", BOT_HISTORY_SCOPE]);

export interface SecretScopeOptions {
  /** Optional logical scope. Omit for the global secret namespace. */
  scope?: string;
  /** Bypass replication for existence-sensitive reads. */
  source?: "network";
}

/** Canonical secret scope grammar shared with the TC-832 `/request` link. */
export const SECRET_SCOPE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Longest scope: the TC-832 `/request` link's limit and one key-path segment on the node. */
export const MAX_SECRET_SCOPE_LENGTH = 64;

/** Scopes the TC-832 `/request` link refuses. */
export const TC832_RESERVED_SCOPES: readonly string[] = Object.freeze([
  "default",
  "global",
  "scoped",
  BOT_HISTORY_SCOPE,
]);

export interface SecretPutOptions extends SecretScopeOptions {
  /** Seal to this secret's own key. The default seals to the network key. */
  namedKey?: boolean;
  /** Write only when no secret exists under this name; never overwrite. */
  ifAbsent?: boolean;
  /**
   * What the secret is. Stored inside the encrypted payload. `secret` (the
   * default) is not stored: a payload with no type already means `secret`.
   */
  type?: SecretType;
}

/** Options for reading one secret. */
export interface SecretGetOptions extends SecretScopeOptions {
  /**
   * Open only a copy sealed to the secret's own key. A copy still sealed to
   * the network key is `LEGACY_ENVELOPE`, never opened through the network.
   */
  namedKeyOnly?: boolean;
  /**
   * Ask for missing read authority, which may prompt the wallet to sign.
   * Only for a read the user started. Without it a read never asks: a missing
   * grant for the secret's own key is `DECRYPT_DENIED` with `permissionHint`.
   */
  requestPermission?: boolean;
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
  /** Named key the secret is sealed to ({@link secretKeyPath}). */
  keyPath: string;
}

/**
 * The named key a secret is sealed to (TC-3284): `secrets/<lower(NAME)>`, or
 * `secrets/scoped/<scope>/<lower(NAME)>`. Lowercasing a `SECRET_NAME_RE` name
 * is injective. The scope must already be canonical (`SECRET_SCOPE_RE`); it is
 * never normalised. Throws for a name or scope over 64 bytes, the reserved
 * bot-history scope, and the unscoped name `SCOPED`, the parent of scoped keys.
 */
export function secretKeyPath(name: string, scope?: string): string {
  if (!SECRET_NAME_RE.test(name) ||
      (scope !== undefined && (!SECRET_SCOPE_RE.test(scope) || scope.length > MAX_SECRET_SCOPE_LENGTH))) {
    throw new Error("A secret's key needs a name and scope of at most 64 bytes, scope in canonical form");
  }
  if (scope === undefined && name === RESERVED_SECRET_NAME) {
    throw new Error(`Secret name ${JSON.stringify(name)} is reserved.`);
  }
  if (scope === BOT_HISTORY_SCOPE) {
    throw new Error(`Secret scope ${JSON.stringify(scope)} is reserved.`);
  }
  return `${scope === undefined ? SECRET_PREFIX : `${SCOPED_SECRET_PREFIX}${scope}/`}${name.toLowerCase()}`;
}

/** The secret whose key `path` is, exactly as `secretKeyPath` derives it; `undefined` for any other path. */
export function parseSecretKeyPath(path: string): { name: string; scope?: string } | undefined {
  const match = /^secrets\/(?:scoped\/([^/]+)\/)?([^/]+)$/.exec(path);
  const name = match?.[2]!.toUpperCase();
  try {
    return name !== undefined && secretKeyPath(name, match![1]) === path
      ? { name, ...(match![1] === undefined ? {} : { scope: match![1] }) }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The seeded key reserved for TinyChat bot history, not a secret record. */
export const BOT_HISTORY_KEY_PATH = `${SCOPED_SECRET_PREFIX}${BOT_HISTORY_SCOPE}/bot-history`;

export function isReservedSecretSpaceKeyPath(path: string): boolean {
  return path === BOT_HISTORY_KEY_PATH;
}

/**
 * The two permissions that read exactly one secret (TC-3284): `kv/get` on its
 * vault record and `decrypt` on its own key, never the network. `networkId`
 * is the owner's network (`urn:tinycloud:encryption:<owner>:default`);
 * `space` defaults to `secrets`. Throws for a secret that has no key.
 */
export function secretReadPermissions(
  networkId: string,
  name: string,
  options: { scope?: string; space?: string } = {},
): [
  { service: "tinycloud.kv"; space: string; path: string; actions: ["tinycloud.kv/get"]; skipPrefix: true },
  { service: "tinycloud.encryption"; path: string; actions: ["tinycloud.encryption/decrypt"] },
] {
  const resolved = resolveSecretPath(name, options);
  return [
    { service: "tinycloud.kv", space: options.space ?? "secrets", path: resolved.permissionPaths.vault, actions: ["tinycloud.kv/get"], skipPrefix: true },
    { service: "tinycloud.encryption", path: `${networkId}/${secretKeyPath(resolved.name, resolved.scope)}`, actions: ["tinycloud.encryption/decrypt"] },
  ];
}

export interface ParsedSecretCatalogKey {
  name: string;
  scope?: string;
  /** Set when the name is over {@link MAX_SECRET_NAME_LENGTH}: listed, but `get`, `put` and `delete` refuse it. */
  nameTooLong?: true;
  /** Set when the scope is over {@link MAX_SECRET_SCOPE_LENGTH}: listed under its stored scope, but `get`, `put` and `delete` refuse it. */
  scopeTooLong?: true;
}

const STORED_SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** A name as it may already be stored: the secret-name grammar without the length limit. */
export function isStoredSecretName(name: string): boolean {
  return STORED_SECRET_NAME_RE.test(name);
}

/** A scope in canonical form that is over {@link MAX_SECRET_SCOPE_LENGTH}: one that may already be stored, and that nothing can write or read. */
export function isStoredTooLongScope(scope: string): boolean {
  return scope.length > MAX_SECRET_SCOPE_LENGTH && SECRET_SCOPE_RE.test(scope);
}

function tooLongFlag(name: string): { nameTooLong?: true } {
  return name.length > MAX_SECRET_NAME_LENGTH ? { nameTooLong: true } : {};
}

/** The words a person sees when a `put` names a secret longer than {@link MAX_SECRET_NAME_LENGTH}. `length` is the name's length. */
export function secretNameTooLongMessage(length: number): string {
  return `This secret wasn't saved: its name is ${length} characters, and names can be at most ${MAX_SECRET_NAME_LENGTH}. Choose a shorter name.`;
}

/**
 * A `put` of a name that fails only on length is refused before any permission request or write; `undefined` for any
 * other name (a name that also fails the pattern keeps the pattern's own message).
 */
export function secretNameTooLongRefusal(name: string): Result<never, ServiceError> | undefined {
  const trimmed = name.trim();
  const length = trimmed.length;
  if (length <= MAX_SECRET_NAME_LENGTH || !isStoredSecretName(trimmed)) return undefined;
  return err({ code: ErrorCodes.INVALID_INPUT, service: "secrets", message: secretNameTooLongMessage(length) });
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
  if (canonical.length > MAX_SECRET_SCOPE_LENGTH) {
    throw new Error(
      `Secret scope ${JSON.stringify(canonical)} is longer than ${MAX_SECRET_SCOPE_LENGTH} characters.`,
    );
  }

  return canonical;
}

export function resolveSecretPath(
  name: string,
  options: SecretScopeOptions = {},
): ResolvedSecretPath {
  const normalizedName = name.trim();
  // The node's key segment limit: a longer name has no key of its own (TC-3801).
  if (normalizedName.length > MAX_SECRET_NAME_LENGTH) {
    throw new Error(
      `Secret name ${JSON.stringify(normalizedName)} is longer than ${MAX_SECRET_NAME_LENGTH} characters.`,
    );
  }
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
    keyPath: secretKeyPath(normalizedName, scope),
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
  return parseCatalogKey(key, SECRET_NAME_RE);
}

/**
 * {@link parseSecretCatalogKey} for listing what is stored: a name over {@link MAX_SECRET_NAME_LENGTH} or a scope over
 * {@link MAX_SECRET_SCOPE_LENGTH} (stored before the limits) comes back with `nameTooLong` / `scopeTooLong` instead of
 * being hidden; the scope is the raw stored one. It has no key of its own, and no path here resolves one for it.
 */
export function parseStoredSecretCatalogKey(
  key: string,
): ParsedSecretCatalogKey | undefined {
  const parsed = parseCatalogKey(key, STORED_SECRET_NAME_RE, true);
  return parsed && { ...parsed, ...tooLongFlag(parsed.name) };
}

function parseCatalogKey(
  key: string,
  nameRe: RegExp,
  storedScopes = false,
): ParsedSecretCatalogKey | undefined {
  if (nameRe.test(key)) {
    return { name: key };
  }

  const parts = key.split("/");
  if (parts.length !== 3 || parts[0] !== "scoped") {
    return undefined;
  }

  const [, rawScope, name] = parts;
  if (!name || !nameRe.test(name)) {
    return undefined;
  }

  if (storedScopes && rawScope && isStoredTooLongScope(rawScope)) {
    return { name, scope: rawScope, scopeTooLong: true };
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
