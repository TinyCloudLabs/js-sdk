import {
  CredentialError,
  canonicalDigest,
  createEmailCredentialRequirement,
  credentialError,
  credentialRequirementDigest,
  descriptorSatisfiesRequirement,
  encodeBase64Url,
  sha256Base64Url,
  validateCredentialFlowDescriptor,
  verifyIssuedCredential,
  type CredentialFlowDescriptor,
  type CredentialIssuerMetadata,
  type CredentialRequirement,
  type IssuedCredentialEnvelope,
  type IssuerVerificationKey,
  type VerifiedCredential,
} from "@tinycloud/sdk-core";
import { interpretCredentialFlow } from "./interpreter";
import { OpenCredentialsHttpTransport } from "./transport";
import type { CredentialSigningAdapter, PrimitiveStepHandler } from "./types";

/** The only network origin this helper contacts. */
export const EMAIL_PROOF_WITNESS_ORIGIN = "https://witness.credentials.org";
export const EMAIL_PROOF_CREDENTIAL_TYPE = { id: "opencredentials.email/v1", version: 1 } as const;
/** A pending request is never trusted beyond this window, regardless of the server expiry. */
export const EMAIL_PROOF_PENDING_MAX_MS = 15 * 60_000;

const DISCOVERY_URL = `${EMAIL_PROOF_WITNESS_ORIGIN}/.well-known/opencredentials`;

/** Pinned OpenCredentials email issuer. Credentials verify only against this DID and key, never keys the witness serves. */
const EMAIL_PROOF_ISSUER_DID = "did:web:issuer.credentials.org";
const EMAIL_PROOF_ISSUER_KEYS: readonly IssuerVerificationKey[] = [
  {
    kid: `${EMAIL_PROOF_ISSUER_DID}#controller`,
    alg: "EdDSA",
    jwk: { kty: "OKP", crv: "Ed25519", x: "eEJI4xEobto4HtQ7Pg9R1vBOwcpfGRTlXDG5QfqLnGQ" },
    validFrom: "2020-01-01T00:00:00Z",
    validUntil: "2100-01-01T00:00:00Z",
  },
];

/** Email-proof profiles this SDK can run, each pinned to its descriptor digest. Only enabled entries are accepted. */
export type EmailProofProfileId = "tinycloud.email-proof/v1";
export const DEFAULT_EMAIL_PROOF_PROFILE: EmailProofProfileId = "tinycloud.email-proof/v1";
const EMAIL_PROOF_PROFILES: Readonly<Record<EmailProofProfileId, { readonly descriptorDigest: string; readonly enabled: boolean }>> = {
  "tinycloud.email-proof/v1": { descriptorDigest: "1tg-qphmKBVtNwzVg9xyz-xxqt_xtMXAsQyXw46m8S0", enabled: true },
};

