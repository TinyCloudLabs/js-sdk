import {
  canonicalizeAddress,
  makePkhSpaceId,
  parsePkhDid,
  parseSpaceUri,
} from "@tinycloud/node-sdk";

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
 * Resolve the operation's space against the authenticated identity. The
 * public short-name contract remains `secrets`, while an authenticated
 * operation uses its owner-exact URI for the actual read boundary.
 */
export function resolveSecretReferenceForOperation(
  input: SecretsGetInput,
  node: unknown,
  ownerSpace?: string,
): SecretReference {
  const reference = resolveSecretReference(input);
  if (input.space === undefined && ownerSpace === undefined) return reference;
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

  const ownerSpaceId = ownerSpace === undefined ? undefined : ownedSpaceForName(ownerSpace, space);
  if (ownerSpaceId !== undefined) return ownerSpaceId;

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
  if (typeof candidate.spaceId === "string") {
    const resolved = ownedSpaceForName(candidate.spaceId, space);
    if (resolved !== undefined) return resolved;
  }

  const did = typeof candidate.did === "string" ? candidate.did : undefined;
  const pkh = did === undefined ? null : parsePkhDid(did);
  if (pkh === null) {
    throw invalidSecretInput();
  }
  return makePkhSpaceId(pkh.address, pkh.chainId, space);
}

function ownedSpaceForName(ownerSpace: string, name: string): string | undefined {
  const parsed = parseSpaceUri(ownerSpace);
  if (parsed === null) return undefined;
  try {
    const pkh = parsePkhDid(parsed.owner);
    return pkh === null ? undefined : makePkhSpaceId(pkh.address, pkh.chainId, name);
  } catch {
    return undefined;
  }
}

function canonicalizeSpaceUri(space: string): string {
  const parts = space.split(":");
  const name = parts.at(-1);
  if (parts.length < 3 || name === undefined || name === "") {
    throw invalidSecretInput();
  }
  // EIP-155 address casing is interchangeable only in the repository's
  // anchored PKH space form. Other TinyCloud space/DID syntaxes are opaque
  // method-specific identifiers and must remain byte-for-byte unchanged.
  const pkh = space.match(
    /^tinycloud:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40}):([^:]+)$/,
  );
  if (pkh !== null) {
    return `tinycloud:pkh:eip155:${pkh[1]}:${canonicalizeAddress(pkh[2]!).toLowerCase()}:${pkh[3]}`;
  }
  return space;
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
