// Namespace-shaped so modules that bundle this one stay compatible with
// lightweight node-sdk test doubles.
import * as nodeSdk from "@tinycloud/node-sdk";

import { CLI_NAME } from "./cli-name.js";
import type { TinyCloudPosture } from "./contract.js";

/**
 * The one builder for Secret Manager links (TC-832 "Link"). Every
 * missing-secret path produces its `/request` link here, and `/app` links come
 * only from {@link buildSecretManagerUrl}. No parameter ever carries a value.
 */
export const SECRET_MANAGER_ORIGIN = "https://secrets.tinycloud.xyz";
export const SECRET_REQUEST_MAX_NAMES = 10;
export const SECRET_REQUEST_MAX_URL_LENGTH = 8192;

const OWNER_RE = /^did:pkh:eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/;
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const MAX_NAME_LENGTH = 64;
const SCOPE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SCOPE_LENGTH = 64;
const RESERVED_SCOPES: readonly string[] = ["default", "global", "scoped"];
const MAX_REQUESTER_LENGTH = 64;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const STATE_RE = /^[A-Za-z0-9._~-]{1,128}$/;
const MAX_RETURN_TO_LENGTH = 2048;
const RETURN_TO_ORIGINS: readonly string[] = ["https://feed.tinycloud.xyz"];
const RETURN_TO_PREVIEW = /^https:\/\/[a-z0-9-]+\.tinyfeed\.pages\.dev$/;
const PKH_SPACE_RE = /^tinycloud:pkh:eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40}):[^:]+$/;

export type SecretRequestInputErrorCode =
  | "INVALID_SECRET_NAME"
  | "TOO_MANY_SECRET_NAMES"
  | "INVALID_SECRET_SCOPE"
  | "INVALID_OWNER"
  | "INVALID_REQUESTER"
  | "INVALID_RETURN_TO"
  | "INVALID_STATE"
  | "REQUEST_LINK_TOO_LONG";

export class SecretRequestInputError extends Error {
  readonly code: SecretRequestInputErrorCode;

  constructor(code: SecretRequestInputErrorCode, message: string) {
    super(message);
    this.name = "SecretRequestInputError";
    this.code = code;
  }
}

/**
 * TC-832 owner rule: `did:pkh:eip155:<chain>:<address>` with a safe-integer
 * chain and a lowercase `0x`. An address with any uppercase letter must
 * already be its EIP-55 form. Returns the DID with the EIP-55 address.
 */
export function canonicalSecretRequestOwner(did: string): string {
  const match = typeof did === "string" ? OWNER_RE.exec(did) : null;
  if (match === null || !Number.isSafeInteger(Number(match[1]))) throw invalidOwner();
  const address = match[2]!;
  let checksummed: string;
  try {
    checksummed = nodeSdk.canonicalizeAddress(address);
  } catch {
    throw invalidOwner();
  }
  if (/[A-F]/.test(address.slice(2)) && address !== checksummed) throw invalidOwner();
  return `did:pkh:eip155:${match[1]}:${checksummed}`;
}

export interface SecretRequestLinkInput {
  readonly owner: string;
  readonly names: readonly string[];
  readonly scope?: string;
  readonly requester?: string;
  readonly returnTo?: string;
  readonly state?: string;
}

export interface SecretRequestLink {
  readonly url: string;
  readonly owner: string;
  readonly names: string[];
  readonly scope?: string;
}

/** Builds the canonical `/request` link, or throws {@link SecretRequestInputError}. */
export function buildSecretRequestUrl(input: SecretRequestLinkInput): SecretRequestLink {
  const owner = canonicalSecretRequestOwner(input.owner);
  const names = validSecretNames(input.names);
  if (input.scope !== undefined) assertSecretRequestScope(input.scope);
  const requester = input.requester;
  if (
    requester !== undefined &&
    (typeof requester !== "string" || requester.length === 0 || requester.length > MAX_REQUESTER_LENGTH ||
      CONTROL_OR_FORMAT.test(requester))
  ) {
    throw new SecretRequestInputError("INVALID_REQUESTER", "The requester label must be 1-64 characters with no control or format characters.");
  }
  if (input.returnTo !== undefined && !isAllowedReturnTo(input.returnTo)) {
    throw new SecretRequestInputError("INVALID_RETURN_TO", "The return address is not an allowed Secret Manager callback.");
  }
  if (input.state !== undefined && !STATE_RE.test(input.state)) {
    throw new SecretRequestInputError("INVALID_STATE", "The state must be 1-128 characters of A-Z, a-z, 0-9, '.', '_', '~' or '-'.");
  }

  const parameters: [string, string][] = [
    ["owner", owner],
    ...names.map((name): [string, string] => ["name", name]),
    ...(input.scope === undefined ? [] : [["scope", input.scope] as [string, string]]),
    ...(input.requester === undefined ? [] : [["requester", input.requester] as [string, string]]),
    ...(input.returnTo === undefined ? [] : [["return_to", input.returnTo] as [string, string]]),
    ...(input.state === undefined ? [] : [["state", input.state] as [string, string]]),
    ["v", "1"],
  ];
  const url = `${SECRET_MANAGER_ORIGIN}/request?${parameters
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&")}`;
  if (url.length > SECRET_REQUEST_MAX_URL_LENGTH) {
    throw new SecretRequestInputError("REQUEST_LINK_TOO_LONG", `The request link is longer than ${SECRET_REQUEST_MAX_URL_LENGTH} characters.`);
  }
  return { url, owner, names, ...(input.scope === undefined ? {} : { scope: input.scope }) };
}

