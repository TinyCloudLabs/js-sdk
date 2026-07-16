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
    // Omission is meaningful: the CLI's default is the literal `secrets`
    // space, while an explicitly supplied short name is resolved later against
    // the authenticated identity.
    ...(input.space === undefined ? {} : { space: reference.space }),
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

/**
 * Resolve the operation's explicit space against the authenticated identity.
 * Omitted input deliberately remains the literal `secrets` space for CLI
 * compatibility; operation authority canonicalization resolves that literal
 * to the same owner-exact identity when comparing grants.
 */
export function resolveSecretReferenceForOperation(
  input: SecretsGetInput,
  node: unknown,
  ownerSpace?: string,
): SecretReference {
  const reference = resolveSecretReference(input);
  if (input.space === undefined) return reference;
  return {
    ...reference,
    space: resolveOperationSpace(reference.space, node, ownerSpace),
  };
}

/** Creates the one owner-aware resolver shared by operation matching paths. */
export function operationSpaceResolver(
  node: unknown,
  ownerSpace?: string,
): (space: string) => string {
  return (space) => resolveOperationSpace(space, node, ownerSpace);
}

function resolveOperationSpace(space: string, node: unknown, ownerSpace?: string): string {
  if (space.startsWith("tinycloud:")) return canonicalizeSpaceUri(space);

  if (ownerSpace?.startsWith("tinycloud:")) {
    const owner = ownerSpace.slice("tinycloud:".length).split(":").slice(0, -1).join(":");
    if (owner.length > 0) return canonicalizeSpaceUri(`tinycloud:${owner}:${space}`);
  }

  const candidate = node as {
    resolveOwnedSpace?: (spaceName: string) => unknown;
    spaceId?: unknown;
    address?: unknown;
    did?: unknown;
  };
  try {
    const resolved = candidate.resolveOwnedSpace?.(space);
    if (typeof resolved === "string" && resolved.length > 0) {
      return canonicalizeSpaceUri(resolved);
    }
  } catch {
    // Continue to the identity-derived resolver below.
  }

  // A restored delegate session carries the owner's primary space even though
  // node.did is the delegate/session principal. This is the same owner
  // identity used by the CLI space resolver.
  if (typeof candidate.spaceId === "string" && candidate.spaceId.startsWith("tinycloud:")) {
    const owner = candidate.spaceId.slice("tinycloud:".length).split(":").slice(0, -1).join(":");
    if (owner.length > 0) return canonicalizeSpaceUri(`tinycloud:${owner}:${space}`);
  }

  const did = typeof candidate.did === "string" ? candidate.did : undefined;
  const didMatch = did?.match(/^did:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40})$/);
  const address = typeof candidate.address === "string" ? candidate.address : undefined;
  const resolvedAddress = address ?? didMatch?.[2];
  const chainId = didMatch?.[1];
  if (resolvedAddress === undefined || chainId === undefined) {
    throw invalidSecretInput();
  }
  return `tinycloud:pkh:eip155:${chainId}:${canonicalizeAddress(resolvedAddress)}:${space}`;
}

function canonicalizeSpaceUri(space: string): string {
  const parts = space.split(":");
  const name = parts.at(-1);
  if (parts.length < 3 || name === undefined || name === "") {
    throw invalidSecretInput();
  }
  const owner = parts.slice(1, -1).join(":").replace(
    /(eip155:\d+:)(0x[0-9a-fA-F]{40})/,
    (_match, prefix: string, address: string) => `${prefix}${canonicalizeAddress(address)}`,
  );
  return `tinycloud:${owner}:${name}`;
}

function canonicalizeAddress(address: string): string {
  const trimmed = address.trim();
  return trimmed.startsWith("0x")
    ? `0x${trimmed.slice(2).toLowerCase()}`
    : trimmed.toLowerCase();
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
