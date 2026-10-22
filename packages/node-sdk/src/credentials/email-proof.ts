import {
  canonicalDigest,
  createEmailCredentialRequirement,
  credentialError,
  credentialRequirementDigest,
  CredentialError,
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

/** Production pins. Credentials verify only against these values. Tests pin them literally. */
export const EMAIL_PROOF_PINS = Object.freeze({
  witnessOrigin: "https://witness.credentials.org",
  issuerDid: "did:web:issuer.credentials.org",
  issuerKid: "did:web:issuer.credentials.org#controller",
  issuerX: "eEJI4xEobto4HtQ7Pg9R1vBOwcpfGRTlXDG5QfqLnGQ",
  descriptorDigest: "1tg-qphmKBVtNwzVg9xyz-xxqt_xtMXAsQyXw46m8S0",
} as const);

export const EMAIL_PROOF_CREDENTIAL_TYPE = { id: "opencredentials.email/v1", version: 1 } as const;
/** A pending request is never trusted beyond this window, measured from creation. */
export const EMAIL_PROOF_PENDING_MAX_MS = 15 * 60_000;

const DISCOVERY_URL = `${EMAIL_PROOF_PINS.witnessOrigin}/.well-known/opencredentials`;
const EMAIL_PROOF_ISSUER_KEYS: readonly IssuerVerificationKey[] = [
  {
    kid: EMAIL_PROOF_PINS.issuerKid,
    alg: "EdDSA",
    jwk: { kty: "OKP", crv: "Ed25519", x: EMAIL_PROOF_PINS.issuerX },
    validFrom: "2020-01-01T00:00:00Z",
    validUntil: "2100-01-01T00:00:00Z",
  },
];

export type EmailProofProfileId = "tinycloud.email-proof/v1";
export const DEFAULT_EMAIL_PROOF_PROFILE: EmailProofProfileId = "tinycloud.email-proof/v1";
/** Each profile is pinned to its descriptor digest and to the mailbox step the witness must offer. */
const PROFILE_PINS: Readonly<Record<EmailProofProfileId, { readonly descriptorDigest: string; readonly requiredStep: "mailbox_otp"; readonly enabled: boolean }>> = {
  "tinycloud.email-proof/v1": { descriptorDigest: EMAIL_PROOF_PINS.descriptorDigest, requiredStep: "mailbox_otp", enabled: true },
};

const OPENER_ORIGIN = "https://localhost";
const STEP_TIMEOUT_MS = 60_000;
const HOLDER_DID_PREFIX = "did:key:";
const HOLDER_DID_PATTERN = /^did:key:z6Mk[^#]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Which part of the two-step flow failed. */
export type EmailProofStep = "request" | "code" | "credential" | "session";

/**
 * Stable error codes. `recoverable` = the same pending request may be retried
 * (with another code, or after the network returns) before it expires.
 *
 * | code                    | recoverable | reason |
 * |-------------------------|-------------|--------|
 * | ADDRESS_INVALID         | false       | input is malformed; the same address cannot succeed |
 * | HOLDER_INVALID          | false       | holder key is not an Ed25519 did:key with a matching kid |
 * | CODE_INVALID            | true        | local format check (8 digits); no network; pending kept |
 * | RATE_LIMITED            | false       | witness refuses new codes for this address until retryAfterMs |
 * | ISSUER_UNAVAILABLE      | true        | transient issuer outage (503); witness flag is honoured |
 * | NETWORK                 | true        | transport failure or step timeout; pending kept |
 * | PROFILE_UNAVAILABLE     | false       | catalog or descriptor does not match the pinned profile |
 * | CODE_REJECTED           | true        | wrong code; witness flag decides whether another attempt is allowed |
 * | CODE_ATTEMPTS_EXHAUSTED | false       | witness proof-attempt budget spent; pending is dead |
 * | SIGNATURE_REJECTED      | true        | holder binding rejected; same pending may be retried |
 * | CREDENTIAL_INVALID      | false       | issued credential failed local verification |
 * | SESSION_EXPIRED         | false       | pending window or server expiry has passed |
 * | SESSION_INVALID         | false       | pending does not match holder, descriptor, or requirement |
 * | CANCELED                | false       | caller aborted; pending is deleted |
 * | FAILED                  | false       | unclassified failure; pending is deleted |
 */
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

const RECOVERABILITY: Readonly<Record<EmailProofErrorCode, boolean>> = {
  ADDRESS_INVALID: false,
  HOLDER_INVALID: false,
  CODE_INVALID: true,
  RATE_LIMITED: false,
  ISSUER_UNAVAILABLE: true,
  NETWORK: true,
  PROFILE_UNAVAILABLE: false,
  CODE_REJECTED: true,
  CODE_ATTEMPTS_EXHAUSTED: false,
  SIGNATURE_REJECTED: true,
  CREDENTIAL_INVALID: false,
  SESSION_EXPIRED: false,
  SESSION_INVALID: false,
  CANCELED: false,
  FAILED: false,
};

const MESSAGES: Record<Exclude<EmailProofErrorCode, "RATE_LIMITED">, string> = {
  ADDRESS_INVALID: "Email address is invalid.",
  HOLDER_INVALID: "Holder must be a did:key Ed25519 identifier.",
  CODE_INVALID: "Verification code must be 8 digits.",
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

function rateLimitMessage(retryAfterMs: number | undefined): string {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return "Too many codes were requested for this address. Try again later.";
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `Too many codes were requested for this address. Try again in ${minutes} minutes.`;
}

/** Stable, redaction-safe error. The message never includes the code, verifier, or key material. */
export class EmailProofError extends Error {
  readonly name = "EmailProofError";
  readonly step: EmailProofStep;
  readonly code: EmailProofErrorCode;
  readonly retryAfterMs: number | undefined;
  readonly recoverable: boolean;

  constructor(step: EmailProofStep, code: EmailProofErrorCode, retryAfterMs?: number, recoverable: boolean = RECOVERABILITY[code]) {
    super(code === "RATE_LIMITED" ? rateLimitMessage(retryAfterMs) : MESSAGES[code]);
    this.step = step;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.recoverable = recoverable;
  }
}

export type HolderAlgorithm = "EdDSA" | "EIP191";

/**
 * Holder key adapter. `sign` MUST return a raw signature over exactly the bytes it
 * is given: the signer does no hashing, prefixing, or domain separation. `kid` names
 * the key the witness verifies against. `completeEmailProof` rejects with
 * SESSION_INVALID unless `did === pending.holderDid`.
 */
export interface HolderSigner {
  readonly did: string;
  readonly alg: HolderAlgorithm;
  readonly kid: string;
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Ed25519 did:key holder. Accepts `did:key:z6Mk…` or `did:key:z6Mk…#<same multibase>`
 * (the session-manager form) and normalises to the bare DID. `kid` is derived from the bare DID.
 */
export function createEd25519HolderSigner(did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array>): HolderSigner {
  const fragment = did.indexOf("#");
  const bare = fragment === -1 ? did : did.slice(0, fragment);
  if (fragment !== -1 && did.slice(fragment + 1) !== bare.slice(HOLDER_DID_PREFIX.length)) throw new EmailProofError("request", "HOLDER_INVALID");
  if (!HOLDER_DID_PATTERN.test(bare)) throw new EmailProofError("request", "HOLDER_INVALID");
  return { did: bare, alg: "EdDSA", kid: holderKid(bare), sign };
}

/** Options shared by the public steps. Issuer keys are never caller-supplied. */
export interface EmailProofOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface EmailProofRequestInput extends EmailProofOptions {
  readonly address: string;
  readonly holder: HolderSigner;
  readonly profile?: EmailProofProfileId;
}

/**
 * Durable state between `requestEmailProofCode` and `completeEmailProof`.
 * `verifier` is a bearer secret. It is a non-enumerable property, so spread
 * omits it; `toJSON` and `util.inspect` redact it. Persist it only with owner-only storage.
 */
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
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Holds pending requests keyed by requestId. Implementations must never return an expired request from `findLive`. */
export interface EmailProofPendingStore {
  /** Newest unexpired request for `address`, or undefined. */
  findLive(address: string, now: Date): Promise<EmailProofPending | undefined>;
  put(pending: EmailProofPending): Promise<void>;
  delete(requestId: string): Promise<void>;
}

/**
 * Rebuilds a pending request from stored fields. The result is redacted exactly like
 * one produced by `requestEmailProofCode`. Stores call this on every read.
 */
export function restoreEmailProofPending(fields: EmailProofPending): EmailProofPending {
  const shown = {
    type: fields.type,
    version: fields.version,
    profile: fields.profile,
    address: fields.address,
    requestId: fields.requestId,
    holderDid: fields.holderDid,
    descriptorDigest: fields.descriptorDigest,
    requirementDigest: fields.requirementDigest,
    openerOrigin: fields.openerOrigin,
    createdAt: fields.createdAt,
    expiresAt: fields.expiresAt,
  };
  const pending = { ...shown } as EmailProofPending;
  hide(pending, "verifier", fields.verifier);
  hide(pending, "toJSON", () => ({ ...shown }));
  hide(pending, INSPECT, () => ({ ...shown, verifier: "[redacted]" }));
  return Object.freeze(pending);
}

function hide(target: object, key: string | symbol, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: false });
}

/** Latest instant at which a pending request may still be completed. */
export function pendingDeadlineMs(pending: EmailProofPending): number {
  return Math.min(Date.parse(pending.expiresAt), Date.parse(pending.createdAt) + EMAIL_PROOF_PENDING_MAX_MS);
}

/** Process-local pending store for browsers and tests. Nothing survives a reload. */
export function createMemoryEmailProofPendingStore(): EmailProofPendingStore {
  const byRequest = new Map<string, EmailProofPending>();
  const prune = (now: Date) => {
    for (const [requestId, pending] of byRequest) if (pendingDeadlineMs(pending) <= now.getTime()) byRequest.delete(requestId);
  };
  return {
    async findLive(address, now) {
      prune(now);
      let newest: EmailProofPending | undefined;
      for (const pending of byRequest.values()) {
        if (pending.address === address && (!newest || Date.parse(pending.createdAt) > Date.parse(newest.createdAt))) newest = pending;
      }
      return newest;
    },
    async put(pending) { byRequest.set(pending.requestId, pending); },
    async delete(requestId) { byRequest.delete(requestId); },
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
  /** Resumes an unexpired pending request for this address, and keeps one across recoverable failures. */
  readonly pendingStore?: EmailProofPendingStore;
}

export type EmailProofAcquisition =
  | { readonly status: "issued"; readonly result: EmailProofResult; /** Non-fatal, e.g. the pending record could not be deleted after success. */ readonly warnings: readonly string[] }
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
  profilePin(profile, "request");
  const address = normalizeAddress(input.address);
  assertHolder(input.holder, "request");
  const now = input.now ?? (() => new Date());
  const signal = input.signal ?? AbortSignal.timeout(STEP_TIMEOUT_MS);
  const requirement = emailRequirement(address, profile);
  const requirementDigest = await credentialRequirementDigest(requirement);
  const descriptor = await witnessDescriptor(profile, requirement, { fetch: input.fetch, signal }, "request");
  const descriptorDigest = await canonicalDigest(descriptor);
  const verifier = randomVerifier();
  const transport = new OpenCredentialsHttpTransport(descriptor, input.fetch, { honorServerRecoverable: true });

  const createdAtMs = now().getTime();
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
    throw mapError(error, "request", signal);
  }
  const serverExpiry = Date.parse(created.expiresAt);
  if (!Number.isFinite(serverExpiry)) throw new EmailProofError("request", "FAILED");
  const pending = restoreEmailProofPending({
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
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(Math.min(serverExpiry, createdAtMs + EMAIL_PROOF_PENDING_MAX_MS)).toISOString(),
  });

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
    if (error instanceof CodeRequested) return pending;
    throw mapError(error, "request", signal);
  }
  throw new EmailProofError("request", "FAILED");
}