/** The value-free setup a missing secret reports: exactly these keys. */
export interface SecretSetup {
  readonly url: string;
  readonly names: string[];
  readonly scope?: string;
  readonly owner: string;
  readonly action: "add_secret";
}

export function secretSetupFor(link: SecretRequestLink): SecretSetup {
  return {
    url: link.url,
    names: [...link.names],
    ...(link.scope === undefined ? {} : { scope: link.scope }),
    owner: link.owner,
    action: "add_secret",
  };
}

/**
 * The full manager (`/app`), the only path that replaces an existing value:
 * bare, `?secret=N`, or `?secrets=A,B`, plus `&scope=`. Names follow the link
 * name rule without the request cap.
 */
export function buildSecretManagerUrl(input: { readonly names?: readonly string[]; readonly scope?: string } = {}): string {
  const names = dedupe(input.names ?? []);
  for (const name of names) assertSecretName(name);
  if (input.scope !== undefined) assertSecretRequestScope(input.scope);
  const parameters: [string, string][] = [
    ...(names.length === 1 ? [["secret", names[0]!] as [string, string]] : []),
    ...(names.length > 1 ? [["secrets", names.join(",")] as [string, string]] : []),
    ...(input.scope === undefined ? [] : [["scope", input.scope] as [string, string]]),
  ];
  const query = parameters.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `${SECRET_MANAGER_ORIGIN}/app${query === "" ? "" : `?${query}`}`;
}

export type SecretsOwnerResolution =
  | { readonly ok: true; readonly owner: string; readonly local: boolean }
  | { readonly ok: false; readonly code: "OWNER_DID_UNKNOWN" | "OWNER_MISMATCH"; readonly message: string };

/**
 * The owner whose secrets an identity reads, first match wins: a local key's
 * own account, the recorded owner, a delegate session's space owner, a pkh
 * principal, then the requested owner. A requested owner that disagrees with a
 * resolved one is `OWNER_MISMATCH`.
 */
export function resolveSecretsOwner(
  profile: {
    readonly local: boolean;
    readonly posture: TinyCloudPosture;
    readonly ownerDid?: string;
    readonly principalDid?: string;
    readonly space?: string;
  },
  requestedOwner?: string,
): SecretsOwnerResolution {
  const resolved = profile.local
    ? ownerOrUndefined(profile.principalDid)
    : ownerOrUndefined(profile.ownerDid) ??
      (profile.posture === "delegate-session" ? ownerOfSpace(profile.space) : undefined) ??
      ownerOrUndefined(profile.principalDid);
  const requested = requestedOwner === undefined ? undefined : ownerOrUndefined(requestedOwner);

  if (resolved !== undefined) {
    if (requestedOwner !== undefined && requested !== resolved) {
      return {
        ok: false,
        code: "OWNER_MISMATCH",
        message: "The requested owner is not the owner of this identity's secrets.",
      };
    }
    return { ok: true, owner: resolved, local: profile.local };
  }
  if (requested !== undefined && !profile.local) return { ok: true, owner: requested, local: false };
  return {
    ok: false,
    code: "OWNER_DID_UNKNOWN",
    message: "The owner of this identity's secrets is unknown. Pass the owner's did:pkh with --owner.",
  };
}

export type MissingSecretRecovery =
  | { readonly kind: "add_secret"; readonly setup: SecretSetup }
  | { readonly kind: "put_locally"; readonly hint: string }
  | { readonly kind: "not_requestable"; readonly hint: string };

/**
 * How a caller gets missing secrets: a local identity stores them itself; any
 * other identity gets a `/request` link when one can express the request.
 * Never throws.
 */
