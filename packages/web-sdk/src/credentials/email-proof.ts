import {
  canonicalDigest,
  createEmailCredentialRequirement,
  credentialError,
  credentialRequirementDigest,
  encodeBase64Url,
  sha256Base64Url,
  verifyIssuedCredential,
  type CredentialFlowDescriptor,
  type CredentialRequirement,
  type IssuedCredentialEnvelope,
  type VerifiedCredential,
} from "@tinycloud/sdk-core";
import { discoverCatalogDescriptor } from "./discovery";
import { interpretCredentialFlow } from "./interpreter";
import { OpenCredentialsHttpTransport } from "./transport";
import type { CredentialSigningAdapter, PrimitiveStepHandler } from "./types";

/** The only network origin this helper contacts. */
export const EMAIL_PROOF_WITNESS_ORIGIN = "https://witness.credentials.org";
export const EMAIL_PROOF_PROFILE = { id: "tinycloud.email-proof/v1", version: 1 } as const;
export const EMAIL_PROOF_CREDENTIAL_TYPE = { id: "opencredentials.email/v1", version: 1 } as const;
/** A pending request is never trusted beyond this window, regardless of the server expiry. */
export const EMAIL_PROOF_PENDING_MAX_MS = 15 * 60_000;

const DISCOVERY_URL = `${EMAIL_PROOF_WITNESS_ORIGIN}/.well-known/opencredentials`;
const OPENER_ORIGIN = "https://localhost";
const STEP_TIMEOUT_MS = 60_000;
const HOLDER_DID_PATTERN = /^did:key:z6Mk[^#]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  RATE_LIMITED: "Too many verification codes were requested. Try again later.",
  ISSUER_UNAVAILABLE: "Email verification is unavailable right now. Try again later.",
  NETWORK: "Could not reach the email verification service. Try again.",
  PROFILE_UNAVAILABLE: "The witness does not offer the email verification profile.",
  CODE_REJECTED: "Verification code was not accepted. Request a new code.",
  CODE_ATTEMPTS_EXHAUSTED: "Too many wrong codes. Request a new code.",
  SIGNATURE_REJECTED: "Holder signature was rejected.",
  CREDENTIAL_INVALID: "Issued credential failed verification.",
  SESSION_EXPIRED: "Email verification request expired. Request a new code.",
  SESSION_INVALID: "Email verification request is no longer valid. Request a new code.",
  CANCELED: "Email verification was canceled.",
  FAILED: "Email verification failed.",
};

/** Stable, redaction-safe error. Messages never include the code, verifier, or key material. */
export class EmailProofError extends Error {
  readonly name = "EmailProofError";

  constructor(
    readonly step: EmailProofStep,
    readonly code: EmailProofErrorCode,
    message: string = MESSAGES[code],
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Holder key adapter. Courier passes its agent did:key and Ed25519 signer. */
export interface EmailProofHolder {
  readonly did: string;
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
}

export interface EmailProofOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

/** Durable state between `requestEmailProofCode` and `completeEmailProof`. The verifier is a bearer secret: store it 0600. */
export interface EmailProofPending {
  readonly type: "TinyCloudEmailProofPending";
  readonly version: 1;
  readonly address: string;
  readonly requestId: string;
  readonly verifier: string;
  readonly holderDid: string;
  readonly descriptorDigest: string;
  readonly requirementDigest: string;
  readonly openerOrigin: string;
  readonly expiresAt: string;
}

export interface EmailProofResult {
  readonly envelope: IssuedCredentialEnvelope;
  readonly verified: VerifiedCredential;
}

/** Thrown from the OTP handler to stop step 1 after the witness has sent the code. */
class CodeRequested extends Error {}

const pauseForCode: PrimitiveStepHandler = async () => {
  throw new CodeRequested("code requested");
};

/**
 * Step 1: start an email-proof request. The witness sends an 8-digit code to
 * `address`. Returns the pending state to persist until the owner supplies the code.
 */
export async function requestEmailProofCode(input: EmailProofOptions & { readonly address: string; readonly holder: EmailProofHolder }): Promise<EmailProofPending> {
  const address = normalizeAddress(input.address);
  assertHolder(input.holder);
  const now = input.now ?? (() => new Date());
  const signal = input.signal ?? AbortSignal.timeout(STEP_TIMEOUT_MS);
  const requirement = emailRequirement(address);
  const requirementDigest = await credentialRequirementDigest(requirement);
  const descriptor = await witnessDescriptor(requirement, { ...input, signal }, "request");
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
  if (!Number.isFinite(serverExpiry)) throw new EmailProofError("request", "FAILED", "Witness returned an invalid request expiry.");
  const pending: EmailProofPending = {
    type: "TinyCloudEmailProofPending",
    version: 1,
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
    if (error instanceof CodeRequested) return pending;
    throw mapError(error, "request");
  }
  throw new EmailProofError("request", "FAILED", "Witness did not request a verification code.");
}

/**
 * Step 2: submit the owner's 8-digit code, sign the holder binding, issue, and
 * verify. The caller must delete `pending` after this call, success or failure.
 */
export async function completeEmailProof(input: EmailProofOptions & { readonly pending: EmailProofPending; readonly code: string; readonly holder: EmailProofHolder }): Promise<EmailProofResult> {
  const { pending } = input;
  const now = input.now ?? (() => new Date());
  if (!isPending(pending)) throw new EmailProofError("session", "SESSION_INVALID");
  if (Date.parse(pending.expiresAt) <= now().getTime()) throw new EmailProofError("session", "SESSION_EXPIRED");
  if (!/^\d{8}$/.test(input.code)) throw new EmailProofError("code", "CODE_INVALID");
  assertHolder(input.holder);
  if (input.holder.did !== pending.holderDid) throw new EmailProofError("session", "SESSION_INVALID");
  const signal = input.signal ?? AbortSignal.timeout(STEP_TIMEOUT_MS);

  const requirement = emailRequirement(pending.address);
  if (await credentialRequirementDigest(requirement) !== pending.requirementDigest) throw new EmailProofError("session", "SESSION_INVALID");
  const descriptor = await witnessDescriptor(requirement, { ...input, signal }, "code");
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
      issuerMetadata: await transport.issuerMetadata(signal),
      now: now(),
      checkStatus: (status, statusSignal) => transport.checkStatus(status, statusSignal),
      signal,
    });
    return { envelope, verified };
  } catch (error) {
    throw mapError(error, "credential");
  }
}

