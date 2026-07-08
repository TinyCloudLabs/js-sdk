import ms from "ms";
import { bases } from "multiformats/basics";
import { bytesToHex, hexToBytes, verifyMessage } from "viem";
import {
  canonicalizeEncryptionJson,
  type IDatabaseHandle,
  type ISQLService,
  type ExecuteResponse,
  type QueryResponse,
  type SqlValue,
} from "@tinycloud/sdk-services";
import { canonicalizeDid, parsePkhDid } from "./identity";
import { verifyDidKeyEd25519Signature } from "./location";
import { type Delegation, type DelegatedResource } from "./delegations";
import { SERVICE_LONG_TO_SHORT, type PermissionEntry } from "./manifest";

export type PolicySignatureSuite =
  | "eddsa-ed25519-sha256-jcs-v1"
  | "eip191-secp256k1-sha256-jcs-v1";

export interface Signature {
  suite: PolicySignatureSuite;
  signerDid: string;
  value: string;
}

export type PolicyShareTarget =
  | { kind: "domain"; value: string }
  | { kind: "email"; value: string };

export interface NormalizedPolicyShareTarget {
  kind: PolicyShareTarget["kind"];
  value: string;
}

export interface PolicyCapability {
  service: string;
  space: string;
  path: string;
  actions: string[];
  caveats?: unknown;
}

export interface PolicyEvidenceRequirement {
  requirementId: string;
  verifier: string;
  requirements: {
    type: string;
    vct: string;
    subject: { binding: "sub-equals-eligibleSubjectDid" };
    claims: {
      emailDomain?: { oneOf: string[] };
      email?: { oneOf: string[] };
    };
  };
  authority: {
    acceptedIssuers: string[];
  };
}

export interface PolicyWhen {
  evidence?: PolicyEvidenceRequirement;
  subject?: { did: string };
  allOf?: PolicyWhen[];
  anyOf?: PolicyWhen[];
}

export interface PolicyGrant {
  output: "portable-delegation";
  maxTtlSeconds: number;
  delegationMode: "terminal";
  revocation: "active_cutoff" | "refresh_only";
}

export type PolicyResourceType = "collection" | "notebook-slice";

export interface PolicyResource {
  resourceType: PolicyResourceType;
  resourceId: string;
  permissionsCeiling: PolicyCapability[];
}

export interface Policy {
  schema: "xyz.tinycloud.policy/policy/v0";
  policyId: string;
  ownerDid: string;
  signingKeyDid: string;
  createdAt: string;
  resource: PolicyResource;
  when: PolicyWhen;
  grant: PolicyGrant;
  signature: Signature;
}

export interface PolicyStatus {
  schema: "xyz.tinycloud.policy/status/v0";
  statusId: string;
  policyId: string;
  ownerDid: string;
  sequence: number;
  disposition: "active" | "revoked";
  effectiveAt: string;
  signingKeyDid: string;
  reasonCode?: string;
  signature: Signature;
}

export interface PolicyEngineRecord {
  schema: "xyz.tinycloud.policy/engine-record/v0";
  engineRecordId: string;
  ownerDid: string;
  endpoint: string;
  audience: string;
  supportedPolicyVersions: Array<"v0">;
  supportedEvidenceVerifiers: string[];
  grantIssuerDid: string;
  expiresAt: string;
  signature: Signature;
}

export interface HolderEnrollment {
  schema: "xyz.tinycloud.policy/holder-enrollment/v0";
  enrollmentId: string;
  eligibleSubjectDid: string;
  holderDid: string;
  scope?: {
    policyIds?: string[];
    resourceIds?: string[];
  };
  notBefore: string;
  expiresAt?: string;
  signingKeyDid: string;
  signature: Signature;
}

export interface HolderEnrollmentStatus {
  schema: "xyz.tinycloud.policy/holder-enrollment-status/v0";
  statusId: string;
  enrollmentId: string;
  sequence: number;
  disposition: "active" | "revoked";
  effectiveAt: string;
  signingKeyDid: string;
  signature: Signature;
}

export type HolderBindingProof =
  | {
      type: "session-chain";
      chain: PolicyPortableDelegation[];
    }
  | {
      type: "enrolled-agent";
      enrollment: HolderEnrollment;
      status?: HolderEnrollmentStatus;
    };

export interface GrantChallenge {
  schema: "xyz.tinycloud.policy/challenge/v0";
  challengeId: string;
  policyId: string;
  audience: string;
  nonce: string;
  challengeExpiresAt: string;
  acceptedSuites: PolicySignatureSuite[];
  requestedCapabilitiesTemplate?: PolicyCapability[];
  signature: Signature;
}

export interface GrantPresentationEvidence {
  requirementId: string;
  presentation: unknown;
}

export interface GrantPresentation {
  schema: "xyz.tinycloud.policy/presentation/v0";
  policyId: string;
  eligibleSubjectDid: string;
  holderDid: string;
  holderBinding: HolderBindingProof;
  requestedCapabilities: PolicyCapability[];
  requestedCapabilitiesHash: string;
  audience: string;
  nonce: string;
  expiresAt: string;
  evidence?: GrantPresentationEvidence[];
  holderSignature: Signature;
}

export type PolicyPortableDelegation = Omit<Delegation, "isRevoked"> & {
  delegationHeader: { Authorization: string };
  ownerAddress: string;
  chainId: number;
  host?: string;
  disableSubDelegation?: boolean;
  publicDelegation?: PolicyPortableDelegation;
  resources?: DelegatedResource[];
};

export const PolicyDeniedCodes = {
  POLICY_NOT_FOUND: "policy-not-found",
  POLICY_INVALID: "policy-invalid",
  POLICY_INACTIVE: "policy-inactive",
  POLICY_EXPIRED: "policy-expired",
  VERIFIER_UNSUPPORTED: "verifier-unsupported",
  CHALLENGE_INVALID: "challenge-invalid",
  CHALLENGE_NOT_FOUND: "challenge-not-found",
  CHALLENGE_EXPIRED: "challenge-expired",
  CHALLENGE_NONCE_CONSUMED: "challenge-nonce-consumed",
  PRESENTATION_INVALID: "presentation-invalid",
  PRESENTATION_EXPIRED: "presentation-expired",
  PRESENTATION_AUDIENCE_MISMATCH: "presentation-audience-mismatch",
  PRESENTATION_EVIDENCE_MISSING: "presentation-evidence-missing",
  EVIDENCE_REQUIREMENT_UNKNOWN: "evidence-requirement-unknown",
  EVIDENCE_REQUIREMENT_DUPLICATE: "evidence-requirement-duplicate",
  HOLDER_SIGNATURE_INVALID: "holder-signature-invalid",
  HOLDER_SIGNATURE_SIGNER_MISMATCH: "holder-signature-signer-mismatch",
  REQUESTED_CAPABILITIES_EXCEEDED: "requested-capabilities-exceeded",
  ELIGIBLE_SUBJECT_NOT_AUTHORIZED: "eligible-subject-not-authorized",
  HOLDER_NOT_AUTHORIZED: "holder-not-authorized",
  EVIDENCE_INVALID: "evidence-invalid",
  EVIDENCE_EXPIRED: "evidence-expired",
  EVIDENCE_REVOKED: "evidence-revoked",
  EVIDENCE_STATUS_STALE: "evidence-status-stale",
  PARENT_AUTHORITY_INSUFFICIENT: "parent-authority-insufficient",
  GRANT_ISSUANCE_FAILED: "grant-issuance-failed",
  ACTIVE_CUTOFF_FAILED: "active-cutoff-failed",
} as const;

export type PolicyDeniedCode =
  (typeof PolicyDeniedCodes)[keyof typeof PolicyDeniedCodes];

export class PolicyDeniedError extends Error {
  public readonly code: PolicyDeniedCode;
  public readonly statusCode?: number;
  public readonly details?: unknown;

  constructor(code: PolicyDeniedCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = "PolicyDeniedError";
    this.code = code;
    this.details = details;
  }
}

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

export type PolicySigningSource =
  | {
      kind: "did:key";
      did: string;
      signBytes(bytes: Uint8Array): Promise<Uint8Array>;
    }
  | {
      kind: "did:pkh";
      did: string;
      signMessage(message: Uint8Array): Promise<string>;
    };