/**
 * Step 2: submit the owner's 8-digit code, sign the holder binding, issue, and
 * verify. The caller must delete `pending` after this call, success or failure.
 */
export async function completeEmailProof(input: EmailProofOptions & { readonly pending: EmailProofPending; readonly code: string; readonly holder: HolderSigner }): Promise<EmailProofResult> {
  return completeWithIssuerKeys(input, EMAIL_PROOF_ISSUER_KEYS);
}

/**
 * Internal test seam: completes with caller-supplied issuer keys. Not re-exported
 * from the package barrel. Production code uses `completeEmailProof`.
 */
export async function completeEmailProofWithIssuerKeys(
  input: EmailProofOptions & { readonly pending: EmailProofPending; readonly code: string; readonly holder: HolderSigner },
  issuerKeys: readonly IssuerVerificationKey[],
): Promise<EmailProofResult> {
  return completeWithIssuerKeys(input, issuerKeys);
}

async function completeWithIssuerKeys(
  input: EmailProofOptions & { readonly pending: EmailProofPending; readonly code: string; readonly holder: HolderSigner },
  issuerKeys: readonly IssuerVerificationKey[],
): Promise<EmailProofResult> {
  const { pending } = input;
  const now = input.now ?? (() => new Date());
  if (!isPending(pending)) throw new EmailProofError("session", "SESSION_INVALID");
  if (pendingDeadlineMs(pending) <= now().getTime()) throw new EmailProofError("session", "SESSION_EXPIRED");
  if (!/^\d{8}$/.test(input.code)) throw new EmailProofError("code", "CODE_INVALID");
  assertHolder(input.holder, "code");
  if (input.holder.did !== pending.holderDid) throw new EmailProofError("session", "SESSION_INVALID");
  const signal = input.signal ?? AbortSignal.timeout(STEP_TIMEOUT_MS);

  const requirement = emailRequirement(pending.address, pending.profile);
  if (await credentialRequirementDigest(requirement) !== pending.requirementDigest) throw new EmailProofError("session", "SESSION_INVALID");
  const descriptor = await witnessDescriptor(pending.profile, requirement, { fetch: input.fetch, signal }, "session");
  const descriptorDigest = await canonicalDigest(descriptor);
  if (descriptorDigest !== pending.descriptorDigest) throw new EmailProofError("session", "SESSION_INVALID");
  const transport = new OpenCredentialsHttpTransport(descriptor, input.fetch, { honorServerRecoverable: true });

  try {
    // The code email was sent in step 1. A challenge-required state here would make
    // the interpreter resend it, so refuse instead.
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
    throw mapError(error, "code", signal);
  }

  try {
    const envelope = await transport.result(pending.requestId, pending.verifier, signal);
    const verified = await verifyIssuedCredential({
      envelope,
      descriptor,
      descriptorDigest,
      requirement,
      holderDid: pending.holderDid,
      issuerMetadata: pinnedIssuerMetadata(issuerKeys),
      now: now(),
      checkStatus: (status, statusSignal) => transport.checkStatus(status, statusSignal),
      signal,
    });
    return { envelope, verified, credentialId: verified.credentialId, issuedAt: verified.issuedAt, expiresAt: verified.expiresAt };
  } catch (error) {
    throw mapError(error, "credential", signal);
  }
}

