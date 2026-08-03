import { sha256 } from "@noble/hashes/sha256";
import { blake3 } from "@noble/hashes/blake3";
import { ed25519 } from "@noble/curves/ed25519";
import { CID } from "multiformats/cid";
import { base58btc } from "multiformats/bases/base58";
import { create as createDigest } from "multiformats/hashes/digest";
import { z } from "zod";
import { jcsCanonicalize } from "./jcs";

export const POLICY_V1_SCHEMA = "xyz.tinycloud.policy/policy/v1" as const;
export const POLICY_CAPABILITY_V1_SCHEMA =
  "xyz.tinycloud.policy/capability/v1" as const;
export const POLICY_ENFORCEMENT_DELEGATION_V2_SCHEMA =
  "xyz.tinycloud.policy/enforcement-delegation/v2" as const;
export const ATTESTED_ENFORCER_BINDING_V2_SCHEMA =
  "xyz.tinycloud.policy/attested-enforcer/v2" as const;
export const ROOT_STATUS_CHECKPOINT_V1_SCHEMA =
  "xyz.tinycloud.policy/root-status/v1" as const;
export const ROOT_REVOCATION_V1_SCHEMA =
  "xyz.tinycloud.policy/root-revocation/v1" as const;
export const POLICY_SESSION_UCAN_V1_PROFILE = "policy-session-ucan/v1" as const;

export const POLICY_V1_DOMAIN = "xyz.tinycloud.policy/policy/v1\0";
export const POLICY_CAPABILITY_V1_DOMAIN =
  "xyz.tinycloud.policy/PolicyCapability/v1\0";
export const CONTENT_SOURCE_V1_DOMAIN =
  "xyz.tinycloud.policy/ContentSource/v1\0";
export const NATIVE_PROJECTION_V1_DOMAIN =
  "xyz.tinycloud.policy/NativeProjection/v1\0";
export const ROOT_STATUS_V1_DOMAIN =
  "xyz.tinycloud.policy/RootStatusCheckpoint/v1\0";
export const ROOT_STATUS_RENEWAL_V1_DOMAIN =
  "xyz.tinycloud.policy/RootStatusRenewal/v1\0";
export const ROOT_REVOCATION_V1_DOMAIN =
  "xyz.tinycloud.policy/RootRevocation/v1\0";

export const LAST_V2_CREATE_AT = "2026-09-30T00:00:00Z" as const;
export const MAX_LEGACY_ENVELOPE_EXPIRES_AT = "2026-12-29T00:00:00Z" as const;
export const LAST_V2_READ_AT = "2027-01-05T00:00:00Z" as const;

export type UnifiedResourceSelector = "exact" | "prefix";

export interface UnifiedKvCapability {
  readonly kind: "kv";
  readonly resource: string;
  readonly selector: UnifiedResourceSelector;
  readonly actions: readonly (
    | "tinycloud.kv/get"
    | "tinycloud.kv/list"
    | "tinycloud.kv/metadata"
    | "tinycloud.kv/put"
  )[];
}

export interface UnifiedEncryptionCapability {
  readonly kind: "encryption";
  readonly resource: string;
  readonly action: "tinycloud.encryption/decrypt";
}

export type UnifiedPolicyCapability =
  | UnifiedKvCapability
  | UnifiedEncryptionCapability;

export interface UnifiedNativeCapability {
  readonly service: "tinycloud.kv" | "tinycloud.encryption";
  readonly space: string;
  readonly path: string;
  readonly actions: readonly string[];
  readonly caveat?: Readonly<Record<string, string>>;
}

export interface UnifiedContentSource {
  readonly shareId: string;
  readonly kvResource: string;
  readonly selector: UnifiedResourceSelector;
  readonly encryptionNetwork: string;
  readonly encryptedSymmetricKeyDigestHex: string;
  readonly keyVersion: number;
  readonly mode: "mutable" | "immutable";
  readonly initialCiphertextDigestHex?: string;
}

export interface UnifiedPolicyV1 {
  readonly schema: typeof POLICY_V1_SCHEMA;
  readonly policyId: string;
  readonly ownerDid: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly contentSource: UnifiedContentSource;
  readonly capabilityCeiling: readonly UnifiedPolicyCapability[];
  readonly signature: {
    readonly suite: string;
    readonly signerDid: string;
    readonly value: string;
  };
}

export interface PolicySessionUcanV1 {
  readonly authorization: string;
  readonly cid: string;
  readonly iss: string;
  readonly aud: string;
  readonly prf: readonly [string, string];
  readonly att: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>>;
  readonly nbf: number;
  readonly exp: number;
  readonly nnc: string;
  readonly fact: Readonly<Record<string, unknown>>;
}

export interface PolicyChallengeV3 {
  readonly challengeId: string;
  readonly nonce: string;
  readonly policyCid: string;
  readonly recipientDid: string;
  readonly [key: string]: unknown;
}