export interface PolicyDelegationAuthority {
  delegateTo(
    did: string,
    permissions: PermissionEntry[],
    options?: { expiry?: string | number; forceWalletSign?: boolean },
  ): Promise<{ delegation: PolicyPortableDelegation; prompted: boolean }>;
}

export interface PolicyDelegationRuntime {
  useDelegation(delegation: PolicyPortableDelegation): Promise<unknown>;
  useRuntimeDelegation?(delegation: PolicyPortableDelegation): Promise<void>;
}

export interface PolicyReplayStore {
  consume(key: string): boolean;
  has(key: string): boolean;
}

export class InMemoryPolicyReplayStore implements PolicyReplayStore {
  private readonly seen = new Set<string>();

  consume(key: string): boolean {
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    return true;
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }
}

export interface VerifiedPolicyEngineRecord {
  record: PolicyEngineRecord;
  policySignerDid: string;
}

export interface PolicyEngineClient {
  readonly record: PolicyEngineRecord;
  readonly policySignerDid: string;
  challenge(input: { policyId: string; now?: Date }): Promise<GrantChallenge>;
  resolve(input: {
    presentation: GrantPresentation;
    now?: Date;
  }): Promise<PolicyPortableDelegation>;
}

export interface PolicyShareSetup {
  conversationId: string;
  target: NormalizedPolicyShareTarget;
  capability: PolicyCapability;
  policy: Policy;
  policyStatus: PolicyStatus;
  ownerDelegation: PolicyPortableDelegation;
  ownerDelegationPrompted: boolean;
  policyEngineRecord: PolicyEngineRecord;
  requestedCapabilitiesHash: string;
}

export interface PolicyShareOwnerSetupInput {
  conversationId: string;
  target: PolicyShareTarget;
  ownerDid: string;
  policySigner: PolicySigningSource;
  policyEngineRecord: PolicyEngineRecord;
  delegationAuthority: PolicyDelegationAuthority;
  capability?: PermissionEntry | PolicyCapability;
  space?: string;
  acceptedIssuers?: string[];
  policyCreatedAt?: Date | string;
  policyStatusDisposition?: "active" | "revoked";
  policyStatusReasonCode?: string;
  maxTtlSeconds?: number;
  revocation?: PolicyGrant["revocation"];
}

export interface PolicySharingControllerOptions {
  setup: PolicyShareSetup;
  engine: PolicyEngineClient;
  eligibleSubjectDid: string;
  holderDid: string;
  holderSigner: PolicySigningSource;
  holderBinding: HolderBindingProof;
  replayStore?: PolicyReplayStore;
  now?: () => Date;
}

export interface PolicyChallengeResolution {
  challenge: GrantChallenge;
  presentation: GrantPresentation;
  delegation: PolicyPortableDelegation;
}

export interface ListenTranscriptSqlFixedParam {
  index: number;
  value: SqlValue;
}

export interface ListenTranscriptSqlInvokeRequest {
  name: "listen.getConversation" | "listen.listParticipants";
  sql: string;
  fixedParams: ListenTranscriptSqlFixedParam[];
}

const POLICY_CAPABILITY_DOMAIN = "xyz.tinycloud.policy/PolicyCapability/v0\0";
const REQUESTED_CAPABILITIES_DOMAIN =
  "xyz.tinycloud.policy/RequestedCapabilities/v0\0";
const SIGNED_OBJECT_PREFIXES: Record<string, string> = {
  Policy: "pol_",
  PolicyStatus: "polst_",
  PolicyEngineRecord: "peng_",
  HolderEnrollment: "henr_",
  HolderEnrollmentStatus: "henrst_",
  GrantChallenge: "gchal_",
};

function textEncoder() {
  return new TextEncoder();
}

function toUtf8(input: string): Uint8Array {
  return textEncoder().encode(input);
}

function fromUtf8(input: Uint8Array): string {
  return new TextDecoder().decode(input);
}

function randomBytes(length: number): Uint8Array {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.getRandomValues) {
    throw new Error("crypto.getRandomValues is required for policy nonce generation");
  }
  const bytes = new Uint8Array(length);
  cryptoObj.getRandomValues(bytes);
  return bytes;
}

function randomNonce(): string {
  return base64UrlNoPad(randomBytes(32));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) {
    throw new Error("crypto.subtle is required for policy signing");
  }
  const digest = await cryptoObj.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

async function digestCanonicalJson(
  domain: string,
  value: unknown,
): Promise<Uint8Array> {
  const canonical = canonicalizeEncryptionJson(value as never);
  return sha256(new Uint8Array([...toUtf8(domain), ...toUtf8(canonical)]));
}

function base32LowerNoPad(bytes: Uint8Array): string {
  return bases.base32.encode(bytes).slice(1);
}

function base64UrlNoPad(bytes: Uint8Array): string {
  return bases.base64url.encode(bytes).slice(1);
}

function hexLower(bytes: Uint8Array): string {
  return bases.base16.encode(bytes).slice(1);
}

function cloneDeep<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeAsciiLower(input: string, label: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new PolicyValidationError(`${label} must be non-empty`);
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) > 0x7f) {
      throw new PolicyValidationError(`${label} must be ASCII`);
    }
  }
  return trimmed;
}

function normalizeEmail(email: string): string {
  const normalized = normalizeAsciiLower(email, "email");
  if (!/^\S+@\S+$/.test(normalized)) {
    throw new PolicyValidationError("email must contain a single @ and no whitespace");
  }
  return normalized;
}

function normalizeEmailDomain(domain: string): string {
  const normalized = normalizeAsciiLower(domain, "email domain");
  if (normalized.includes("@") || normalized.includes(" ")) {
    throw new PolicyValidationError("email domain must not contain @ or whitespace");
  }
  return normalized;
}

export function normalizePolicyShareTarget(
  target: PolicyShareTarget,
): NormalizedPolicyShareTarget {
  if (target.kind === "domain") {
    return { kind: "domain", value: normalizeEmailDomain(target.value) };
  }
  return { kind: "email", value: normalizeEmail(target.value) };
}

function normalizeDid(input: string): string {
  return canonicalizeDid(input);
}

function sortAndDedupeActions(actions: readonly string[], service: string): string[] {
  const expectedPrefix = `${service}/`;
  const out: string[] = [];
  const seen = new Set<string>();

  for (const action of actions) {
    if (typeof action !== "string" || action.length === 0) {
      throw new PolicyValidationError("policy capability actions must be non-empty strings");
    }
    if (!action.startsWith(expectedPrefix)) {
      throw new PolicyValidationError(
        `policy capability action must use the ${service} prefix`,
      );
    }
    if (!seen.has(action)) {
      seen.add(action);
      out.push(action);
    }
  }

  out.sort();
  if (out.length === 0) {
    throw new PolicyValidationError("policy capability must include at least one action");
  }
  return out;
}

function normalizePolicyCapability(
  capability: PolicyCapability,
): PolicyCapability {
  if (typeof capability !== "object" || capability === null) {
    throw new PolicyValidationError("policy capability must be an object");
  }
  if (typeof capability.service !== "string" || capability.service.length === 0) {
    throw new PolicyValidationError("policy capability service must be a string");
  }
  if (capability.service !== capability.service.toLowerCase()) {
    throw new PolicyValidationError("policy capability service must be lowercase");
  }
  if (/\s/.test(capability.service)) {
    throw new PolicyValidationError("policy capability service must not contain whitespace");
  }
  if (typeof capability.space !== "string" || capability.space.length === 0) {
    throw new PolicyValidationError("policy capability space must be a string");
  }
  if (capability.space.includes("*") || capability.space.includes("?") || capability.space.startsWith("manifest:")) {
    throw new PolicyValidationError("policy capability space is malformed");
  }
  if (typeof capability.path !== "string" || capability.path.length === 0) {
    throw new PolicyValidationError("policy capability path must be a string");
  }
  if (capability.path.includes("..")) {
    throw new PolicyValidationError("policy capability path must not contain .. segments");
  }
  const normalizedActions = sortAndDedupeActions(capability.actions, capability.service);
  const normalized: PolicyCapability = {
    service: capability.service,
    space: capability.space,
    path: capability.path,
    actions: normalizedActions,
  };
  if (capability.caveats !== undefined) {
    // Throws if the caveat payload is not valid JCS-serializable JSON.
    canonicalizeEncryptionJson(cloneDeep(capability.caveats) as never);
    normalized.caveats = cloneDeep(capability.caveats);
  }
  return normalized;
}