const OPENER_ORIGIN = "https://localhost";
const STEP_TIMEOUT_MS = 60_000;
const HOLDER_DID_PATTERN = /^did:key:z6Mk[^#]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Fetch an OpenCredentials catalog and return the first enabled, ready profile
 * whose descriptor satisfies the requirement and matches its catalog digest.
 */
async function discoverCatalogDescriptor(
  requirement: CredentialRequirement,
  discoveryUrl: string,
  options: { readonly fetch?: typeof fetch; readonly signal?: AbortSignal } = {},
): Promise<CredentialFlowDescriptor> {
  let url: URL; try { url = new URL(discoveryUrl); } catch { throw new CredentialError("UNSUPPORTED_PROFILE", "Discovery URL is invalid"); }
  if (url.protocol !== "https:" || !["/.well-known/opencredentials", "/v1/credential-types"].includes(url.pathname) || url.search || url.hash) throw new CredentialError("UNSUPPORTED_PROFILE", "Discovery URL is not an allowed catalog endpoint");
  let response: Response;
  try { response = await (options.fetch ?? globalThis.fetch.bind(globalThis))(url, { credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: options.signal }); } catch (cause) { throw new CredentialError("OFFLINE", "Credential discovery is unavailable", { cause }); }
  if (!response.ok) throw new CredentialError(response.status === 503 ? "ISSUER_UNREADY" : "OFFLINE", "Credential discovery is unavailable");
  const catalog = await response.json() as Record<string, unknown>;
  if (catalog.type !== "tinycloud.credentials/catalog/v1" || catalog.protocol !== "tinycloud.credentials/acquisition/v1" || catalog.catalogVersion !== 1 || !Array.isArray(catalog.profiles)) throw new CredentialError("DESCRIPTOR_INVALID", "Credential catalog is invalid");
  for (const entryValue of catalog.profiles) {
    if (typeof entryValue !== "object" || entryValue === null || Array.isArray(entryValue)) continue;
    const entry = entryValue as Record<string, unknown>;
    if (entry.supported !== true || entry.enabled !== true || (entry.readiness !== "ready" && entry.readiness !== "degraded")) continue;
    try { const candidate = validateCredentialFlowDescriptor(entry.descriptor); if (descriptorSatisfiesRequirement(candidate, requirement) && entry.descriptorDigest === await canonicalDigest(candidate)) return candidate; } catch { /* malformed catalog entry: skip */ }
  }
  throw new CredentialError("UNSUPPORTED_PROFILE", "No available credential profile satisfies the requirement");
}

/** Which part of the two-step flow failed. */
export type EmailProofStep = "request" | "code" | "credential" | "session";

export type EmailProofErrorCode =
  | "ADDRESS_INVALID"
  | "HOLDER_INVALID"
  | "CODE_INVALID"
  | "RATE_LIMITED"
  | "ISSUER_UNAVAILABLE"
  | "NETWORK"
  | "PROFILE_UNAVAILABLE"
  | "CODE_REJECTED"
  | "CODE_ATTEMPTS_EXHAUSTED"
  | "SIGNATURE_REJECTED"
  | "CREDENTIAL_INVALID"
  | "SESSION_EXPIRED"
  | "SESSION_INVALID"
  | "CANCELED"
  | "FAILED";

const MESSAGES: Record<EmailProofErrorCode, string> = {
  ADDRESS_INVALID: "Email address is invalid.",
  HOLDER_INVALID: "Holder must be a did:key Ed25519 identifier.",
  CODE_INVALID: "Verification code must be 8 digits.",
  RATE_LIMITED: "Too many codes were requested for this address. Try again in about an hour.",
  ISSUER_UNAVAILABLE: "Email verification is unavailable right now.",
  NETWORK: "Could not reach the email verification service.",
  PROFILE_UNAVAILABLE: "The witness does not offer the email verification profile.",
  CODE_REJECTED: "Verification code was not accepted.",
  CODE_ATTEMPTS_EXHAUSTED: "Too many wrong codes. Request a new code.",
  SIGNATURE_REJECTED: "Holder signature was rejected.",
  CREDENTIAL_INVALID: "Issued credential failed verification.",
  SESSION_EXPIRED: "Email verification request expired. Request a new code.",
  SESSION_INVALID: "Email verification request is no longer valid. Request a new code.",
  CANCELED: "Email verification was canceled.",
  FAILED: "Email verification failed.",
};

/**
 * Stable, redaction-safe error. `message` is derived from `code`; it never
 * includes the code, verifier, or key material. `recoverable` is true only when
 * the same pending request may be retried with another code before it expires.
 */
export class EmailProofError extends Error {
  readonly name = "EmailProofError";

  constructor(
    readonly step: EmailProofStep,
    readonly code: EmailProofErrorCode,
    readonly retryAfterMs?: number,
    readonly recoverable: boolean = false,
  ) {
    super(code === "RATE_LIMITED" ? rateLimitMessage(retryAfterMs) : MESSAGES[code]);
  }
}

export type HolderAlgorithm = "EdDSA" | "EIP191";

/**
 * Holder key adapter. `sign` MUST return a signature over exactly the bytes it is
 * given: no extra hashing, prefixing, or domain separation. `kid` identifies the
 * key the witness verifies against. `completeEmailProof` rejects with
 * SESSION_INVALID unless `did === pending.holderDid`.
 */
export interface HolderSigner {
  readonly did: string;
  readonly alg: HolderAlgorithm;
  readonly kid: string;
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
}

/** Ed25519 did:key holder. `kid` is `<did>#<multibase key>`. Only this algorithm is implemented. */
export function createEd25519HolderSigner(did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array>): HolderSigner {
  if (!HOLDER_DID_PATTERN.test(did)) throw new EmailProofError("request", "HOLDER_INVALID");
  return { did, alg: "EdDSA", kid: holderKid(did), sign };
}

export interface EmailProofOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  /** Test seam: verify against these issuer keys instead of the pinned production key. Production callers MUST NOT set this. */
  readonly issuerKeys?: readonly IssuerVerificationKey[];
}