export async function requestPolicyChallengeV3(input: {
  readonly nodeOrigin: string;
  readonly policyCid: string;
  readonly recipientDid: string;
  readonly requestedCapabilities: readonly UnifiedPolicyCapability[];
  readonly fetch?: typeof fetch;
}): Promise<PolicyChallengeV3> {
  const fetchFn = input.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchFn(new URL("/share/v3/policy/challenges", input.nodeOrigin), {
    method: "POST",
    redirect: "error",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ policyCid: input.policyCid, recipientDid: input.recipientDid, requestedCapabilities: input.requestedCapabilities.map(normalizeUnifiedPolicyCapability) }),
  });
  if (!response.ok) throw new Error(`policy challenge rejected (${response.status})`);
  const value = object(await response.json(), "policy challenge") as PolicyChallengeV3;
  if (typeof value.challengeId !== "string" || typeof value.nonce !== "string" || value.policyCid !== input.policyCid || value.recipientDid !== input.recipientDid)
    throw new Error("policy challenge binding is invalid");
  return value;
}

export async function mintPolicySessionV3(input: {
  readonly nodeOrigin: string;
  readonly policyCid: string;
  readonly policyRootCid: string;
  readonly enforcementRootCid: string;
  readonly recipientDid: string;
  readonly requestedCapabilities: readonly UnifiedPolicyCapability[];
  readonly expectedFacts?: Readonly<Record<string, string | number>>;
  readonly claim: Readonly<Record<string, unknown>>;
  readonly presentation: Readonly<Record<string, unknown>>;
  readonly challenge?: PolicyChallengeV3;
  readonly fetch?: typeof fetch;
}): Promise<PolicySessionUcanV1> {
  const fetchFn = input.fetch ?? globalThis.fetch.bind(globalThis);
  const challenge = input.challenge ?? await requestPolicyChallengeV3(input);
  if (challenge.policyCid !== input.policyCid || challenge.recipientDid !== input.recipientDid)
    throw new Error("policy challenge binding is invalid");
  const response = await fetchFn(new URL("/share/v3/policy/delegations", input.nodeOrigin), {
    method: "POST",
    redirect: "error",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ policyCid: input.policyCid, challengeId: challenge.challengeId, nonce: challenge.nonce, claim: input.claim, presentation: input.presentation }),
  });
  if (!response.ok) throw new Error(`policy delegation rejected (${response.status})`);
  const value = object(await response.json(), "policy delegation");
  if (value.admitted !== true || typeof value.sessionCid !== "string" || typeof value.authorization !== "string")
    throw new Error("policy delegation response is invalid");
  const session = parsePolicySessionUcan(value.authorization, [input.policyRootCid, input.enforcementRootCid]);
  const expectedAttenuation = compactAttenuationForPolicyCapabilities(input.requestedCapabilities);
  if (session.cid !== value.sessionCid
    || session.aud !== input.recipientDid
    || session.fact.policyCid !== input.policyCid
    || session.fact.recipientDid !== input.recipientDid
    || session.fact.policyDelegationCid !== input.policyRootCid
    || session.fact.enforcementDelegationCid !== input.enforcementRootCid
    || jcsCanonicalize(session.att) !== jcsCanonicalize(expectedAttenuation)
    || Object.entries(input.expectedFacts ?? {}).some(([key, expected]) => session.fact[key] !== expected))
    throw new Error("policy delegation signed binding is invalid");
  return session;
}

function compactAttenuationForPolicyCapabilities(
  input: readonly UnifiedPolicyCapability[],
): Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>> {
  const attenuation: Record<string, Record<string, readonly unknown[]>> = {};
  for (const raw of input) {
    const capability = normalizeUnifiedPolicyCapability(raw);
    if (attenuation[capability.resource] !== undefined)
      throw new Error("policy capabilities contain a duplicate resource");
    attenuation[capability.resource] = capability.kind === "encryption"
      ? { [capability.action]: [{}] }
      : Object.fromEntries(capability.actions.map((action) => [action, [{
          type: "xyz.tinycloud.resource/selector",
          kind: capability.selector,
          value: capability.resource,
        }]]));
  }
  return attenuation;
}

export interface PolicyRootStatusV3 {
  readonly rootCid: string;
  readonly state: "active" | "revoked";
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly revocation?: Readonly<Record<string, unknown>>;
}