function capabilityCanonicalJson(capability: PolicyCapability): string {
  return canonicalizeEncryptionJson(normalizePolicyCapability(capability) as never);
}

function canonicalizeCapabilities(
  capabilities: readonly PolicyCapability[],
): PolicyCapability[] {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new PolicyValidationError("requested capabilities must be a non-empty array");
  }

  const normalized = capabilities.map((capability) => normalizePolicyCapability(capability));
  const seen = new Set<string>();
  const unique: PolicyCapability[] = [];

  for (const capability of normalized) {
    const key = capabilityCanonicalJson(capability);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(capability);
    }
  }

  unique.sort((left, right) => {
    if (left.service !== right.service) return left.service < right.service ? -1 : 1;
    if (left.space !== right.space) return left.space < right.space ? -1 : 1;
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    return capabilityCanonicalJson(left) < capabilityCanonicalJson(right) ? -1 : 1;
  });

  return unique;
}

function caveatsEqual(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  return canonicalizeEncryptionJson(cloneDeep(left) as never) === canonicalizeEncryptionJson(cloneDeep(right) as never);
}

function isCapabilityContained(
  requested: PolicyCapability,
  granted: PolicyCapability,
): boolean {
  const req = normalizePolicyCapability(requested);
  const auth = normalizePolicyCapability(granted);
  if (req.service !== auth.service || req.space !== auth.space || req.path !== auth.path) {
    return false;
  }
  const grantedActions = new Set(auth.actions);
  for (const action of req.actions) {
    if (!grantedActions.has(action)) {
      return false;
    }
  }
  if (!caveatsEqual(req.caveats, auth.caveats)) {
    return false;
  }
  return true;
}

function assertRequestedCapabilitiesWithinPolicy(
  requested: readonly PolicyCapability[],
  ceiling: readonly PolicyCapability[],
): void {
  const normalizedRequested = canonicalizeCapabilities(requested);
  const normalizedCeiling = canonicalizeCapabilities(ceiling);

  for (const req of normalizedRequested) {
    const match = normalizedCeiling.some((auth) => isCapabilityContained(req, auth));
    if (!match) {
      throw new PolicyDeniedError(
        PolicyDeniedCodes.REQUESTED_CAPABILITIES_EXCEEDED,
        "requested capabilities exceed the policy ceiling",
        { requested: req, ceiling: normalizedCeiling },
      );
    }
  }
}

export async function policyCapabilityHashHex(
  capability: PolicyCapability,
): Promise<string> {
  const canonical = normalizePolicyCapability(capability);
  const digest = await digestCanonicalJson(POLICY_CAPABILITY_DOMAIN, canonical);
  return hexLower(digest);
}

export async function requestedCapabilitiesHashHex(
  capabilities: readonly PolicyCapability[],
): Promise<string> {
  const canonical = canonicalizeCapabilities(capabilities);
  const digest = await digestCanonicalJson(REQUESTED_CAPABILITIES_DOMAIN, canonical);
  return hexLower(digest);
}

function toSignatureValueBytes(value: string): Uint8Array {
  return bases.base64url.decode(`u${value}`);
}

async function signDigest(
  digest: Uint8Array,
  signer: PolicySigningSource,
): Promise<Signature> {
  if (signer.kind === "did:key") {
    const sig = await signer.signBytes(digest);
    return {
      suite: "eddsa-ed25519-sha256-jcs-v1",
      signerDid: normalizeDid(signer.did),
      value: base64UrlNoPad(sig),
    };
  }
  const sigHex = await signer.signMessage(digest);
  return {
    suite: "eip191-secp256k1-sha256-jcs-v1",
    signerDid: normalizeDid(signer.did),
    value: base64UrlNoPad(
      hexToBytes((sigHex.startsWith("0x") ? sigHex : `0x${sigHex}`) as `0x${string}`),
    ),
  };
}

async function verifyDigestSignature(
  digest: Uint8Array,
  signature: Signature,
): Promise<boolean> {
  const signerDid = normalizeDid(signature.signerDid);
  const valueBytes = toSignatureValueBytes(signature.value);
  if (signature.suite === "eddsa-ed25519-sha256-jcs-v1") {
    return verifyDidKeyEd25519Signature(signerDid, digest, valueBytes);
  }
  if (!signerDid.startsWith("did:pkh:")) {
    throw new PolicyValidationError(
      "eip191 policy signatures must use did:pkh signerDid",
    );
  }
  const address = signerDid.split(":").at(-1);
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new PolicyValidationError("did:pkh signerDid must include an EIP-55 address");
  }
  return verifyMessage({
    address: address as `0x${string}`,
    message: { raw: digest },
    signature: bytesToHex(valueBytes),
  });
}

async function buildContentAddressedSignedObject<T extends Record<string, unknown>>(
  objectName: keyof typeof SIGNED_OBJECT_PREFIXES,
  domain: string,
  idField: string,
  unsigned: T,
  signer: PolicySigningSource,
): Promise<T & { signature: Signature } & Record<string, string>> {
  const digest = await digestCanonicalJson(domain, unsigned);
  const signature = await signDigest(digest, signer);
  const id = `${SIGNED_OBJECT_PREFIXES[String(objectName)]}${base32LowerNoPad(digest)}`;
  return {
    ...cloneDeep(unsigned),
    [idField]: id,
    signature,
  } as unknown as T & { signature: Signature } & Record<string, string>;
}

async function verifyContentAddressedSignedObject<T extends object>(
  objectName: keyof typeof SIGNED_OBJECT_PREFIXES,
  domain: string,
  idField: string,
  input: T & { signature: Signature },
): Promise<boolean> {
  const record = input as Record<string, unknown>;
  const signature = input.signature;
  const id = record[idField];
  if (typeof id !== "string" || !id.startsWith(SIGNED_OBJECT_PREFIXES[String(objectName)])) {
    throw new PolicyValidationError(`${String(objectName)} id field is malformed`);
  }
  const unsigned: Record<string, unknown> = { ...record };
  delete unsigned[idField];
  delete unsigned.signature;
  const digest = await digestCanonicalJson(domain, unsigned);
  const expectedId = `${SIGNED_OBJECT_PREFIXES[String(objectName)]}${base32LowerNoPad(digest)}`;
  if (id !== expectedId) {
    return false;
  }
  return verifyDigestSignature(digest, signature);
}

function normalizePolicyEngineRecordInput(record: PolicyEngineRecord): PolicyEngineRecord {
  if (typeof record !== "object" || record === null) {
    throw new PolicyValidationError("policy engine record must be an object");
  }
  if (!Array.isArray(record.supportedPolicyVersions) || record.supportedPolicyVersions.length === 0) {
    throw new PolicyValidationError("policy engine record must advertise at least one policy version");
  }
  if (!Array.isArray(record.supportedEvidenceVerifiers)) {
    throw new PolicyValidationError("policy engine record must include supported evidence verifiers");
  }
  return {
    ...record,
    ownerDid: normalizeDid(record.ownerDid),
    grantIssuerDid: normalizeDid(record.grantIssuerDid),
  };
}

export async function buildPolicyEngineRecord(input: {
  ownerDid: string;
  endpoint: string;
  audience: string;
  supportedPolicyVersions?: Array<"v0">;
  supportedEvidenceVerifiers?: string[];
  grantIssuerDid: string;
  expiresAt?: Date | string;
  signer: PolicySigningSource;
  engineRecordId?: string;
}): Promise<PolicyEngineRecord> {
  const now = new Date();
  const unsigned: Omit<PolicyEngineRecord, "engineRecordId" | "signature"> = {
    schema: "xyz.tinycloud.policy/engine-record/v0",
    ownerDid: normalizeDid(input.ownerDid),
    endpoint: input.endpoint,
    audience: input.audience,
    supportedPolicyVersions: input.supportedPolicyVersions ?? ["v0"],
    supportedEvidenceVerifiers:
      input.supportedEvidenceVerifiers ?? ["w3c.vc/credential/v1", "tinycloud.trust/direct-edge/v1"],
    grantIssuerDid: normalizeDid(input.grantIssuerDid),
    expiresAt:
      typeof input.expiresAt === "string"
        ? input.expiresAt
        : input.expiresAt instanceof Date
          ? input.expiresAt.toISOString()
          : new Date(now.getTime() + ms("365d")).toISOString(),
  };
  return buildContentAddressedSignedObject(
    "PolicyEngineRecord",
    "xyz.tinycloud.policy/engine-record/v0",
    "engineRecordId",
    unsigned,
    input.signer,
  ) as unknown as Promise<PolicyEngineRecord>;
}