export interface EmailProofRequestInput extends EmailProofOptions {
  readonly address: string;
  readonly holder: HolderSigner;
  readonly profile?: EmailProofProfileId;
}

/** Durable state between `requestEmailProofCode` and `completeEmailProof`. The verifier is a bearer secret: store it 0600. */
export interface EmailProofPending {
  readonly type: "TinyCloudEmailProofPending";
  readonly version: 1;
  readonly profile: EmailProofProfileId;
  readonly address: string;
  readonly requestId: string;
  readonly verifier: string;
  readonly holderDid: string;
  readonly descriptorDigest: string;
  readonly requirementDigest: string;
  readonly openerOrigin: string;
  readonly expiresAt: string;
}

/**
 * Holds pending requests between calls. `save` replaces any pending request for
 * the same address. `load` returns the unexpired request for `address`, or undefined.
 */
export interface EmailProofPendingStore {
  load(address: string, now: Date): Promise<EmailProofPending | undefined>;
  save(pending: EmailProofPending): Promise<void>;
  delete(pending: EmailProofPending): Promise<void>;
}

/** Process-local pending store for browsers and tests. Nothing survives a reload. */
export function createMemoryEmailProofPendingStore(): EmailProofPendingStore {
  const byAddress = new Map<string, EmailProofPending>();
  return {
    async load(address, now) {
      const pending = byAddress.get(address);
      if (!pending) return undefined;
      if (Date.parse(pending.expiresAt) <= now.getTime()) { byAddress.delete(address); return undefined; }
      return pending;
    },
    async save(pending) { byAddress.set(pending.address, pending); },
    async delete(pending) { if (byAddress.get(pending.address)?.requestId === pending.requestId) byAddress.delete(pending.address); },
  };
}