export function verifyPolicyRootStatusCheckpointV3(input: {
  readonly rootCid: string;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly expectedNodeAudience?: string;
  readonly now?: Date;
}): boolean {
  const checkpoint = input.checkpoint;
  const allowed = new Set(["schema", "targetCid", "targetRole", "ownerDid", "nodeAudience", "state", "sequence", "checkedAt", "freshUntil", "revokedAt", "revocationCid", "previousCheckpointDigestHex", "issuerDid", "signature"]);
  if (Object.keys(checkpoint).some((key) => !allowed.has(key))
    || checkpoint.schema !== ROOT_STATUS_CHECKPOINT_V1_SCHEMA
    || checkpoint.targetCid !== input.rootCid
    || (checkpoint.targetRole !== "policy-authority" && checkpoint.targetRole !== "policy-enforcement")
    || (checkpoint.state !== "active" && checkpoint.state !== "revoked")
    || typeof checkpoint.ownerDid !== "string"
    || typeof checkpoint.nodeAudience !== "string"
    || checkpoint.issuerDid !== checkpoint.nodeAudience
    || (input.expectedNodeAudience !== undefined && checkpoint.nodeAudience !== input.expectedNodeAudience)
    || !Number.isInteger(checkpoint.sequence)
    || (checkpoint.sequence as number) < 1
    || typeof checkpoint.checkedAt !== "string"
    || typeof checkpoint.freshUntil !== "string") return false;
  const checkedAt = Date.parse(checkpoint.checkedAt as string);
  const freshUntil = Date.parse(checkpoint.freshUntil as string);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(checkedAt) || !Number.isFinite(freshUntil)
    || freshUntil < now || freshUntil <= checkedAt || freshUntil - checkedAt > 300_000) return false;
  if ((checkpoint.sequence === 1) !== (checkpoint.previousCheckpointDigestHex === undefined)) return false;
  if (checkpoint.sequence !== 1 && (typeof checkpoint.previousCheckpointDigestHex !== "string" || !/^[0-9a-f]{64}$/.test(checkpoint.previousCheckpointDigestHex))) return false;
  if (checkpoint.state === "active" && (checkpoint.revokedAt !== undefined || checkpoint.revocationCid !== undefined)) return false;
  if (checkpoint.state === "revoked" && (typeof checkpoint.revokedAt !== "string" || typeof checkpoint.revocationCid !== "string")) return false;
  const signature = checkpoint.signature;
  if (!isRecordValue(signature) || Object.keys(signature).length !== 3 || signature.suite !== "Ed25519" || signature.signerDid !== checkpoint.issuerDid || typeof signature.value !== "string") return false;
  try {
    const principal = (checkpoint.issuerDid as string).split("#", 1)[0]!;
    const didMaterial = principal.startsWith("did:key:") ? base58btc.decode(principal.slice("did:key:".length)) : new Uint8Array();
    if (didMaterial.length !== 34 || didMaterial[0] !== 0xed || didMaterial[1] !== 0x01) return false;
    const unsigned = { ...checkpoint } as Record<string, unknown>;
    delete unsigned.signature;
    return ed25519.verify(
      decodeBase64Url(signature.value),
      sha256(new TextEncoder().encode(ROOT_STATUS_V1_DOMAIN + jcsCanonicalize(unsigned))),
      didMaterial.slice(2),
    );
  } catch {
    return false;
  }
}

export async function getPolicyRootStatusV3(input: {
  readonly nodeOrigin: string;
  readonly rootCid: string;
  readonly expectedNodeAudience?: string;
  readonly expectedEnforcerDid?: string;
  readonly now?: Date;
  readonly fetch?: typeof fetch;
}): Promise<PolicyRootStatusV3> {
  const fetchFn = input.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchFn(new URL(`/share/v3/policy/status/${encodeURIComponent(input.rootCid)}`, input.nodeOrigin), {
    method: "GET",
    redirect: "error",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`policy root status rejected (${response.status})`);
  const value = object(await response.json(), "policy root status");
  const checkpoint = object(value.checkpoint, "policy root checkpoint");
  if (value.rootCid !== input.rootCid
    || (value.state !== "active" && value.state !== "revoked")
    || value.state !== checkpoint.state
    || !verifyPolicyRootStatusCheckpointV3({ rootCid: input.rootCid, checkpoint, expectedNodeAudience: input.expectedNodeAudience, now: input.now }))
    throw new Error("policy root status binding is invalid");
  const revocation = value.revocation === undefined ? undefined : object(value.revocation, "policy root revocation");
  if ((value.state === "revoked") !== (revocation !== undefined)
    || revocation !== undefined && !verifyPolicyRootRevocationV3({
      rootCid: input.rootCid,
      checkpoint,
      revocation,
      expectedEnforcerDid: input.expectedEnforcerDid,
    })) throw new Error("policy root status revocation evidence is invalid");
  return { rootCid: input.rootCid, state: value.state, checkpoint, ...(revocation === undefined ? {} : { revocation }) };
}

export function verifyPolicyRootRevocationV3(input: {
  readonly rootCid: string;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly revocation: Readonly<Record<string, unknown>>;
  readonly expectedEnforcerDid?: string;
}): boolean {
  const value = input.revocation;
  const allowed = ["schema", "targetCid", "targetRole", "ownerDid", "nodeAudience", "revokedAt", "reason", "issuerDid", "signature"];
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key))
    || value.schema !== ROOT_REVOCATION_V1_SCHEMA
    || value.targetCid !== input.rootCid
    || value.targetRole !== input.checkpoint.targetRole
    || value.ownerDid !== input.checkpoint.ownerDid
    || value.nodeAudience !== input.checkpoint.nodeAudience
    || value.revokedAt !== input.checkpoint.revokedAt
    || typeof value.reason !== "string" || value.reason.length === 0
    || typeof value.issuerDid !== "string") return false;
  const authorized = value.issuerDid === value.ownerDid
    || value.targetRole === "policy-enforcement" && value.issuerDid === input.expectedEnforcerDid;
  if (!authorized) return false;
  const signature = value.signature;
  if (!isRecordValue(signature) || Object.keys(signature).length !== 3 || signature.suite !== "Ed25519" || signature.signerDid !== value.issuerDid || typeof signature.value !== "string") return false;
  try {
    const principal = (value.issuerDid as string).split("#", 1)[0]!;
    const didMaterial = principal.startsWith("did:key:") ? base58btc.decode(principal.slice("did:key:".length)) : new Uint8Array();
    if (didMaterial.length !== 34 || didMaterial[0] !== 0xed || didMaterial[1] !== 0x01) return false;
    const unsigned = { ...value } as Record<string, unknown>;
    delete unsigned.signature;
    const digest = sha256(new TextEncoder().encode(ROOT_REVOCATION_V1_DOMAIN + jcsCanonicalize(unsigned)));
    return input.checkpoint.revocationCid === hex(digest)
      && ed25519.verify(decodeBase64Url(signature.value), digest, didMaterial.slice(2));
  } catch {
    return false;
  }
}