export async function verifyPolicyEngineRecord(
  record: PolicyEngineRecord,
  options: { now?: Date } = {},
): Promise<VerifiedPolicyEngineRecord> {
  const normalized = normalizePolicyEngineRecordInput(record);
  const valid = await verifyContentAddressedSignedObject(
    "PolicyEngineRecord",
    "xyz.tinycloud.policy/engine-record/v0",
    "engineRecordId",
    normalized,
  );
  if (!valid) {
    throw new PolicyValidationError("policy engine record signature is invalid");
  }
  const expiresAt = new Date(normalized.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new PolicyValidationError("policy engine record expiresAt is invalid");
  }
  if (expiresAt.getTime() <= (options.now?.getTime() ?? Date.now())) {
    throw new PolicyDeniedError(PolicyDeniedCodes.POLICY_EXPIRED, "policy engine record has expired");
  }
  return { record: normalized, policySignerDid: normalized.signature.signerDid };
}

export async function buildPolicy(input: {
  ownerDid: string;
  signingKeyDid: string;
  resourceType: PolicyResourceType;
  resourceId: string;
  permissionsCeiling: readonly PolicyCapability[];
  when: PolicyWhen;
  grant?: Partial<PolicyGrant>;
  createdAt?: Date | string;
  signer: PolicySigningSource;
}): Promise<Policy> {
  const now = new Date();
  const unsigned = {
    schema: "xyz.tinycloud.policy/policy/v0" as const,
    ownerDid: normalizeDid(input.ownerDid),
    signingKeyDid: normalizeDid(input.signingKeyDid),
    createdAt:
      typeof input.createdAt === "string"
        ? input.createdAt
        : input.createdAt instanceof Date
          ? input.createdAt.toISOString()
          : now.toISOString(),
    resource: {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      permissionsCeiling: canonicalizeCapabilities(input.permissionsCeiling),
    },
    when: cloneDeep(input.when),
    grant: {
      output: "portable-delegation" as const,
      maxTtlSeconds: input.grant?.maxTtlSeconds ?? 300,
      delegationMode: "terminal" as const,
      revocation: input.grant?.revocation ?? "active_cutoff",
    },
  };
  if (input.signer.did !== normalizeDid(input.signingKeyDid)) {
    throw new PolicyValidationError("policy signer DID must match signingKeyDid");
  }
  return buildContentAddressedSignedObject(
    "Policy",
    "xyz.tinycloud.policy/policy/v0",
    "policyId",
    unsigned,
    input.signer,
  ) as unknown as Promise<Policy>;
}

export async function verifyPolicy(policy: Policy): Promise<boolean> {
  const normalized = {
    ...policy,
    ownerDid: normalizeDid(policy.ownerDid),
    signingKeyDid: normalizeDid(policy.signingKeyDid),
    resource: {
      ...policy.resource,
      permissionsCeiling: canonicalizeCapabilities(policy.resource.permissionsCeiling),
    },
  };
  return verifyContentAddressedSignedObject(
    "Policy",
    "xyz.tinycloud.policy/policy/v0",
    "policyId",
    normalized,
  );
}

export async function buildPolicyStatus(input: {
  policyId: string;
  ownerDid: string;
  signingKeyDid: string;
  sequence?: number;
  disposition?: "active" | "revoked";
  effectiveAt?: Date | string;
  reasonCode?: string;
  signer: PolicySigningSource;
}): Promise<PolicyStatus> {
  const unsigned = {
    schema: "xyz.tinycloud.policy/status/v0" as const,
    policyId: input.policyId,
    ownerDid: normalizeDid(input.ownerDid),
    sequence: input.sequence ?? 1,
    disposition: input.disposition ?? "active",
    effectiveAt:
      typeof input.effectiveAt === "string"
        ? input.effectiveAt
        : input.effectiveAt instanceof Date
          ? input.effectiveAt.toISOString()
          : new Date().toISOString(),
    signingKeyDid: normalizeDid(input.signingKeyDid),
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
  };
  if (input.signer.did !== normalizeDid(input.signingKeyDid)) {
    throw new PolicyValidationError("policy status signer DID must match signingKeyDid");
  }
  return buildContentAddressedSignedObject(
    "PolicyStatus",
    "xyz.tinycloud.policy/status/v0",
    "statusId",
    unsigned,
    input.signer,
  ) as unknown as Promise<PolicyStatus>;
}

export async function verifyPolicyStatus(status: PolicyStatus): Promise<boolean> {
  const normalized = {
    ...status,
    ownerDid: normalizeDid(status.ownerDid),
    signingKeyDid: normalizeDid(status.signingKeyDid),
  };
  return verifyContentAddressedSignedObject(
    "PolicyStatus",
    "xyz.tinycloud.policy/status/v0",
    "statusId",
    normalized,
  );
}

export async function buildHolderEnrollment(input: {
  eligibleSubjectDid: string;
  holderDid: string;
  signingKeyDid: string;
  scope?: { policyIds?: string[]; resourceIds?: string[] };
  notBefore?: Date | string;
  expiresAt?: Date | string;
  signer: PolicySigningSource;
}): Promise<HolderEnrollment> {
  const unsigned = {
    schema: "xyz.tinycloud.policy/holder-enrollment/v0" as const,
    eligibleSubjectDid: normalizeDid(input.eligibleSubjectDid),
    holderDid: normalizeDid(input.holderDid),
    ...(input.scope ? { scope: cloneDeep(input.scope) } : {}),
    notBefore:
      typeof input.notBefore === "string"
        ? input.notBefore
        : input.notBefore instanceof Date
          ? input.notBefore.toISOString()
          : new Date().toISOString(),
    ...(input.expiresAt
      ? {
          expiresAt:
            typeof input.expiresAt === "string"
              ? input.expiresAt
              : input.expiresAt.toISOString(),
        }
      : {}),
    signingKeyDid: normalizeDid(input.signingKeyDid),
  };
  if (input.signer.did !== normalizeDid(input.signingKeyDid)) {
    throw new PolicyValidationError("holder enrollment signer DID must match signingKeyDid");
  }
  return buildContentAddressedSignedObject(
    "HolderEnrollment",
    "xyz.tinycloud.policy/holder-enrollment/v0",
    "enrollmentId",
    unsigned,
    input.signer,
  ) as unknown as Promise<HolderEnrollment>;
}

export async function verifyHolderEnrollment(
  enrollment: HolderEnrollment,
): Promise<boolean> {
  const normalized = {
    ...enrollment,
    eligibleSubjectDid: normalizeDid(enrollment.eligibleSubjectDid),
    holderDid: normalizeDid(enrollment.holderDid),
    signingKeyDid: normalizeDid(enrollment.signingKeyDid),
  };
  return verifyContentAddressedSignedObject(
    "HolderEnrollment",
    "xyz.tinycloud.policy/holder-enrollment/v0",
    "enrollmentId",
    normalized,
  );
}

export async function buildHolderEnrollmentStatus(input: {
  enrollmentId: string;
  signingKeyDid: string;
  sequence?: number;
  disposition?: "active" | "revoked";
  effectiveAt?: Date | string;
  signer: PolicySigningSource;
}): Promise<HolderEnrollmentStatus> {
  const unsigned = {
    schema: "xyz.tinycloud.policy/holder-enrollment-status/v0" as const,
    enrollmentId: input.enrollmentId,
    sequence: input.sequence ?? 1,
    disposition: input.disposition ?? "active",
    effectiveAt:
      typeof input.effectiveAt === "string"
        ? input.effectiveAt
        : input.effectiveAt instanceof Date
          ? input.effectiveAt.toISOString()
          : new Date().toISOString(),
    signingKeyDid: normalizeDid(input.signingKeyDid),
  };
  if (input.signer.did !== normalizeDid(input.signingKeyDid)) {
    throw new PolicyValidationError("holder enrollment status signer DID must match signingKeyDid");
  }
  return buildContentAddressedSignedObject(
    "HolderEnrollmentStatus",
    "xyz.tinycloud.policy/holder-enrollment-status/v0",
    "statusId",
    unsigned,
    input.signer,
  ) as unknown as Promise<HolderEnrollmentStatus>;
}

