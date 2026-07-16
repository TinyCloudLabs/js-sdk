import { OperationInvocationError, operationError } from "./errors.js";

const DEFAULT_SECRETS_SPACE = "secrets";
const SECRET_MANAGER_BASE_URL = "https://secrets.tinycloud.xyz";
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_SECRET_SCOPES = new Set(["default", "global"]);

export interface SecretsGetInput {
  readonly name: string;
  readonly scope?: string;
  readonly space?: string;
}

export interface SecretReference {
  readonly name: string;
  readonly scope?: string;
  readonly space: string;
  readonly vaultKey: string;
  readonly permissionPath: string;
}

export function normalizeSecretsGetInput(
  input: SecretsGetInput,
): SecretsGetInput {
  const reference = resolveSecretReference(input);
  return {
    name: reference.name,
    ...(reference.scope === undefined ? {} : { scope: reference.scope }),
    ...(reference.space === DEFAULT_SECRETS_SPACE ? {} : { space: reference.space }),
  };
}

/** Resolves the one canonical backing key/path used by planning and setup. */
export function resolveSecretReference(
  input: SecretsGetInput,
): SecretReference {
  const name = input.name.trim();
  if (!SECRET_NAME_RE.test(name)) {
    throw invalidSecretInput();
  }

  const scope = canonicalizeSecretScope(input.scope);
  const space = normalizeSecretsSpace(input.space);
  const vaultKey = scope === undefined
    ? `secrets/${name}`
    : `secrets/scoped/${scope}/${name}`;

  return {
    name,
    ...(scope === undefined ? {} : { scope }),
    space,
    vaultKey,
    permissionPath: `vault/${vaultKey}`,
  };
}

/** Builds a setup action URL without ever accepting a secret value. */
export function buildSecretSetupUrl(reference: SecretReference): string {
  const parameters = [
    ["name", reference.name],
    ...(reference.scope === undefined ? [] : [["scope", reference.scope] as const]),
    ["space", reference.space],
  ] as const;
  const query = parameters
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${SECRET_MANAGER_BASE_URL}?${query}`;
}

function canonicalizeSecretScope(scope: string | undefined): string | undefined {
  if (scope === undefined || scope === "") return undefined;

  const trimmed = scope.trim();
  if (trimmed === "") throw invalidSecretInput();

  const canonical = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (canonical === "" || RESERVED_SECRET_SCOPES.has(canonical)) {
    throw invalidSecretInput();
  }
  return canonical;
}

function normalizeSecretsSpace(space: string | undefined): string {
  if (space === undefined || space === "") return DEFAULT_SECRETS_SPACE;

  if (space.startsWith("tinycloud:")) {
    const parts = space.split(":");
    if (parts.length < 3 || parts.at(-1) === undefined || parts.at(-1) === "") {
      throw invalidSecretInput();
    }
    return `tinycloud:${parts.slice(1, -1).join(":")}:${parts.at(-1)}`;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(space)) throw invalidSecretInput();
  return space;
}

function invalidSecretInput(): OperationInvocationError {
  return new OperationInvocationError(
    operationError("INPUT_INVALID", "The secret reference is invalid."),
  );
}