/**
 * Request a code and, when `getCode` is given, complete the flow in one call.
 * With a `pendingStore`, an unexpired request for the address is resumed instead of
 * requesting a new code. A non-recoverable failure deletes the pending request.
 *
 * `store.put` throwing after the code was mailed: the code is in the owner's inbox but
 * not persisted, so the error propagates and the owner must request a new code.
 * `store.delete` failing after success: the credential is returned with a warning.
 * `store.delete` failing on a non-recoverable failure: the original error propagates.
 */
export async function acquireEmailProof(input: EmailProofAcquireInput): Promise<EmailProofAcquisition> {
  return acquireWithIssuerKeys(input, EMAIL_PROOF_ISSUER_KEYS);
}

/** Internal test seam, same as `completeEmailProofWithIssuerKeys`. Not re-exported from the barrel. */
export async function acquireEmailProofWithIssuerKeys(input: EmailProofAcquireInput, issuerKeys: readonly IssuerVerificationKey[]): Promise<EmailProofAcquisition> {
  return acquireWithIssuerKeys(input, issuerKeys);
}

async function acquireWithIssuerKeys(input: EmailProofAcquireInput, issuerKeys: readonly IssuerVerificationKey[]): Promise<EmailProofAcquisition> {
  const address = normalizeAddress(input.address);
  const now = input.now ?? (() => new Date());
  const store = input.pendingStore;
  let pending = store ? await store.findLive(address, now()) : undefined;
  if (!pending) {
    pending = await requestEmailProofCode({ ...input, address });
    await store?.put(pending);
  }
  if (!input.getCode) return { status: "code-requested", pending };

  const code = await input.getCode({ pending });
  try {
    const result = await completeWithIssuerKeys({ ...input, pending, code }, issuerKeys);
    const warnings: string[] = [];
    if (store) {
      try { await store.delete(pending.requestId); } catch { warnings.push("The pending request could not be deleted after success; it expires at its deadline."); }
    }
    return { status: "issued", result, warnings };
  } catch (error) {
    if (!(error instanceof EmailProofError && error.recoverable)) await store?.delete(pending.requestId).catch(() => undefined);
    throw error;
  }
}