export async function verifyHolderEnrollmentStatus(
  status: HolderEnrollmentStatus,
): Promise<boolean> {
  const normalized = {
    ...status,
    signingKeyDid: normalizeDid(status.signingKeyDid),
  };
  return verifyContentAddressedSignedObject(
    "HolderEnrollmentStatus",
    "xyz.tinycloud.policy/holder-enrollment-status/v0",
    "statusId",
    normalized,
  );
}

export async function buildGrantChallenge(input: {
  policyId: string;
  audience: string;
  acceptedSuites?: PolicySignatureSuite[];
  requestedCapabilitiesTemplate?: readonly PolicyCapability[];
  challengeExpiresAt?: Date | string;
  nonce?: string;
  signer: PolicySigningSource;
  challengeId?: string;
}): Promise<GrantChallenge> {
  const unsigned = {
    schema: "xyz.tinycloud.policy/challenge/v0" as const,
    policyId: input.policyId,
    audience: input.audience,
    nonce: input.nonce ?? randomNonce(),
    challengeExpiresAt:
      typeof input.challengeExpiresAt === "string"
        ? input.challengeExpiresAt
        : input.challengeExpiresAt instanceof Date
          ? input.challengeExpiresAt.toISOString()
          : new Date(Date.now() + ms("5m")).toISOString(),
    acceptedSuites: input.acceptedSuites ?? ["eddsa-ed25519-sha256-jcs-v1"],
    ...(input.requestedCapabilitiesTemplate
      ? { requestedCapabilitiesTemplate: canonicalizeCapabilities(input.requestedCapabilitiesTemplate) }
      : {}),
  };
  return buildContentAddressedSignedObject(
    "GrantChallenge",
    "xyz.tinycloud.policy/challenge/v0",
    "challengeId",
    unsigned,
    input.signer,
  ) as unknown as Promise<GrantChallenge>;
}

export async function verifyGrantChallenge(
  challenge: GrantChallenge,
  expectedSignerDid?: string,
  options: { now?: Date } = {},
): Promise<boolean> {
  const normalized = {
    ...challenge,
    acceptedSuites: [...challenge.acceptedSuites],
    ...(challenge.requestedCapabilitiesTemplate
      ? { requestedCapabilitiesTemplate: canonicalizeCapabilities(challenge.requestedCapabilitiesTemplate) }
      : {}),
  };
  const valid = await verifyContentAddressedSignedObject(
    "GrantChallenge",
    "xyz.tinycloud.policy/challenge/v0",
    "challengeId",
    normalized,
  );
  if (!valid) {
    return false;
  }
  if (expectedSignerDid !== undefined && normalizeDid(challenge.signature.signerDid) !== normalizeDid(expectedSignerDid)) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.CHALLENGE_INVALID,
      "challenge signer does not match policy engine signer",
    );
  }
  const challengeExpiresAt = new Date(challenge.challengeExpiresAt);
  if (Number.isNaN(challengeExpiresAt.getTime()) || challengeExpiresAt.getTime() <= (options.now?.getTime() ?? Date.now())) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.CHALLENGE_EXPIRED,
      "challenge has expired",
    );
  }
  return true;
}

export function buildDomainPolicyRequirement(
  domain: string,
  options: {
    requirementId?: string;
    acceptedIssuers?: string[];
    verifier?: string;
    vct?: string;
  } = {},
): PolicyEvidenceRequirement {
  const normalizedDomain = normalizeEmailDomain(domain);
  return {
    requirementId: options.requirementId ?? "email-domain-allowed",
    verifier: options.verifier ?? "w3c.vc/credential/v1",
    requirements: {
      type: "EmailVerification",
      vct: options.vct ?? "tinycloud.email/v1",
      subject: { binding: "sub-equals-eligibleSubjectDid" },
      claims: {
        emailDomain: { oneOf: [normalizedDomain] },
      },
    },
    authority: {
      acceptedIssuers: (options.acceptedIssuers ?? ["did:web:issuer.tinycloud.xyz"]).map(normalizeDid),
    },
  };
}

export function buildEmailPolicyRequirement(
  email: string,
  options: {
    requirementId?: string;
    acceptedIssuers?: string[];
    verifier?: string;
    vct?: string;
  } = {},
): PolicyEvidenceRequirement {
  const normalizedEmail = normalizeEmail(email);
  return {
    requirementId: options.requirementId ?? "email-allowed",
    verifier: options.verifier ?? "w3c.vc/credential/v1",
    requirements: {
      type: "EmailVerification",
      vct: options.vct ?? "tinycloud.email/v1",
      subject: { binding: "sub-equals-eligibleSubjectDid" },
      claims: {
        email: { oneOf: [normalizedEmail] },
      },
    },
    authority: {
      acceptedIssuers: (options.acceptedIssuers ?? ["did:web:issuer.tinycloud.xyz"]).map(normalizeDid),
    },
  };
}

function buildListenTranscriptSqlStatements(conversationId: string): ListenTranscriptSqlInvokeRequest[] {
  return [
    {
      name: "listen.getConversation",
      sql:
        "SELECT id, title, source, source_id, source_url, started_at, ended_at, duration_secs, summary, metadata, transcript_json, transcript_text, created_at, updated_at FROM conversation WHERE id = ?",
      fixedParams: [{ index: 0, value: conversationId }],
    },
    {
      name: "listen.listParticipants",
      sql:
        "SELECT id, name, email, speaker_label FROM participant WHERE conversation_id = ? ORDER BY COALESCE(speaker_label, name), id",
      fixedParams: [{ index: 0, value: conversationId }],
    },
  ];
}

function buildListenTranscriptCaveats(conversationId: string): Record<string, unknown> {
  return {
    mode: "constrained-statements",
    readOnly: true,
    statements: buildListenTranscriptSqlStatements(conversationId).map(({ name, sql, fixedParams }) => ({
      name,
      sql,
      fixedParams: fixedParams.map((param) => ({ index: param.index, value: param.value })),
    })),
  };
}

export function buildListenTranscriptSqlInvokeRequests(
  conversationId: string,
): ListenTranscriptSqlInvokeRequest[] {
  return buildListenTranscriptSqlStatements(conversationId).map((statement) => ({
    ...statement,
    fixedParams: statement.fixedParams.map((param) => ({ ...param })),
  }));
}

export async function executeListenTranscriptSqlRequests(
  sql: ISQLService | IDatabaseHandle,
  requests: readonly ListenTranscriptSqlInvokeRequest[],
): Promise<Array<QueryResponse | ExecuteResponse>> {
  const db = typeof (sql as ISQLService).db === "function" ? (sql as ISQLService).db() : (sql as IDatabaseHandle);
  const results: Array<QueryResponse | ExecuteResponse> = [];

  for (const request of requests) {
    const params: SqlValue[] = [];
    for (const { index, value } of request.fixedParams) {
      params[index] = value;
    }
    const result = await db.executeStatement(request.name, params);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    results.push(result.data as QueryResponse | ExecuteResponse);
  }

  return results;
}