export async function renewPolicyRootStatusV3(input: {
  readonly nodeOrigin: string;
  readonly rootCid: string;
  readonly ownerDid: string;
  readonly nodeAudience: string;
  readonly sign: (digest: Uint8Array) => Promise<Uint8Array>;
  readonly now?: Date;
  readonly nonce?: string;
  readonly fetch?: typeof fetch;
}): Promise<Readonly<Record<string, unknown>>> {
  const fetchFn = input.fetch ?? globalThis.fetch.bind(globalThis);
  const current = await getPolicyRootStatusV3({ nodeOrigin: input.nodeOrigin, rootCid: input.rootCid, expectedNodeAudience: input.nodeAudience, now: input.now, fetch: fetchFn });
  if (current.state !== "active" || current.checkpoint.ownerDid !== input.ownerDid || current.checkpoint.nodeAudience !== input.nodeAudience || current.checkpoint.state !== "active" || !Number.isInteger(current.checkpoint.sequence))
    throw new Error("policy root status cannot be renewed");
  const currentUnsigned = { ...current.checkpoint };
  delete currentUnsigned.signature;
  const previousCheckpointDigestHex = hex(sha256(new TextEncoder().encode(ROOT_STATUS_V1_DOMAIN + jcsCanonicalize(currentUnsigned))));
  const unsigned = {
    schema: "xyz.tinycloud.policy/root-status-renewal/v1",
    targetCid: input.rootCid,
    ownerDid: input.ownerDid,
    nodeAudience: input.nodeAudience,
    issuedAt: (input.now ?? new Date()).toISOString(),
    nonce: input.nonce ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    sequence: (current.checkpoint.sequence as number) + 1,
    previousCheckpointDigestHex,
  };
  const signature = await input.sign(sha256(new TextEncoder().encode(ROOT_STATUS_RENEWAL_V1_DOMAIN + jcsCanonicalize(unsigned))));
  if (signature.length !== 64) throw new Error("policy root renewal signature must be Ed25519");
  const response = await fetchFn(new URL("/share/v3/policy/status", input.nodeOrigin), {
    method: "POST",
    redirect: "error",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ rootCid: input.rootCid, renewal: { ...unsigned, signature: { suite: "Ed25519", signerDid: input.ownerDid, value: encodeBase64Url(signature) } } }),
  });
  if (!response.ok) throw new Error(`policy root renewal rejected (${response.status})`);
  return object(await response.json(), "policy root renewal");
}

export async function revokePolicyRootV3(input: {
  readonly nodeOrigin: string;
  readonly rootCid: string;
  readonly targetRole: "policy-authority" | "policy-enforcement";
  readonly ownerDid: string;
  readonly issuerDid: string;
  readonly nodeAudience: string;
  readonly reason: string;
  readonly sign: (digest: Uint8Array) => Promise<Uint8Array>;
  readonly now?: Date;
  readonly fetch?: typeof fetch;
}): Promise<Readonly<Record<string, unknown>>> {
  if (input.reason.length === 0) throw new Error("policy root revocation reason is required");
  const unsigned = {
    schema: ROOT_REVOCATION_V1_SCHEMA,
    targetCid: input.rootCid,
    targetRole: input.targetRole,
    ownerDid: input.ownerDid,
    nodeAudience: input.nodeAudience,
    revokedAt: (input.now ?? new Date()).toISOString(),
    reason: input.reason,
    issuerDid: input.issuerDid,
  };
  const signature = await input.sign(sha256(new TextEncoder().encode(ROOT_REVOCATION_V1_DOMAIN + jcsCanonicalize(unsigned))));
  if (signature.length !== 64) throw new Error("policy root revocation signature must be Ed25519");
  const fetchFn = input.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchFn(new URL("/revoke", input.nodeOrigin), {
    method: "POST",
    redirect: "error",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ revocation: { ...unsigned, signature: { suite: "Ed25519", signerDid: input.issuerDid, value: encodeBase64Url(signature) } } }),
  });
  if (!response.ok) throw new Error(`policy root revocation rejected (${response.status})`);
  return object(await response.json(), "policy root revocation");
}

const POLICY_SESSION_FACT_KEYS = [
  "profile",
  "ownerDid",
  "policyId",
  "policyDigestHex",
  "policyCid",
  "policyDelegationCid",
  "enforcementDelegationCid",
  "contentSourceDigestHex",
  "capabilityCeilingHashHex",
  "nativeProjectionHashHex",
  "enforcerDid",
  "nodeAudience",
  "recipientDid",
  "challengeId",
  "claimDigestHex",
  "claimJti",
  "vpDigestHex",
  "credentialEvidenceDigestHex",
  "decisionContextDigestHex",
  "issuanceAuditDigestHex",
  "remainingRedelegationDepth",
] as const;