function normalizeAddress(address: string): string {
  const value = address.trim();
  if (value.length > 254 || !EMAIL_PATTERN.test(value)) throw new EmailProofError("request", "ADDRESS_INVALID");
  return value;
}

function holderKid(did: string): string {
  return `${did}#${did.slice(HOLDER_DID_PREFIX.length)}`;
}

function assertHolder(holder: HolderSigner, step: EmailProofStep): void {
  if (!HOLDER_DID_PATTERN.test(holder.did) || holder.alg !== "EdDSA" || holder.kid !== holderKid(holder.did)) throw new EmailProofError(step, "HOLDER_INVALID");
}

function profilePin(profile: string, step: EmailProofStep): (typeof PROFILE_PINS)[EmailProofProfileId] {
  const entry = Object.prototype.hasOwnProperty.call(PROFILE_PINS, profile) ? PROFILE_PINS[profile as EmailProofProfileId] : undefined;
  if (!entry || !entry.enabled) throw new EmailProofError(step, "PROFILE_UNAVAILABLE");
  return entry;
}

function emailRequirement(address: string, profile: EmailProofProfileId): CredentialRequirement {
  return createEmailCredentialRequirement({ email: address, profile: { id: profile, version: 1 }, credentialType: EMAIL_PROOF_CREDENTIAL_TYPE });
}