export function buildListenTranscriptPolicyCapability(
  conversationId: string,
  input: {
    capability?: PermissionEntry | PolicyCapability;
    space?: string;
  } = {},
): PolicyCapability {
  const normalizedSpace = input.capability && "space" in input.capability && typeof input.capability.space === "string"
    ? input.capability.space
    : (input.space ?? "applications");
  const supplied: PolicyCapability = input.capability
    ? {
        service: (input.capability as PermissionEntry).service,
        space: normalizedSpace,
        path: (input.capability as PermissionEntry).path,
        actions: [...(input.capability as PermissionEntry).actions],
        ...("caveats" in input.capability && (input.capability as PolicyCapability).caveats !== undefined
          ? { caveats: cloneDeep((input.capability as PolicyCapability).caveats) }
          : {}),
      }
    : {
        service: "tinycloud.sql",
        space: normalizedSpace,
        path: "xyz.tinycloud.listen/conversations",
        actions: ["tinycloud.sql/read"],
        caveats: buildListenTranscriptCaveats(conversationId),
      };

  const normalized = normalizePolicyCapability(supplied);
  if (normalized.service !== "tinycloud.sql") {
    throw new PolicyValidationError("listen transcript policy capability must target tinycloud.sql");
  }
  if (normalized.path !== "xyz.tinycloud.listen/conversations") {
    throw new PolicyValidationError("listen transcript policy capability path is incorrect");
  }
  if (normalized.actions.length !== 1 || normalized.actions[0] !== "tinycloud.sql/read") {
    throw new PolicyValidationError("listen transcript policy capability must be read-only");
  }

  const expectedCaveats = buildListenTranscriptCaveats(conversationId);
  if (normalized.caveats === undefined) {
    normalized.caveats = expectedCaveats;
    return normalized;
  }
  const caveatsCanonical = canonicalizeEncryptionJson(normalized.caveats as never);
  const expectedCanonical = canonicalizeEncryptionJson(expectedCaveats as never);
  if (caveatsCanonical !== expectedCanonical) {
    throw new PolicyValidationError("listen transcript capability caveats do not match the canonical transcript SQL shape");
  }
  normalized.caveats = expectedCaveats;
  return normalized;
}

export async function buildGrantPresentation(input: {
  policy: Policy;
  challenge: GrantChallenge;
  eligibleSubjectDid: string;
  holderDid: string;
  holderBinding: HolderBindingProof;
  holderSigner: PolicySigningSource;
  evidence?: GrantPresentationEvidence[];
  requestedCapabilities?: readonly PolicyCapability[];
  expiresAt?: Date | string;
}): Promise<GrantPresentation> {
  const eligibleSubjectDid = normalizeDid(input.eligibleSubjectDid);
  const holderDid = normalizeDid(input.holderDid);
  if (input.holderSigner.did !== holderDid) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.HOLDER_SIGNATURE_SIGNER_MISMATCH,
      "holder signer DID must equal holderDid",
    );
  }
  if (normalizeDid(input.challenge.policyId) !== normalizeDid(input.policy.policyId)) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.CHALLENGE_INVALID,
      "challenge policyId does not match the policy",
    );
  }
  const requestedCapabilities = canonicalizeCapabilities(
    input.requestedCapabilities ?? input.policy.resource.permissionsCeiling,
  );
  assertRequestedCapabilitiesWithinPolicy(
    requestedCapabilities,
    input.policy.resource.permissionsCeiling,
  );
  const requestedCapabilitiesHash = await requestedCapabilitiesHashHex(
    requestedCapabilities,
  );

  const evidenceRequirement = input.policy.when.evidence;
  if (evidenceRequirement !== undefined) {
    const evidence = input.evidence ?? [];
    if (evidence.length === 0) {
      throw new PolicyDeniedError(
        PolicyDeniedCodes.PRESENTATION_EVIDENCE_MISSING,
        "policy requires evidence",
      );
    }
    const seen = new Set<string>();
    for (const entry of evidence) {
      if (entry.requirementId === evidenceRequirement.requirementId) {
        if (seen.has(entry.requirementId)) {
          throw new PolicyDeniedError(
            PolicyDeniedCodes.EVIDENCE_REQUIREMENT_DUPLICATE,
            "duplicate evidence requirement",
          );
        }
        seen.add(entry.requirementId);
      } else {
        throw new PolicyDeniedError(
          PolicyDeniedCodes.EVIDENCE_REQUIREMENT_UNKNOWN,
          `unknown evidence requirement: ${entry.requirementId}`,
        );
      }
    }
    if (!seen.has(evidenceRequirement.requirementId)) {
      throw new PolicyDeniedError(
        PolicyDeniedCodes.PRESENTATION_EVIDENCE_MISSING,
        "policy evidence requirement was not satisfied",
      );
    }
  }

  validateHolderBinding(input.holderBinding, eligibleSubjectDid, holderDid, input.policy);

  const expiresAt =
    typeof input.expiresAt === "string"
      ? input.expiresAt
      : input.expiresAt instanceof Date
        ? input.expiresAt.toISOString()
        : new Date(Date.parse(input.challenge.challengeExpiresAt) - 30_000).toISOString();

  const unsigned: Omit<GrantPresentation, "holderSignature"> = {
    schema: "xyz.tinycloud.policy/presentation/v0",
    policyId: input.policy.policyId,
    eligibleSubjectDid,
    holderDid,
    holderBinding: cloneDeep(input.holderBinding),
    requestedCapabilities,
    requestedCapabilitiesHash,
    audience: input.challenge.audience,
    nonce: input.challenge.nonce,
    expiresAt,
    ...(input.evidence ? { evidence: cloneDeep(input.evidence) } : {}),
  };

  if (!input.challenge.acceptedSuites.includes(signatureSuiteForSigner(input.holderSigner))) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.VERIFIER_UNSUPPORTED,
      "holder signer suite is not accepted by the challenge",
    );
  }

  const digest = await digestCanonicalJson("xyz.tinycloud.policy/GrantPresentation/v0\0", unsigned);
  const holderSignature = await signDigest(digest, input.holderSigner);

  return {
    ...unsigned,
    holderSignature,
  };
}

export async function verifyGrantPresentation(
  presentation: GrantPresentation,
  options: {
    expectedSignerDid?: string;
    expectedAudience?: string;
    expectedPolicyId?: string;
    now?: Date;
  } = {},
): Promise<boolean> {
  if (options.expectedPolicyId !== undefined && normalizeDid(options.expectedPolicyId) !== normalizeDid(presentation.policyId)) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.PRESENTATION_INVALID,
      "presentation policyId mismatch",
    );
  }
  if (options.expectedAudience !== undefined && normalizeDid(options.expectedAudience) !== normalizeDid(presentation.audience)) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.PRESENTATION_AUDIENCE_MISMATCH,
      "presentation audience mismatch",
    );
  }
  if (options.expectedSignerDid !== undefined && normalizeDid(options.expectedSignerDid) !== normalizeDid(presentation.holderSignature.signerDid)) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.HOLDER_SIGNATURE_SIGNER_MISMATCH,
      "holderSignature.signerDid does not match holderDid",
    );
  }
  const unsigned: Record<string, unknown> = { ...presentation };
  delete unsigned.holderSignature;
  const expectedRequestedCapabilitiesHash = await requestedCapabilitiesHashHex(
    presentation.requestedCapabilities,
  );
  if (expectedRequestedCapabilitiesHash !== presentation.requestedCapabilitiesHash) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.PRESENTATION_INVALID,
      "presentation requestedCapabilitiesHash does not match requestedCapabilities",
    );
  }
  const digest = await digestCanonicalJson("xyz.tinycloud.policy/GrantPresentation/v0\0", unsigned);
  const holderSignature = presentation.holderSignature;
  const valid = await verifyDigestSignature(digest, holderSignature);
  if (!valid) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.HOLDER_SIGNATURE_INVALID,
      "holder signature verification failed",
    );
  }
  const expiresAt = new Date(presentation.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= (options.now?.getTime() ?? Date.now())) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.PRESENTATION_EXPIRED,
      "presentation has expired",
    );
  }
  return true;
}

function signatureSuiteForSigner(signer: PolicySigningSource): PolicySignatureSuite {
  return signer.kind === "did:key"
    ? "eddsa-ed25519-sha256-jcs-v1"
    : "eip191-secp256k1-sha256-jcs-v1";
}

function validateHolderBinding(
  holderBinding: HolderBindingProof,
  eligibleSubjectDid: string,
  holderDid: string,
  policy: Policy,
): void {
  if (holderBinding.type === "session-chain") {
    if (!Array.isArray(holderBinding.chain) || holderBinding.chain.length === 0) {
      throw new PolicyValidationError("holder binding chain must be non-empty");
    }
    return;
  }

  const enrollment = holderBinding.enrollment;
  if (normalizeDid(enrollment.eligibleSubjectDid) !== eligibleSubjectDid) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.ELIGIBLE_SUBJECT_NOT_AUTHORIZED,
      "holder enrollment eligibleSubjectDid mismatch",
    );
  }
  if (normalizeDid(enrollment.holderDid) !== holderDid) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.HOLDER_NOT_AUTHORIZED,
      "holder enrollment holderDid mismatch",
    );
  }
  if (enrollment.scope?.policyIds && enrollment.scope.policyIds.length > 0 && !enrollment.scope.policyIds.includes(policy.policyId)) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.ELIGIBLE_SUBJECT_NOT_AUTHORIZED,
      "holder enrollment scope does not include the policy",
    );
  }
  if (enrollment.scope?.resourceIds && enrollment.scope.resourceIds.length > 0 && !enrollment.scope.resourceIds.includes(policy.resource.resourceId)) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.ELIGIBLE_SUBJECT_NOT_AUTHORIZED,
      "holder enrollment scope does not include the resource",
    );
  }
  if (holderBinding.status !== undefined && holderBinding.status.enrollmentId !== enrollment.enrollmentId) {
    throw new PolicyDeniedError(
      PolicyDeniedCodes.EVIDENCE_STATUS_STALE,
      "holder enrollment status does not belong to the enrollment",
    );
  }
}