export interface EmailProofResult {
  readonly envelope: IssuedCredentialEnvelope;
  readonly verified: VerifiedCredential;
  readonly credentialId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface EmailProofAcquireInput extends EmailProofRequestInput {
  /** Supplies the 8-digit code. Omit to only request one; the pending request is returned for a later call. */
  readonly getCode?: (context: { readonly pending: EmailProofPending }) => Promise<string>;
  /** Resumes an unexpired pending request for this address, and keeps one across failures that are recoverable. */
  readonly pendingStore?: EmailProofPendingStore;
}

export type EmailProofAcquisition =
  | { readonly status: "issued"; readonly result: EmailProofResult }
  | { readonly status: "code-requested"; readonly pending: EmailProofPending };

/** Thrown from the OTP handler to stop step 1 after the witness has sent the code. */
class CodeRequested extends Error {}

const pauseForCode: PrimitiveStepHandler = async () => {
  throw new CodeRequested("code requested");
};

/**
 * Step 1: start an email-proof request. The witness sends an 8-digit code to
 * `address`. Returns the pending state to persist until the owner supplies the code.
 */
export async function requestEmailProofCode(input: EmailProofRequestInput): Promise<EmailProofPending> {
  const profile = input.profile ?? DEFAULT_EMAIL_PROOF_PROFILE;
  const digest = profileDigest(profile, "request");
  const address = normalizeAddress(input.address);
  assertHolder(input.holder, "request");
  const now = input.now ?? (() => new Date());
  const signal = input.signal ?? AbortSignal.timeout(STEP_TIMEOUT_MS);
  const requirement = emailRequirement(address, profile);
  const requirementDigest = await credentialRequirementDigest(requirement);
  const descriptor = await witnessDescriptor(requirement, { ...input, signal }, "request", digest);
  const descriptorDigest = await canonicalDigest(descriptor);
  const verifier = randomVerifier();
  const transport = new OpenCredentialsHttpTransport(descriptor, input.fetch);

  let created: Awaited<ReturnType<OpenCredentialsHttpTransport["create"]>>;
  try {
    created = await transport.create({
      descriptor,
      descriptorDigest,
      requirement,
      requirementDigest,
      holderDid: input.holder.did,
      openerOrigin: OPENER_ORIGIN,
      completionVerifierChallenge: await sha256Base64Url(verifier),
      signal,
    });
  } catch (error) {
    throw mapError(error, "request");
  }
  const serverExpiry = Date.parse(created.expiresAt);
  if (!Number.isFinite(serverExpiry)) throw new EmailProofError("request", "FAILED");
  const pending: EmailProofPending = {
    type: "TinyCloudEmailProofPending",
    version: 1,
    profile,
    address,
    requestId: created.requestId,
    verifier,
    holderDid: input.holder.did,
    descriptorDigest,
    requirementDigest,
    openerOrigin: OPENER_ORIGIN,
    expiresAt: new Date(Math.min(serverExpiry, now().getTime() + EMAIL_PROOF_PENDING_MAX_MS)).toISOString(),
  };

  try {
    await interpretCredentialFlow({
      descriptor,
      requirement,
      requestId: created.requestId,
      verifier,
      holderDid: input.holder.did,
      descriptorDigest,
      requirementDigest,
      openerOrigin: OPENER_ORIGIN,
      transport,
      signing: holderSigning(input.holder),
      handlers: { mailbox_otp: pauseForCode },
      signal,
    });
  } catch (error) {
    if (error instanceof CodeRequested) return redacted(pending);
    throw mapError(error, "request");
  }
  throw new EmailProofError("request", "FAILED");
}

/**
 * Step 2: submit the owner's 8-digit code, sign the holder binding, issue, and
 * verify. The caller must delete `pending` after this call, success or failure.
 */
export async function completeEmailProof(input: EmailProofOptions & { readonly pending: EmailProofPending; readonly code: string; readonly holder: HolderSigner }): Promise<EmailProofResult> {
  const { pending } = input;
  const now = input.now ?? (() => new Date());
  if (!isPending(pending)) throw new EmailProofError("session", "SESSION_INVALID");
  if (Date.parse(pending.expiresAt) <= now().getTime()) throw new EmailProofError("session", "SESSION_EXPIRED");
  if (!/^\d{8}$/.test(input.code)) throw new EmailProofError("code", "CODE_INVALID");
  assertHolder(input.holder, "code");
  if (input.holder.did !== pending.holderDid) throw new EmailProofError("session", "SESSION_INVALID");
  const digest = profileDigest(pending.profile, "session");
  const signal = input.signal ?? AbortSignal.timeout(STEP_TIMEOUT_MS);

  const requirement = emailRequirement(pending.address, pending.profile);
  if (await credentialRequirementDigest(requirement) !== pending.requirementDigest) throw new EmailProofError("session", "SESSION_INVALID");
  const descriptor = await witnessDescriptor(requirement, { ...input, signal }, "code", digest);
  const descriptorDigest = await canonicalDigest(descriptor);
  if (descriptorDigest !== pending.descriptorDigest) throw new EmailProofError("session", "SESSION_INVALID");
  const transport = new OpenCredentialsHttpTransport(descriptor, input.fetch);

  try {
    // The code email was already sent in step 1. A challenge-required state here
    // would make the interpreter resend it, so refuse instead.
    const state = await transport.state(pending.requestId, pending.verifier, signal);
    if (state.nextStep?.constraints.challengeRequired === true) throw new EmailProofError("session", "SESSION_INVALID");
    await interpretCredentialFlow({
      descriptor,
      requirement,
      requestId: pending.requestId,
      verifier: pending.verifier,
      holderDid: pending.holderDid,
      descriptorDigest,
      requirementDigest: pending.requirementDigest,
      openerOrigin: pending.openerOrigin,
      transport,
      signing: holderSigning(input.holder),
      handlers: { mailbox_otp: async () => ({ otp: input.code }) },
      signal,
    });
  } catch (error) {
    throw mapError(error, "code");
  }

  try {
    const envelope = await transport.result(pending.requestId, pending.verifier, signal);
    const verified = await verifyIssuedCredential({
      envelope,
      descriptor,
      descriptorDigest,
      requirement,
      holderDid: pending.holderDid,
      issuerMetadata: pinnedIssuerMetadata(input.issuerKeys),
      now: now(),
      checkStatus: (status, statusSignal) => transport.checkStatus(status, statusSignal),
      signal,
    });
    return { envelope, verified, credentialId: verified.credentialId, issuedAt: verified.issuedAt, expiresAt: verified.expiresAt };
  } catch (error) {
    throw mapError(error, "credential");
  }
}

/**
 * Request a code and, when `getCode` is given, complete the flow in one call.
 * With a `pendingStore`, an unexpired request for the address is resumed instead
 * of requesting a new code, and the request is dropped on any non-recoverable failure.
 */
export async function acquireEmailProof(input: EmailProofAcquireInput): Promise<EmailProofAcquisition> {
  const address = normalizeAddress(input.address);
  const now = input.now ?? (() => new Date());
  const store = input.pendingStore;
  let pending = store ? await store.load(address, now()) : undefined;
  if (!pending) {
    pending = await requestEmailProofCode({ ...input, address });
    await store?.save(pending);
  }
  if (!input.getCode) return { status: "code-requested", pending };

  const code = await input.getCode({ pending });
  try {
    const result = await completeEmailProof({ ...input, pending, code });
    await store?.delete(pending);
    return { status: "issued", result };
  } catch (error) {
    if (!(error instanceof EmailProofError && error.recoverable)) await store?.delete(pending);
    throw error;
  }
}

function normalizeAddress(address: string): string {
  const value = address.trim();
  if (value.length > 254 || !EMAIL_PATTERN.test(value)) throw new EmailProofError("request", "ADDRESS_INVALID");
  return value;
}

function holderKid(did: string): string {
  return `${did}#${did.slice("did:key:".length)}`;
}

function assertHolder(holder: HolderSigner, step: EmailProofStep): void {
  if (!HOLDER_DID_PATTERN.test(holder.did) || holder.alg !== "EdDSA" || holder.kid !== holderKid(holder.did)) throw new EmailProofError(step, "HOLDER_INVALID");
}

/** Digest pinned for `profile`. Unknown or disabled profiles are rejected. */
function profileDigest(profile: string, step: EmailProofStep): string {
  const entry = Object.prototype.hasOwnProperty.call(EMAIL_PROOF_PROFILES, profile) ? EMAIL_PROOF_PROFILES[profile as EmailProofProfileId] : undefined;
  if (!entry || !entry.enabled) throw new EmailProofError(step, "PROFILE_UNAVAILABLE");
  return entry.descriptorDigest;
}

function emailRequirement(address: string, profile: EmailProofProfileId): CredentialRequirement {
  return createEmailCredentialRequirement({ email: address, profile: { id: profile, version: 1 }, credentialType: EMAIL_PROOF_CREDENTIAL_TYPE });
}

async function witnessDescriptor(requirement: CredentialRequirement, options: EmailProofOptions & { readonly signal: AbortSignal }, step: EmailProofStep, digest: string): Promise<CredentialFlowDescriptor> {
  let descriptor: CredentialFlowDescriptor;
  try {
    descriptor = await discoverCatalogDescriptor(requirement, DISCOVERY_URL, { fetch: options.fetch, signal: options.signal });
  } catch (error) {
    throw mapError(error, step);
  }
  if (descriptor.issuer.origin !== EMAIL_PROOF_WITNESS_ORIGIN || descriptor.issuer.did !== EMAIL_PROOF_ISSUER_DID || !descriptor.steps.some((candidate) => candidate.type === "mailbox_otp")) {
    throw new EmailProofError(step, "PROFILE_UNAVAILABLE");
  }
  if (await canonicalDigest(descriptor) !== digest) throw new EmailProofError(step, "PROFILE_UNAVAILABLE");
  return descriptor;
}

function pinnedIssuerMetadata(keys: readonly IssuerVerificationKey[] = EMAIL_PROOF_ISSUER_KEYS): CredentialIssuerMetadata {
  return { type: "OpenCredentialsIssuerMetadata", version: 1, origin: EMAIL_PROOF_WITNESS_ORIGIN, issuerDid: EMAIL_PROOF_ISSUER_DID, keys, cache: { maxAgeSeconds: 3600, etag: "pinned" } };
}

function holderSigning(holder: HolderSigner): CredentialSigningAdapter {
  return { autoSign: async (_binding, bytes) => holder.sign(bytes) };
}

function randomVerifier(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function isPending(value: EmailProofPending): boolean {
  return value?.type === "TinyCloudEmailProofPending"
    && value.version === 1
    && [value.profile, value.address, value.requestId, value.verifier, value.holderDid, value.descriptorDigest, value.requirementDigest, value.openerOrigin, value.expiresAt].every((field) => typeof field === "string");
}

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
/** Hides the bearer verifier from console and util.inspect. JSON and property access still carry it: courier persists it. */
function redacted(pending: EmailProofPending): EmailProofPending {
  return Object.defineProperty(pending, INSPECT, { value: () => ({ ...pending, verifier: "[redacted]" }), enumerable: false });
}

function rateLimitMessage(retryAfterMs: number | undefined): string {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return MESSAGES.RATE_LIMITED;
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `Too many codes were requested for this address. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/** Maps any failure to a stable code. `recoverable` is the server's flag, or true for transient network failures. */
function mapError(value: unknown, step: EmailProofStep): EmailProofError {
  if (value instanceof EmailProofError) return value;
  if (value instanceof DOMException && value.name === "TimeoutError") return new EmailProofError(step, "NETWORK", undefined, true);
  const error = credentialError(value);
  const details = error.details;
  switch (error.code) {
    case "ISSUER_UNREADY":
      return details.state === "rate_limited"
        ? new EmailProofError(step, "RATE_LIMITED", details.retryAfterMs, error.recoverable)
        : new EmailProofError(step, "ISSUER_UNAVAILABLE", undefined, error.recoverable);
    case "OFFLINE":
      return new EmailProofError(step, "NETWORK", undefined, true);
    case "UNSUPPORTED_PROFILE":
    case "DESCRIPTOR_INVALID":
      return new EmailProofError("request", "PROFILE_UNAVAILABLE");
    case "PROOF_REJECTED":
      return new EmailProofError("code", "CODE_REJECTED", undefined, error.recoverable);
    case "VERIFICATION_FAILED":
      if (details.state === "proof_attempts_exhausted") return new EmailProofError("code", "CODE_ATTEMPTS_EXHAUSTED");
      if (step === "credential") return new EmailProofError("credential", "CREDENTIAL_INVALID");
      if (step === "code") return new EmailProofError("code", "CODE_REJECTED");
      return new EmailProofError(step, "FAILED");
    case "REQUEST_EXPIRED":
      return new EmailProofError("session", "SESSION_EXPIRED");
    case "REQUEST_SUBSTITUTED":
      return new EmailProofError("session", "SESSION_INVALID");
    case "SIGNATURE_REJECTED":
      return new EmailProofError("credential", "SIGNATURE_REJECTED");
    case "CANCELED":
      return new EmailProofError(step, "CANCELED");
    default:
      return new EmailProofError(step, "FAILED");
  }
}