/** Discovers the catalog and returns the descriptor only if it matches the pinned issuer, origin, step, and digest. */
async function witnessDescriptor(
  profile: EmailProofProfileId,
  requirement: CredentialRequirement,
  options: { readonly fetch?: typeof fetch; readonly signal: AbortSignal },
  step: EmailProofStep,
): Promise<CredentialFlowDescriptor> {
  const pin = profilePin(profile, step);
  let descriptor: CredentialFlowDescriptor;
  try {
    descriptor = await discoverCatalogDescriptor(requirement, DISCOVERY_URL, { fetch: options.fetch, signal: options.signal });
  } catch (error) {
    throw discoveryFailure(error, options.signal, step);
  }
  if (descriptor.issuer.origin !== EMAIL_PROOF_PINS.witnessOrigin || descriptor.issuer.did !== EMAIL_PROOF_PINS.issuerDid || !descriptor.steps.some((candidate) => candidate.type === pin.requiredStep)) {
    throw new EmailProofError(step, "PROFILE_UNAVAILABLE");
  }
  if (await canonicalDigest(descriptor) !== pin.descriptorDigest) throw new EmailProofError(step, "PROFILE_UNAVAILABLE");
  return descriptor;
}

/**
 * Fetch an OpenCredentials catalog and return the first enabled, ready profile whose
 * descriptor satisfies the requirement and matches its catalog digest.
 */
async function discoverCatalogDescriptor(
  requirement: CredentialRequirement,
  discoveryUrl: string,
  options: { readonly fetch?: typeof fetch; readonly signal?: AbortSignal } = {},
): Promise<CredentialFlowDescriptor> {
  let url: URL; try { url = new URL(discoveryUrl); } catch { throw new CredentialError("UNSUPPORTED_PROFILE", "Discovery URL is invalid"); }
  if (url.protocol !== "https:" || !["/.well-known/opencredentials", "/v1/credential-types"].includes(url.pathname) || url.search || url.hash) throw new CredentialError("UNSUPPORTED_PROFILE", "Discovery URL is not an allowed catalog endpoint");
  const init: RequestInit & { readonly cache: "no-store" } = { credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: options.signal };
  let response: Response;
  try { response = await (options.fetch ?? globalThis.fetch.bind(globalThis))(url, init); } catch (cause) { throw new CredentialError("OFFLINE", "Credential discovery is unavailable", { cause }); }
  if (!response.ok) throw new CredentialError(response.status === 503 ? "ISSUER_UNREADY" : "OFFLINE", "Credential discovery is unavailable");
  const catalog = await response.json() as Record<string, unknown>;
  if (catalog.type !== "tinycloud.credentials/catalog/v1" || catalog.protocol !== "tinycloud.credentials/acquisition/v1" || catalog.catalogVersion !== 1 || !Array.isArray(catalog.profiles)) throw new CredentialError("DESCRIPTOR_INVALID", "Credential catalog is invalid");
  for (const entryValue of catalog.profiles) {
    if (typeof entryValue !== "object" || entryValue === null || Array.isArray(entryValue)) continue;
    const entry = entryValue as Record<string, unknown>;
    if (entry.supported !== true || entry.enabled !== true || (entry.readiness !== "ready" && entry.readiness !== "degraded")) continue;
    try {
      const candidate = validateCredentialFlowDescriptor(entry.descriptor);
      if (descriptorSatisfiesRequirement(candidate, requirement) && entry.descriptorDigest === await canonicalDigest(candidate)) return candidate;
    } catch { /* malformed catalog entry: skip */ }
  }
  throw new CredentialError("UNSUPPORTED_PROFILE", "No available credential profile satisfies the requirement");
}