interface PolicyEngineDelegationResponse {
  delegationId: string;
  issuerDid: string;
  holderDid: string;
  policyId: string;
  capabilities: PolicyCapability[];
  issuedAt: string;
  expiresAt: string;
  terminal: boolean;
  encoded: string;
}

function toAuthorizationHeader(value: string): string {
  return /^Bearer\s+/i.test(value) ? value : `Bearer ${value}`;
}

function capabilityToDelegatedResource(capability: PolicyCapability): DelegatedResource {
  const shortService = SERVICE_LONG_TO_SHORT[capability.service];
  if (shortService === undefined) {
    throw new PolicyValidationError(
      `unsupported service in delegated capability: ${capability.service}`,
    );
  }
  return {
    service: shortService,
    space: capability.space,
    path: capability.path,
    actions: [...capability.actions],
  };
}

function normalizePolicyEngineDelegationResponse(input: unknown): PolicyEngineDelegationResponse {
  if (typeof input !== "object" || input === null) {
    throw new PolicyValidationError("delegation response must be an object");
  }
  const value = input as Record<string, unknown>;
  const capabilitiesValue = value.capabilities;
  if (!Array.isArray(capabilitiesValue) || capabilitiesValue.length === 0) {
    throw new PolicyValidationError("delegation response capabilities are missing");
  }
  const capabilities = canonicalizeCapabilities(capabilitiesValue as PolicyCapability[]);
  const firstSpace = capabilities[0]?.space;
  if (firstSpace === undefined) {
    throw new PolicyValidationError("delegation response capabilities are missing a space");
  }
  for (const capability of capabilities) {
    if (capability.space !== firstSpace) {
      throw new PolicyValidationError("delegation response capabilities must target one space");
    }
  }
  const delegationId = value.delegationId;
  const issuerDid = value.issuerDid;
  const holderDid = value.holderDid;
  const policyId = value.policyId;
  const issuedAt = value.issuedAt;
  const expiresAt = value.expiresAt;
  const terminal = value.terminal;
  const encoded = value.encoded;
  if (
    typeof delegationId !== "string" ||
    typeof issuerDid !== "string" ||
    typeof holderDid !== "string" ||
    typeof policyId !== "string" ||
    typeof issuedAt !== "string" ||
    typeof expiresAt !== "string" ||
    typeof terminal !== "boolean" ||
    typeof encoded !== "string"
  ) {
    throw new PolicyValidationError("delegation response is malformed");
  }
  return {
    delegationId,
    issuerDid: normalizeDid(issuerDid),
    holderDid: normalizeDid(holderDid),
    policyId,
    capabilities,
    issuedAt,
    expiresAt,
    terminal,
    encoded,
  };
}

function ownerAddressFromDid(ownerDid: string): { ownerAddress: string; chainId: number } {
  const parsed = parsePkhDid(ownerDid);
  if (!parsed) {
    return { ownerAddress: normalizeDid(ownerDid), chainId: 1 };
  }
  return { ownerAddress: parsed.address, chainId: parsed.chainId };
}

function buildPolicyPortableDelegationFromResponse(
  response: PolicyEngineDelegationResponse,
  record: PolicyEngineRecord,
): PolicyPortableDelegation {
  const resources = response.capabilities.map(capabilityToDelegatedResource);
  const primary = resources[0];
  const { ownerAddress, chainId } = ownerAddressFromDid(record.ownerDid);
  const authorization = toAuthorizationHeader(response.encoded);
  return {
    cid: response.delegationId,
    delegateDID: response.holderDid,
    delegatorDID: response.issuerDid,
    spaceId: primary.space,
    path: primary.path,
    actions: [...primary.actions],
    expiry: new Date(response.expiresAt),
    createdAt: new Date(response.issuedAt),
    allowSubDelegation: !response.terminal,
    disableSubDelegation: response.terminal,
    delegationHeader: { Authorization: authorization },
    authHeader: authorization,
    ownerAddress,
    chainId,
    host: record.endpoint,
    resources,
  };
}

function parsePolicyError(input: unknown, fallbackCode: PolicyDeniedCode): PolicyDeniedError {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : typeof record.error === "object" && record.error !== null && typeof (record.error as Record<string, unknown>).code === "string"
      ? (record.error as Record<string, unknown>).code
      : fallbackCode;
    const message = typeof record.message === "string" ? record.message : typeof record.error === "object" && record.error !== null && typeof (record.error as Record<string, unknown>).message === "string"
      ? (record.error as Record<string, unknown>).message
      : String(code);
    return new PolicyDeniedError(code as PolicyDeniedCode, message, input);
  }
  return new PolicyDeniedError(fallbackCode, String(input ?? fallbackCode), input);
}

export class PolicyEngineHttpClient implements PolicyEngineClient {
  public readonly record: PolicyEngineRecord;
  public policySignerDid: string;
  private readonly fetchFn: typeof fetch;

  constructor(record: PolicyEngineRecord, options: { fetch?: typeof fetch; now?: Date } = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.record = record;
    this.policySignerDid = record.signature.signerDid;
  }

  private async verifiedRecord(now?: Date): Promise<VerifiedPolicyEngineRecord> {
    const verified = await verifyPolicyEngineRecord(this.record, { now });
    this.policySignerDid = verified.policySignerDid;
    return verified;
  }

  async challenge(input: { policyId: string; now?: Date }): Promise<GrantChallenge> {
    const verified = await this.verifiedRecord(input.now);
    const response = await this.fetchFn(`${verified.record.endpoint.replace(/\/$/, "")}/policy/v0/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policyId: input.policyId, now: input.now?.toISOString() }),
    });
    const body = await safeJson(response);
    if (!response.ok) {
      throw parsePolicyError(body, PolicyDeniedCodes.CHALLENGE_INVALID);
    }
    if (typeof body !== "object" || body === null || !("challenge" in body)) {
      throw new PolicyValidationError("challenge response missing challenge");
    }
    const challenge = (body as { challenge: GrantChallenge }).challenge;
    await verifyGrantChallenge(challenge, verified.policySignerDid, { now: input.now });
    if (normalizeDid(challenge.policyId) !== normalizeDid(input.policyId)) {
      throw new PolicyDeniedError(
        PolicyDeniedCodes.CHALLENGE_INVALID,
        "challenge policyId does not match request",
      );
    }
    return challenge;
  }

  async resolve(input: { presentation: GrantPresentation; now?: Date }): Promise<PolicyPortableDelegation> {
    const verified = await this.verifiedRecord(input.now);
    const response = await this.fetchFn(`${verified.record.endpoint.replace(/\/$/, "")}/policy/v0/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presentation: input.presentation, now: input.now?.toISOString() }),
    });
    const body = await safeJson(response);
    if (!response.ok) {
      throw parsePolicyError(body, PolicyDeniedCodes.GRANT_ISSUANCE_FAILED);
    }
    if (typeof body !== "object" || body === null || !("delegation" in body)) {
      throw new PolicyValidationError("resolve response missing delegation");
    }
    const delegation = normalizePolicyEngineDelegationResponse((body as { delegation: unknown }).delegation);
    if (delegation.policyId !== input.presentation.policyId) {
      throw new PolicyDeniedError(
        PolicyDeniedCodes.GRANT_ISSUANCE_FAILED,
        "returned delegation policyId does not match the presentation",
      );
    }
    if (normalizeDid(delegation.holderDid) !== normalizeDid(input.presentation.holderDid)) {
      throw new PolicyDeniedError(
        PolicyDeniedCodes.GRANT_ISSUANCE_FAILED,
        "returned delegation does not target the presentation holder",
      );
    }
    const expectedRequestedCapabilitiesHash = await requestedCapabilitiesHashHex(
      delegation.capabilities,
    );
    if (expectedRequestedCapabilitiesHash !== input.presentation.requestedCapabilitiesHash) {
      throw new PolicyDeniedError(
        PolicyDeniedCodes.REQUESTED_CAPABILITIES_EXCEEDED,
        "returned delegation capabilities do not match the requested capabilities",
      );
    }
    if (delegation.issuerDid !== verified.record.grantIssuerDid) {
      throw new PolicyDeniedError(
        PolicyDeniedCodes.GRANT_ISSUANCE_FAILED,
        "returned delegation issuer does not match the policy engine grant issuer",
      );
    }
    return buildPolicyPortableDelegationFromResponse(delegation, verified.record);
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return undefined;
    }
  }
}