function normalizeAddress(address: string): string {
  const value = address.trim();
  if (value.length > 254 || !EMAIL_PATTERN.test(value)) throw new EmailProofError("request", "ADDRESS_INVALID");
  return value;
}

function assertHolder(holder: EmailProofHolder): void {
  if (!HOLDER_DID_PATTERN.test(holder.did)) throw new EmailProofError("request", "HOLDER_INVALID");
}

function emailRequirement(address: string): CredentialRequirement {
  return createEmailCredentialRequirement({ email: address, profile: EMAIL_PROOF_PROFILE, credentialType: EMAIL_PROOF_CREDENTIAL_TYPE });
}

async function witnessDescriptor(requirement: CredentialRequirement, options: EmailProofOptions & { readonly signal: AbortSignal }, step: EmailProofStep): Promise<CredentialFlowDescriptor> {
  let descriptor: CredentialFlowDescriptor;
  try {
    descriptor = await discoverCatalogDescriptor(requirement, DISCOVERY_URL, { fetch: options.fetch, signal: options.signal });
  } catch (error) {
    throw mapError(error, step);
  }
  if (descriptor.issuer.origin !== EMAIL_PROOF_WITNESS_ORIGIN || !descriptor.steps.some((candidate) => candidate.type === "mailbox_otp")) {
    throw new EmailProofError(step, "PROFILE_UNAVAILABLE");
  }
  return descriptor;
}

function holderSigning(holder: EmailProofHolder): CredentialSigningAdapter {
  return { autoSign: async (_binding, bytes) => holder.sign(bytes) };
}

function randomVerifier(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function isPending(value: EmailProofPending): boolean {
  return value?.type === "TinyCloudEmailProofPending"
    && value.version === 1
    && [value.address, value.requestId, value.verifier, value.holderDid, value.descriptorDigest, value.requirementDigest, value.openerOrigin, value.expiresAt].every((field) => typeof field === "string");
}

function rateLimitMessage(retryAfterMs: number | undefined): string {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return MESSAGES.RATE_LIMITED;
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `Too many verification codes were requested. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function mapError(value: unknown, step: EmailProofStep): EmailProofError {
  if (value instanceof EmailProofError) return value;
  if (value instanceof DOMException && value.name === "TimeoutError") return new EmailProofError(step, "NETWORK");
  const error = credentialError(value);
  const details = error.details;
  switch (error.code) {
    case "ISSUER_UNREADY":
      return details.state === "rate_limited"
        ? new EmailProofError("request", "RATE_LIMITED", rateLimitMessage(details.retryAfterMs), details.retryAfterMs)
        : new EmailProofError(step, "ISSUER_UNAVAILABLE");
    case "OFFLINE":
      return new EmailProofError(step, "NETWORK");
    case "UNSUPPORTED_PROFILE":
    case "DESCRIPTOR_INVALID":
      return new EmailProofError("request", "PROFILE_UNAVAILABLE");
    case "PROOF_REJECTED":
      return new EmailProofError("code", "CODE_REJECTED");
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