export function missingSecretRecovery(input: {
  readonly owner: string | undefined;
  readonly local: boolean;
  readonly names: readonly string[];
  readonly scope?: string;
}): MissingSecretRecovery {
  if (input.local) {
    return { kind: "put_locally", hint: `Store it with: ${putCommands(input.names, input.scope)}` };
  }
  if (input.owner !== undefined) {
    try {
      return {
        kind: "add_secret",
        setup: secretSetupFor(buildSecretRequestUrl({
          owner: input.owner,
          names: input.names,
          ...(input.scope === undefined ? {} : { scope: input.scope }),
        })),
      };
    } catch {
      // A legacy name or scope, or an unusable owner, cannot be requested.
    }
  }
  return {
    kind: "not_requestable",
    hint: `No Secret Manager request link can express this secret. The owner can store it with: ${putCommands(input.names, input.scope)}`,
  };
}

/**
 * The strict policy for a consent denial's `request_access` recovery: exact
 * keys, denied names only, a canonical owner and a valid scope. Any deviation
 * rejects the whole value.
 */
export function isSafeRequestAccessRecovery(
  value: unknown,
  deniedNames: readonly string[],
): value is { action: "request_access"; names: string[]; owner: string; scope?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.every((key) => key === "action" || key === "names" || key === "owner" || key === "scope")) return false;
  if (record.action !== "request_access") return false;
  const names = record.names;
  if (
    !Array.isArray(names) || names.length === 0 || names.length > SECRET_REQUEST_MAX_NAMES ||
    new Set(names).size !== names.length ||
    !names.every((name) => typeof name === "string" && isValidSecretName(name) && deniedNames.includes(name))
  ) {
    return false;
  }
  if (typeof record.owner !== "string" || ownerOrUndefined(record.owner) !== record.owner) return false;
  if ("scope" in record && (typeof record.scope !== "string" || !isValidSecretRequestScope(record.scope))) return false;
  return true;
}

/** TC-832 scope rule: canonical grammar, at most 64, not reserved. Never canonicalizes. */
export function isValidSecretRequestScope(scope: string): boolean {
  return scope.length <= MAX_SCOPE_LENGTH && SCOPE_RE.test(scope) && !RESERVED_SCOPES.includes(scope);
}

/** TC-832 name rule: `^[A-Z][A-Z0-9_]*$`, at most 64, no trimming. */
export function isValidSecretName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && NAME_RE.test(name);
}

/** Validated, de-duplicated (order kept) names, 1-10 of them. */
export function validSecretNames(names: readonly string[]): string[] {
  for (const name of names) assertSecretName(name);
  const unique = dedupe(names);
  if (unique.length === 0) {
    throw new SecretRequestInputError("INVALID_SECRET_NAME", "At least one secret name is required.");
  }
  if (unique.length > SECRET_REQUEST_MAX_NAMES) {
    throw new SecretRequestInputError("TOO_MANY_SECRET_NAMES", `At most ${SECRET_REQUEST_MAX_NAMES} secret names can be requested at once.`);
  }
  return unique;
}

function assertSecretName(name: string): void {
  if (typeof name !== "string" || !isValidSecretName(name)) {
    throw new SecretRequestInputError("INVALID_SECRET_NAME", "Secret names are 1-64 characters of A-Z, 0-9 and '_', starting with a letter.");
  }
}

function assertSecretRequestScope(scope: string): void {
  if (typeof scope !== "string" || !isValidSecretRequestScope(scope)) {
    throw new SecretRequestInputError("INVALID_SECRET_SCOPE", "The scope must be a canonical scope of at most 64 characters, not default, global or scoped.");
  }
}

function isAllowedReturnTo(returnTo: string): boolean {
  if (typeof returnTo !== "string" || returnTo.length > MAX_RETURN_TO_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  return RETURN_TO_ORIGINS.includes(url.origin) || RETURN_TO_PREVIEW.test(url.origin);
}

function ownerOrUndefined(did: string | undefined): string | undefined {
  if (did === undefined) return undefined;
  try {
    return canonicalSecretRequestOwner(did);
  } catch {
    return undefined;
  }
}

/** The canonical owner DID of a `tinycloud:pkh:eip155:…` space, or `undefined` for any other space. */
export function ownerOfSpace(space: string | undefined): string | undefined {
  const match = space === undefined ? null : PKH_SPACE_RE.exec(space);
  if (match === null) return undefined;
  // Space URIs carry the address in any case; the owner is its EIP-55 form.
  return ownerOrUndefined(`did:pkh:eip155:${match[1]}:${match[2]!.toLowerCase()}`);
}

function putCommands(names: readonly string[], scope: string | undefined): string {
  return dedupe(names)
    .map((name) => `${CLI_NAME} secrets put ${name}${scope === undefined ? "" : ` --scope ${scope}`} --stdin`)
    .join("; ");
}

function dedupe(names: readonly string[]): string[] {
  return [...new Set(names)];
}

function invalidOwner(): SecretRequestInputError {
  return new SecretRequestInputError("INVALID_OWNER", "The owner must be a did:pkh:eip155 account with a valid EIP-55 address.");
}