export function createPolicyEngineHttpClient(
  record: PolicyEngineRecord,
  options: { fetch?: typeof fetch; now?: Date } = {},
): PolicyEngineHttpClient {
  return new PolicyEngineHttpClient(record, options);
}

export async function buildPolicyShareOwnerSetup(
  input: PolicyShareOwnerSetupInput,
): Promise<PolicyShareSetup> {
  const verifiedEngineRecord = await verifyPolicyEngineRecord(input.policyEngineRecord);
  const normalizedTarget = normalizePolicyShareTarget(input.target);
  const capability = buildListenTranscriptPolicyCapability(input.conversationId, {
    capability: input.capability,
    space: input.space,
  });
  const policy = await buildPolicy({
    ownerDid: input.ownerDid,
    signingKeyDid: input.policySigner.did,
    resourceType: "collection",
    resourceId: input.conversationId,
    permissionsCeiling: [capability],
    when: {
      evidence:
        normalizedTarget.kind === "domain"
          ? buildDomainPolicyRequirement(normalizedTarget.value, {
              acceptedIssuers: input.acceptedIssuers,
            })
          : buildEmailPolicyRequirement(normalizedTarget.value, {
              acceptedIssuers: input.acceptedIssuers,
            }),
    },
    grant: {
      maxTtlSeconds: input.maxTtlSeconds ?? 300,
      revocation: input.revocation ?? "active_cutoff",
    },
    createdAt: input.policyCreatedAt,
    signer: input.policySigner,
  });
  const policyStatus = await buildPolicyStatus({
    policyId: policy.policyId,
    ownerDid: input.ownerDid,
    signingKeyDid: input.policySigner.did,
    disposition: input.policyStatusDisposition ?? "active",
    reasonCode: input.policyStatusReasonCode,
    signer: input.policySigner,
  });
  const ownerDelegationExpiry = Math.min(
    (input.maxTtlSeconds ?? 300) * 1000,
    Math.max(0, new Date(verifiedEngineRecord.record.expiresAt).getTime() - Date.now()),
  );
  const nativePermission: PermissionEntry = {
    service: capability.service,
    space: capability.space,
    path: capability.path,
    actions: [...capability.actions],
  };
  const ownerDelegationResult = await input.delegationAuthority.delegateTo(
    verifiedEngineRecord.record.grantIssuerDid,
    [nativePermission],
    ownerDelegationExpiry > 0 ? { expiry: ownerDelegationExpiry } : undefined,
  );
  const requestedCapabilitiesHash = await requestedCapabilitiesHashHex([capability]);
  return {
    conversationId: input.conversationId,
    target: normalizedTarget,
    capability,
    policy,
    policyStatus,
    ownerDelegation: ownerDelegationResult.delegation,
    ownerDelegationPrompted: ownerDelegationResult.prompted,
    policyEngineRecord: verifiedEngineRecord.record,
    requestedCapabilitiesHash,
  };
}

export function buildHolderBindingProof(
  enrollment: HolderEnrollment,
  status?: HolderEnrollmentStatus,
): HolderBindingProof {
  return status === undefined
    ? { type: "enrolled-agent", enrollment }
    : { type: "enrolled-agent", enrollment, status };
}

export class PolicySharingController {
  private readonly setup: PolicyShareSetup;
  private readonly engine: PolicyEngineClient;
  private readonly eligibleSubjectDid: string;
  private readonly holderDid: string;
  private readonly holderSigner: PolicySigningSource;
  private readonly holderBinding: HolderBindingProof;
  private readonly replayStore: PolicyReplayStore;
  private readonly now: () => Date;

  constructor(options: PolicySharingControllerOptions) {
    this.setup = options.setup;
    this.engine = options.engine;
    this.eligibleSubjectDid = normalizeDid(options.eligibleSubjectDid);
    this.holderDid = normalizeDid(options.holderDid);
    this.holderSigner = options.holderSigner;
    this.holderBinding = options.holderBinding;
    this.replayStore = options.replayStore ?? new InMemoryPolicyReplayStore();
    this.now = options.now ?? (() => new Date());
  }

  async startChallenge(): Promise<GrantChallenge> {
    await verifyPolicy(this.setup.policy);
    if (this.setup.policy.when.evidence?.verifier !== undefined) {
      if (!this.engine.record.supportedEvidenceVerifiers.includes(this.setup.policy.when.evidence.verifier)) {
        throw new PolicyDeniedError(
          PolicyDeniedCodes.VERIFIER_UNSUPPORTED,
          `policy engine does not support evidence verifier ${this.setup.policy.when.evidence.verifier}`,
        );
      }
    }
    return this.engine.challenge({
      policyId: this.setup.policy.policyId,
      now: this.now(),
    });
  }

  async buildPresentation(
    challenge: GrantChallenge,
    input: {
      evidence?: GrantPresentationEvidence[];
      requestedCapabilities?: readonly PolicyCapability[];
      expiresAt?: Date | string;
    } = {},
  ): Promise<GrantPresentation> {
    return buildGrantPresentation({
      policy: this.setup.policy,
      challenge,
      eligibleSubjectDid: this.eligibleSubjectDid,
      holderDid: this.holderDid,
      holderBinding: this.holderBinding,
      holderSigner: this.holderSigner,
      evidence: input.evidence,
      requestedCapabilities: input.requestedCapabilities,
      expiresAt: input.expiresAt,
    });
  }

  async resolvePresentation(presentation: GrantPresentation): Promise<PolicyPortableDelegation> {
    const replayKey = `${presentation.policyId}:${presentation.nonce}`;
    if (!this.replayStore.consume(replayKey)) {
      throw new PolicyDeniedError(
        PolicyDeniedCodes.CHALLENGE_NONCE_CONSUMED,
        "presentation nonce has already been consumed locally",
      );
    }
    await verifyGrantPresentation(presentation, {
      expectedSignerDid: this.holderDid,
      expectedAudience: this.setup.policyEngineRecord.audience,
      expectedPolicyId: this.setup.policy.policyId,
      now: this.now(),
    });
    return this.engine.resolve({
      presentation,
      now: this.now(),
    });
  }

  async share(
    input: {
      evidence?: GrantPresentationEvidence[];
      requestedCapabilities?: readonly PolicyCapability[];
      expiresAt?: Date | string;
    } = {},
  ): Promise<PolicyChallengeResolution> {
    const challenge = await this.startChallenge();
    const presentation = await this.buildPresentation(challenge, input);
    const delegation = await this.resolvePresentation(presentation);
    return { challenge, presentation, delegation };
  }

  async installDelegation(runtime: PolicyDelegationRuntime, delegation: PolicyPortableDelegation): Promise<unknown> {
    return installPolicyDelegation(runtime, delegation);
  }
}

export function createPolicySharingController(
  options: PolicySharingControllerOptions,
): PolicySharingController {
  return new PolicySharingController(options);
}

export async function installPolicyDelegation(
  runtime: PolicyDelegationRuntime,
  delegation: PolicyPortableDelegation,
): Promise<unknown> {
  if (typeof runtime.useDelegation === "function") {
    return runtime.useDelegation(delegation);
  }
  if (typeof runtime.useRuntimeDelegation === "function") {
    await runtime.useRuntimeDelegation(delegation);
    return undefined;
  }
  throw new PolicyValidationError("runtime does not expose delegation installation APIs");
}

export const usePolicyDelegation = installPolicyDelegation;