const KV_ACTIONS = new Set<string>([
  "tinycloud.kv/get",
  "tinycloud.kv/list",
  "tinycloud.kv/metadata",
  "tinycloud.kv/put",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key)))
    throw new Error(`${label} contains an unknown field`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function parseKvResource(resource: string): { space: string; path: string } {
  const match = /^tinycloud:\/\/([^/]+)\/kv\/(.+)$/.exec(resource);
  if (
    !match ||
    match[1]!.includes(":") ||
    match[1]!.includes("?") ||
    match[1]!.includes("#") ||
    match[1]!.includes("%") ||
    match[2]!.startsWith("/") ||
    match[2]!.endsWith("/") ||
    match[2]!.includes("//") ||
    match[2]!
      .split("/")
      .some((part) => part === "." || part === ".." || part.length === 0)
  ) {
    throw new Error("KV resource is not canonical");
  }
  return { space: match[1]!, path: match[2]! };
}

function parseEncryptionResource(resource: string): void {
  if (!resource.startsWith("urn:tinycloud:encryption:")) throw new Error("encryption capability is invalid");
  const rest = resource.slice("urn:tinycloud:encryption:".length);
  const separator = rest.lastIndexOf(":");
  const ownerDid = separator < 0 ? "" : rest.slice(0, separator);
  const network = separator < 0 ? "" : rest.slice(separator + 1);
  if (!ownerDid.startsWith("did:") || network.length === 0 || network.includes(":") || network.includes("/") || network.includes("%") || network.includes("?") || network.includes("#")) {
    throw new Error("encryption capability is invalid");
  }
}

export function normalizeUnifiedPolicyCapability(
  input: unknown,
): UnifiedPolicyCapability {
  const value = object(input, "capability");
  const kind = nonEmptyString(value.kind, "capability.kind");
  if (kind === "kv") {
    exactKeys(
      value,
      ["kind", "resource", "selector", "actions"],
      "KV capability",
    );
    const resource = nonEmptyString(value.resource, "capability.resource");
    parseKvResource(resource);
    if (value.selector !== "exact" && value.selector !== "prefix")
      throw new Error("capability.selector is invalid");
    if (!Array.isArray(value.actions) || value.actions.length === 0)
      throw new Error("capability.actions is invalid");
    const actions = value.actions.map((action) =>
      nonEmptyString(action, "capability.actions[]"),
    );
    if (
      new Set(actions).size !== actions.length ||
      actions.some((action) => !KV_ACTIONS.has(action))
    )
      throw new Error("capability.actions is invalid");
    return {
      kind: "kv",
      resource,
      selector: value.selector,
      actions: [...actions].sort() as UnifiedKvCapability["actions"],
    };
  }
  if (kind === "encryption") {
    exactKeys(value, ["kind", "resource", "action"], "encryption capability");
    const resource = nonEmptyString(value.resource, "capability.resource");
    if (value.action !== "tinycloud.encryption/decrypt")
      throw new Error("encryption capability is invalid");
    parseEncryptionResource(resource);
    return {
      kind: "encryption",
      resource,
      action: "tinycloud.encryption/decrypt",
    };
  }
  throw new Error("capability.kind is invalid");
}

export function canonicalizeUnifiedPolicyCapability(
  input: unknown,
): UnifiedPolicyCapability {
  return normalizeUnifiedPolicyCapability(input);
}

export function unifiedPolicyCapabilityDigestHex(input: unknown): string {
  return hex(
    sha256(
      new TextEncoder().encode(
        POLICY_CAPABILITY_V1_DOMAIN +
          jcsCanonicalize(normalizeUnifiedPolicyCapability(input)),
      ),
    ),
  );
}

export function unifiedPolicyCapabilityContains(
  authorityInput: unknown,
  requestedInput: unknown,
): boolean {
  try {
    const authority = normalizeUnifiedPolicyCapability(authorityInput);
    const requested = normalizeUnifiedPolicyCapability(requestedInput);
    if (authority.kind !== requested.kind) return false;
    if (authority.kind === "encryption" && requested.kind === "encryption")
      return (
        authority.resource === requested.resource &&
        authority.action === requested.action
      );
    if (authority.kind !== "kv" || requested.kind !== "kv") return false;
    const { resource: authorized } = authority;
    const { resource: requestedResource } = requested;
    const pathContained =
      authority.selector === "exact"
        ? authorized === requestedResource
        : authorized === requestedResource ||
          requestedResource.startsWith(`${authorized}/`);
    if (
      !pathContained ||
      (authority.selector === "exact" && requested.selector === "prefix")
    )
      return false;
    return requested.actions.every((action) =>
      authority.actions.includes(action),
    );
  } catch {
    return false;
  }
}

export function projectUnifiedPolicyCapability(
  input: unknown,
): UnifiedNativeCapability {
  const capability = normalizeUnifiedPolicyCapability(input);
  if (capability.kind === "encryption") {
    return {
      service: "tinycloud.encryption",
      space: capability.resource,
      path: capability.resource,
      actions: [capability.action],
    };
  }
  const { space, path } = parseKvResource(capability.resource);
  return {
    service: "tinycloud.kv",
    space,
    path,
    actions: [...capability.actions],
    caveat: {
      type: "xyz.tinycloud.resource/selector",
      kind: capability.selector,
      value: capability.resource,
    },
  };
}

export function projectUnifiedPolicyCapabilities(
  input: readonly unknown[],
): UnifiedNativeCapability[] {
  return input
    .map(projectUnifiedPolicyCapability)
    .sort((left, right) => {
      const a = jcsCanonicalize(left);
      const b = jcsCanonicalize(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

export function unifiedNativeProjectionHashHex(
  input: readonly unknown[],
): string {
  return hex(
    sha256(
      new TextEncoder().encode(
        NATIVE_PROJECTION_V1_DOMAIN +
          jcsCanonicalize(projectUnifiedPolicyCapabilities(input)),
      ),
    ),
  );
}

export function unifiedPolicyCapabilityFromNative(
  input: unknown,
): UnifiedPolicyCapability {
  const value = object(input, "native capability");
  exactKeys(
    value,
    ["service", "space", "path", "actions", "caveat"],
    "native capability",
  );
  const service = nonEmptyString(value.service, "native.service");
  const actions = value.actions;
  if (!Array.isArray(actions)) throw new Error("native.actions is invalid");
  if (
    service === "tinycloud.encryption" &&
    value.caveat === undefined &&
    value.space === value.path &&
    actions.length === 1 &&
    actions[0] === "tinycloud.encryption/decrypt"
  ) {
    return normalizeUnifiedPolicyCapability({
      kind: "encryption",
      resource: value.space,
      action: actions[0],
    });
  }
  if (
    service !== "tinycloud.kv" ||
    typeof value.space !== "string" ||
    typeof value.path !== "string"
  )
    throw new Error("native capability is not supported");
  const caveat = object(value.caveat, "native.caveat");
  exactKeys(caveat, ["type", "kind", "value"], "native selector caveat");
  if (
    caveat.type !== "xyz.tinycloud.resource/selector" ||
    (caveat.kind !== "exact" && caveat.kind !== "prefix") ||
    caveat.value !== `tinycloud://${value.space}/kv/${value.path}`
  )
    throw new Error("native selector caveat does not match capability");
  return normalizeUnifiedPolicyCapability({
    kind: "kv",
    resource: caveat.value,
    selector: caveat.kind,
    actions,
  });
}

export function contentSourceDigestHex(input: UnifiedContentSource): string {
  return hex(
    sha256(
      new TextEncoder().encode(
        CONTENT_SOURCE_V1_DOMAIN + jcsCanonicalize(input),
      ),
    ),
  );
}

export function policyDigestHex(
  policy: Omit<UnifiedPolicyV1, "policyId" | "signature">,
): string {
  const canonicalPolicy = {
    ...policy,
    capabilityCeiling: policy.capabilityCeiling.map(
      normalizeUnifiedPolicyCapability,
    ),
  };
  return hex(
    sha256(
      new TextEncoder().encode(
        POLICY_V1_DOMAIN + jcsCanonicalize(canonicalPolicy),
      ),
    ),
  );
}

export function policyIdForDigestHex(digestHex: string): string {
  const digest = Uint8Array.from(
    (digestHex.match(/.{2}/g) ?? []).map((byte) => Number.parseInt(byte, 16)),
  );
  if (digest.length !== 32) throw new Error("policy digest must be 32 bytes");
  return `pol_${base32Lower(digest)}`;
}

export function policyCidFromCanonicalBytes(bytes: Uint8Array): string {
  return CID.createV1(0x55, createDigest(0x12, sha256(bytes))).toString();
}

const CompactHeaderSchema = z.object({
  alg: z.literal("EdDSA"),
  jwk: z.object({ alg: z.literal("EdDSA"), crv: z.literal("Ed25519"), kty: z.literal("OKP"), x: z.string().min(1) }).strict(),
  typ: z.literal("JWT"),
  ucv: z.literal("0.10.0"),
}).strict();
const CompactPayloadSchema = z.object({
  att: z.record(z.record(z.array(z.unknown()).min(1))),
  aud: z.string().min(1),
  exp: z.number().int(),
  fct: z.array(z.record(z.unknown())).length(1),
  iss: z.string().min(1),
  nbf: z.number().int(),
  nnc: z.string().min(1),
  prf: z.array(z.string().min(1)),
}).strict();

export interface CompactUcanAuthorizationV1 {
  readonly authorization: string;
  readonly cid: string;
  readonly header: z.infer<typeof CompactHeaderSchema>;
  readonly payload: z.infer<typeof CompactPayloadSchema>;
}

export interface CompactPolicyInvocationInput {
  readonly sessionAuthorization: string;
  readonly sessionCid: string;
  readonly recipientDid: string;
  readonly audienceDid: string;
  readonly resource: string;
  readonly action: string;
  readonly caveat?: Readonly<Record<string, unknown>>;
  readonly facts?: Readonly<Record<string, unknown>>;
  readonly privateKey: Uint8Array;
  readonly now?: number;
  readonly nonce?: string;
}

/** Sign a fresh one-parent ordinary invocation; S0 itself is never a bearer. */
export function createCompactPolicyInvocation(
  input: CompactPolicyInvocationInput,
): CompactUcanAuthorizationV1 {
  const session = parsePolicySessionUcan(input.sessionAuthorization);
  if (session.cid !== input.sessionCid || session.aud !== input.recipientDid)
    throw new Error("policy session does not bind the recipient signer");
  const principal = input.recipientDid.split("#", 1)[0]!;
  const didMaterial = base58btc.decode(principal.slice("did:key:".length));
  if (didMaterial.length !== 34 || didMaterial[0] !== 0xed || didMaterial[1] !== 0x01)
    throw new Error("policy invocation signer must be did:key Ed25519");
  const publicKey = ed25519.getPublicKey(input.privateKey);
  if (!equalBytes(publicKey, didMaterial.slice(2)))
    throw new Error("policy invocation private key does not bind recipient DID");
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const exp = Math.min(now + 60, session.exp);
  if (exp <= now) throw new Error("policy session has expired");
  const header = { alg: "EdDSA", jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: encodeBase64Url(publicKey) }, typ: "JWT", ucv: "0.10.0" };
  const payload = {
    att: { [input.resource]: { [input.action]: [input.caveat ?? {}] } },
    aud: input.audienceDid,
    exp,
    fct: [input.facts ?? { type: "tinycloud.policy.invocation/v1", policyCid: session.fact.policyCid, sessionCid: session.cid }],
    iss: input.recipientDid.includes("#") ? input.recipientDid : `${principal}#${principal.slice("did:key:".length)}`,
    nbf: now,
    nnc: input.nonce ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    prf: [session.cid],
  };
  const protectedSegment = encodeBase64Url(new TextEncoder().encode(jcsCanonicalize(header)));
  const payloadSegment = encodeBase64Url(new TextEncoder().encode(jcsCanonicalize(payload)));
  const signingInput = new TextEncoder().encode(`${protectedSegment}.${payloadSegment}`);
  const signature = ed25519.sign(signingInput, input.privateKey);
  return parseCompactUcanAuthorization(`${protectedSegment}.${payloadSegment}.${encodeBase64Url(signature)}`);
}

export function createCompactPolicyDescendant(input: {
  readonly parentAuthorization: string;
  readonly parentCid: string;
  readonly issuerDid: string;
  readonly audienceDid: string;
  readonly attenuation: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>>;
  readonly privateKey: Uint8Array;
  readonly now?: number;
  readonly expiresAt?: number;
  readonly nonce?: string;
}): CompactUcanAuthorizationV1 {
  const parent = parseCompactUcanAuthorization(input.parentAuthorization, input.parentCid);
  if (parent.payload.aud !== input.issuerDid) throw new Error("policy descendant issuer is not the parent audience");
  const parentFact = parent.payload.fct[0]!;
  const depth = parentFact.remainingRedelegationDepth;
  if (!Number.isInteger(depth) || (depth as number) <= 0) throw new Error("policy descendant depth is exhausted");
  if (!compactAttenuationContains(parent.payload.att, input.attenuation))
    throw new Error("policy descendant exceeds the parent attenuation");
  const principal = input.issuerDid.split("#", 1)[0]!;
  const didMaterial = base58btc.decode(principal.slice("did:key:".length));
  const publicKey = ed25519.getPublicKey(input.privateKey);
  if (didMaterial.length !== 34 || !equalBytes(publicKey, didMaterial.slice(2))) throw new Error("policy descendant signer does not bind issuer DID");
  const now = Math.max(input.now ?? Math.floor(Date.now() / 1000), parent.payload.nbf + 1);
  const exp = Math.min(input.expiresAt ?? now + 60, now + 60, parent.payload.exp - 1);
  if (exp <= now) throw new Error("policy parent has no strictly narrower validity window");
  const header = { alg: "EdDSA", jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: encodeBase64Url(publicKey) }, typ: "JWT", ucv: "0.10.0" };
  const payload = {
    att: input.attenuation,
    aud: input.audienceDid,
    exp,
    fct: [{ ...parentFact, remainingRedelegationDepth: (depth as number) - 1 }],
    iss: input.issuerDid.includes("#") ? input.issuerDid : `${principal}#${principal.slice("did:key:".length)}`,
    nbf: now,
    nnc: input.nonce ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    prf: [parent.cid],
  };
  const protectedSegment = encodeBase64Url(new TextEncoder().encode(jcsCanonicalize(header)));
  const payloadSegment = encodeBase64Url(new TextEncoder().encode(jcsCanonicalize(payload)));
  const signature = ed25519.sign(new TextEncoder().encode(`${protectedSegment}.${payloadSegment}`), input.privateKey);
  return parseCompactUcanAuthorization(`${protectedSegment}.${payloadSegment}.${encodeBase64Url(signature)}`);
}

/** Byte-independent semantic containment shared by S0, descendants and mint requests. */
export function compactAttenuationContains(
  parent: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>>,
  child: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>>,
): boolean {
  const selector = (value: readonly unknown[]): { readonly kind: "exact" | "prefix"; readonly value: string } | undefined => {
    if (value.length !== 1 || !isRecordValue(value[0])) return undefined;
    const caveat = value[0];
    if (Object.keys(caveat).length !== 3 || caveat.type !== "xyz.tinycloud.resource/selector" || (caveat.kind !== "exact" && caveat.kind !== "prefix") || typeof caveat.value !== "string") return undefined;
    return { kind: caveat.kind, value: caveat.value };
  };
  const equal = (left: unknown, right: unknown): boolean => jcsCanonicalize(left) === jcsCanonicalize(right);
  return Object.entries(child).every(([childResource, childActions]) =>
    Object.entries(childActions).every(([action, childCaveats]) =>
      Object.entries(parent).some(([parentResource, parentActions]) => {
        const parentCaveats = parentActions[action];
        if (parentCaveats === undefined) return false;
        if (parentResource === childResource && equal(parentCaveats, childCaveats)) return true;
        const parentSelector = selector(parentCaveats);
        const childSelector = selector(childCaveats);
        return parentSelector?.kind === "prefix"
          && childSelector !== undefined
          && parentSelector.value === parentResource
          && childSelector.value === childResource
          && (childResource === parentResource || childResource.startsWith(`${parentResource}/`));
      }),
    ),
  );
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseCompactUcanAuthorization(
  input: string,
  expectedCid?: string,
): CompactUcanAuthorizationV1 {
  if (typeof input !== "string" || /\s/.test(input))
    throw new Error("Authorization must be compact UCAN bytes");
  const segments = input.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0))
    throw new Error("Authorization must have three compact segments");
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  const headerBytes = decodeBase64Url(headerSegment);
  const payloadBytes = decodeBase64Url(payloadSegment);
  const signature = decodeBase64Url(signatureSegment);
  const headerValue: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes));
  const payloadValue: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  if (jcsCanonicalize(headerValue) !== new TextDecoder().decode(headerBytes)
    || jcsCanonicalize(payloadValue) !== new TextDecoder().decode(payloadBytes))
    throw new Error("compact UCAN segments are not canonical JCS");
  const header = CompactHeaderSchema.parse(headerValue);
  const payload = CompactPayloadSchema.parse(payloadValue);
  if (payload.nbf >= payload.exp) throw new Error("compact UCAN validity is empty");
  const principal = payload.iss.split("#", 1)[0]!;
  const didMaterial = principal.startsWith("did:key:")
    ? base58btc.decode(principal.slice("did:key:".length))
    : new Uint8Array();
  if (didMaterial.length !== 34 || didMaterial[0] !== 0xed || didMaterial[1] !== 0x01)
    throw new Error("compact UCAN issuer must be did:key Ed25519");
  const publicKey = didMaterial.slice(2);
  if (!equalBytes(publicKey, decodeBase64Url(header.jwk.x)))
    throw new Error("compact UCAN JWK does not bind issuer");
  if (!ed25519.verify(signature, new TextEncoder().encode(`${headerSegment}.${payloadSegment}`), publicKey))
    throw new Error("compact UCAN signature is invalid");
  const cid = CID.createV1(0x55, createDigest(0x1e, blake3(new TextEncoder().encode(input)))).toString();
  if (expectedCid !== undefined && cid !== expectedCid)
    throw new Error("compact UCAN CID does not match exact Authorization bytes");
  return { authorization: input, cid, header, payload };
}