/** A discovery abort by the caller is CANCELED. A step timeout stays NETWORK (recoverable). */
function discoveryFailure(error: unknown, signal: AbortSignal, step: EmailProofStep): EmailProofError {
  if (signal.aborted && (signal.reason as { name?: string } | undefined)?.name !== "TimeoutError") return new EmailProofError(step, "CANCELED");
  return mapError(error, step, signal);
}

function pinnedIssuerMetadata(keys: readonly IssuerVerificationKey[]): CredentialIssuerMetadata {
  return { type: "OpenCredentialsIssuerMetadata", version: 1, origin: EMAIL_PROOF_PINS.witnessOrigin, issuerDid: EMAIL_PROOF_PINS.issuerDid, keys, cache: { maxAgeSeconds: 3600, etag: "pinned" } };
}

/** Holder signing: the signer receives the raw binding bytes and returns a raw Ed25519 signature. The kid goes on the wire. */
function holderSigning(holder: HolderSigner): CredentialSigningAdapter {
  return { autoSign: async (_binding, bytes) => holder.sign(bytes), holderKey: { alg: "EdDSA", kid: holder.kid } };
}

function randomVerifier(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function isPending(value: unknown): value is EmailProofPending {
  if (typeof value !== "object" || value === null) return false;
  const pending = value as EmailProofPending;
  return pending.type === "TinyCloudEmailProofPending"
    && pending.version === 1
    && pending.openerOrigin === OPENER_ORIGIN
    && [pending.profile, pending.address, pending.requestId, pending.verifier, pending.holderDid, pending.descriptorDigest, pending.requirementDigest, pending.openerOrigin, pending.createdAt, pending.expiresAt].every((field) => typeof field === "string")
    && Number.isFinite(Date.parse(pending.createdAt))
    && Number.isFinite(Date.parse(pending.expiresAt));
}

/** Maps any failure to a stable code. Caller aborts map to CANCELED; transient network failures stay recoverable. */
function mapError(value: unknown, step: EmailProofStep, signal?: AbortSignal): EmailProofError {
  if (value instanceof EmailProofError) return value;
  if (value instanceof DOMException && value.name === "TimeoutError") return new EmailProofError(step, "NETWORK", undefined, true);
  const error = credentialError(value);
  const details = error.details;
  switch (error.code) {
    case "ISSUER_UNREADY":
      return details.state === "rate_limited"
        ? new EmailProofError(step, "RATE_LIMITED", details.retryAfterMs, false)
        : new EmailProofError(step, "ISSUER_UNAVAILABLE", undefined, error.recoverable);
    case "OFFLINE":
      if (signal?.aborted && (signal.reason as { name?: string } | undefined)?.name !== "TimeoutError") return new EmailProofError(step, "CANCELED");
      return new EmailProofError(step, "NETWORK", undefined, true);
    case "UNSUPPORTED_PROFILE":
    case "DESCRIPTOR_INVALID":
      return new EmailProofError(step, "PROFILE_UNAVAILABLE");
    case "PROOF_REJECTED":
      return new EmailProofError("code", "CODE_REJECTED", undefined, error.recoverable);
    case "VERIFICATION_FAILED":
      if (details.state === "proof_attempts_exhausted") return new EmailProofError("code", "CODE_ATTEMPTS_EXHAUSTED");
      if (step === "credential") return new EmailProofError("credential", "CREDENTIAL_INVALID");
      if (step === "code") return new EmailProofError("code", "CODE_REJECTED");
      return new EmailProofError(step, "FAILED");
    case "HOLDER_MISMATCH":
      return new EmailProofError("credential", "CREDENTIAL_INVALID");
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