export function parsePolicySessionUcan(
  authorization: string,
  expectedProofs?: readonly [string, string],
): PolicySessionUcanV1 {
  const parsed = parseCompactUcanAuthorization(authorization);
  const fact = parsed.payload.fct[0]!;
  if (parsed.payload.prf.length !== 2 || parsed.payload.prf[0] === parsed.payload.prf[1])
    throw new Error("policy session UCAN requires two distinct ordered proofs");
  if (expectedProofs !== undefined
    && (parsed.payload.prf[0] !== expectedProofs[0] || parsed.payload.prf[1] !== expectedProofs[1]))
    throw new Error("policy session UCAN ordered proofs do not match");
  const factKeys = Object.keys(fact);
  if (
    factKeys.length !== POLICY_SESSION_FACT_KEYS.length ||
    factKeys.some((key) => !POLICY_SESSION_FACT_KEYS.includes(key as never)) ||
    POLICY_SESSION_FACT_KEYS.some((key) => !(key in fact))
  )
    throw new Error("policy session UCAN fact is incomplete");
  if (
    fact.profile !== POLICY_SESSION_UCAN_V1_PROFILE ||
    typeof fact.remainingRedelegationDepth !== "number" ||
    !Number.isInteger(fact.remainingRedelegationDepth) ||
    fact.remainingRedelegationDepth < 0 ||
    fact.remainingRedelegationDepth > 8 ||
    parsed.payload.exp - parsed.payload.nbf > 60 ||
    parsed.payload.iss.split("#", 1)[0] !== fact.enforcerDid ||
    parsed.payload.aud !== fact.recipientDid
  )
    throw new Error("policy session UCAN fact is invalid");
  return {
    authorization,
    cid: parsed.cid,
    iss: parsed.payload.iss,
    aud: parsed.payload.aud,
    prf: parsed.payload.prf as [string, string],
    att: parsed.payload.att,
    nbf: parsed.payload.nbf,
    exp: parsed.payload.exp,
    nnc: parsed.payload.nnc,
    fact,
  };
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
    throw new Error("value is not canonical base64url");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = typeof Buffer !== "undefined"
    ? Buffer.from(normalized, "base64").toString("binary")
    : atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const encoded = typeof Buffer !== "undefined"
    ? Buffer.from(bytes).toString("base64url")
    : btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  if (encoded !== value) throw new Error("value is not canonical base64url");
  return bytes;
}

function encodeBase64Url(value: Uint8Array): string {
  return typeof Buffer !== "undefined"
    ? Buffer.from(value).toString("base64url")
    : btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base32Lower(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}
