import { createPrivateKey, sign as cryptoSign, type JsonWebKey, type KeyObject } from 'node:crypto';
import {
  completeEmailProof,
  EmailProofError,
  requestEmailProofCode,
  type EmailProofHolder,
  type EmailProofPending,
  type EmailProofResult,
} from '@tinycloud/web-sdk/credentials';
import { credentialRequirementDigest } from '@tinycloud/sdk-core';
import { CourierError } from './errors.js';
import { requireFlag, type ParsedArgs } from './args.js';
import { cmd } from './program.js';
import { loadKey, profileDir, type AgentKey } from './profile.js';
import { bareDid } from './authority.js';
import {
  emailCredentialRequirement,
  removePendingEmailProof,
  savePendingEmailProof,
  StoredCredentialSource,
  takePendingEmailProof,
} from './credential-source.js';

type Step = 'request' | 'code' | 'credential' | 'session';

export interface CredentialDeps {
  home?: string;
  now?: () => Date;
  fetch?: typeof fetch;
  loadKey?: (home: string) => AgentKey;
  requestCode?: typeof requestEmailProofCode;
  completeProof?: typeof completeEmailProof;
  out?: (text: string) => void;
}

interface Resolved {
  home: string;
  now: () => Date;
  fetch: typeof fetch | undefined;
  loadKey: (home: string) => AgentKey;
  requestCode: typeof requestEmailProofCode;
  completeProof: typeof completeEmailProof;
  out: (text: string) => void;
}

const acquireUsage = () => `Usage: ${cmd('credential acquire --email <addr> [--code <8 digits>]')}`;
const showUsage = () => `Usage: ${cmd('credential show --email <addr>')}`;
const credentialUsage = () => `${acquireUsage()}\n${showUsage()}`;

/**
 * Holder adapter over Courier's did:key Ed25519 agent key. The private key stays
 * inside Node's KeyObject; only signature bytes leave this function.
 */
function holderFor(key: AgentKey): EmailProofHolder {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: key.jwk as JsonWebKey, format: 'jwk' });
  } catch {
    throw new CourierError('credential.request.HOLDER_INVALID', 'Agent signing key is unusable.');
  }
  return {
    did: bareDid(key.did),
    sign: async (bytes: Uint8Array) => new Uint8Array(cryptoSign(null, bytes, privateKey)),
  };
}

function isEmailProofError(error: unknown): error is EmailProofError {
  return error instanceof EmailProofError;
}

/**
 * Maps a witness-flow failure to a stable `credential.<step>.<CODE>` code. The
 * message never contains the verification code, the pending verifier, or key material.
 */
function mapEmailProofError(error: unknown, fallbackStep: Step): CourierError {
  if (isEmailProofError(error)) {
    const code = `credential.${error.step}.${error.code}`;
    if (error.code === 'RATE_LIMITED' && error.retryAfterMs !== undefined) {
      const minutes = Math.max(1, Math.ceil(error.retryAfterMs / 60_000));
      return new CourierError(code, `Too many verification codes were requested. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
    return new CourierError(code, error.message);
  }
  return new CourierError(`credential.${fallbackStep}.FAILED`, 'Email verification failed.');
}

/** Step-2 failures the owner can retry with the same pending request before it expires. */
const RETRYABLE_PROOF_CODES: Record<string, true> = { CODE_REJECTED: true, NETWORK: true, ISSUER_UNAVAILABLE: true, RATE_LIMITED: true };

/** Attempts-exhausted, session, signature, credential, and unknown failures are terminal. */
function keepsPendingAfterFailure(error: unknown): boolean {
  return isEmailProofError(error) && RETRYABLE_PROOF_CODES[error.code] === true;
}

async function acquire(args: ParsedArgs, deps: Resolved): Promise<void> {
  const address = requireFlag(args, 'email', acquireUsage()).trim();
  const key = deps.loadKey(deps.home);
  const holder = holderFor(key);

  if (!args.has('code')) {
    // Step 1: the witness emails an 8-digit code. Pending state is persisted until the owner supplies it.
    let pending: EmailProofPending;
    try {
      pending = await deps.requestCode({ address, holder, fetch: deps.fetch, now: deps.now });
    } catch (error) {
      throw mapEmailProofError(error, 'request');
    }
    savePendingEmailProof(pending, deps.home);
    deps.out(`Verification code sent to ${address}. Run \`${cmd(`credential acquire --email ${address} --code <8 digits>`)}\` within 15 minutes.\n`);
    return;
  }

  // Step 2: the owner supplies the code. It is used once here and never written anywhere.
  const code = args.get('code');
  if (code === undefined || code === 'true' || !/^\d{8}$/.test(code)) {
    throw new CourierError('credential.code.CODE_INVALID', 'Verification code must be 8 digits.');
  }

  // takePendingEmailProof deletes expired or malformed pending state, then throws.
  const pending = takePendingEmailProof(address, deps.now(), deps.home);
  if (pending.holderDid !== holder.did) {
    removePendingEmailProof(pending.requestId, deps.home);
    throw new CourierError('credential.session.SESSION_INVALID', 'Pending verification belongs to a different agent key. Request a new code.');
  }

  let result: EmailProofResult;
  try {
    result = await deps.completeProof({ pending, code, holder, fetch: deps.fetch, now: deps.now });
  } catch (error) {
    if (keepsPendingAfterFailure(error)) {
      // Retryable: the same pending request stays until its expiry.
      const mapped = mapEmailProofError(error, 'credential');
      throw new CourierError(mapped.code, `${mapped.message} Retry with --code before ${pending.expiresAt}.`);
    }
    // Terminal: attempts exhausted, session/signature/credential failure, or unknown. A new request is needed.
    removePendingEmailProof(pending.requestId, deps.home);
    throw mapEmailProofError(error, 'credential');
  }
  removePendingEmailProof(pending.requestId, deps.home);

  const requirement = emailCredentialRequirement(address);
  const requirementDigest = await credentialRequirementDigest(requirement);
  await new StoredCredentialSource(deps.home).store({
    verified: result.verified,
    requirement,
    requirementDigest,
    holderDid: holder.did,
    now: deps.now(),
  });
  deps.out(`Email credential stored for ${address}. It is valid for up to 1 hour from issuance.\n`);
}

async function show(args: ParsedArgs, deps: Resolved): Promise<void> {
  const address = requireFlag(args, 'email', showUsage()).trim();
  const holder = holderFor(deps.loadKey(deps.home));
  const requirement = emailCredentialRequirement(address);
  const requirementDigest = await credentialRequirementDigest(requirement);
  const record = await new StoredCredentialSource(deps.home).find({
    requirement,
    requirementDigest,
    holderDid: holder.did,
    now: deps.now(),
  });
  if (!record) {
    throw new CourierError('credential.show.NOT_FOUND', `No valid stored email credential for ${address}. Run \`${cmd(`credential acquire --email ${address}`)}\`.`);
  }
  // The bearer `credential` (SD-JWT) is never printed.
  deps.out(
    [
      `email: ${record.claims.email}`,
      `credentialId: ${record.credentialId}`,
      `issuedAt: ${record.issuedAt}`,
      `expiresAt: ${record.expiresAt}`,
      `status: ${record.status.method}`,
      '',
    ].join('\n'),
  );
}

export async function cmdCredential(args: ParsedArgs, deps: CredentialDeps = {}): Promise<void> {
  const resolved: Resolved = {
    home: deps.home ?? profileDir(),
    now: deps.now ?? (() => new Date()),
    fetch: deps.fetch,
    loadKey: deps.loadKey ?? ((home: string) => loadKey(home)),
    requestCode: deps.requestCode ?? requestEmailProofCode,
    completeProof: deps.completeProof ?? completeEmailProof,
    out: deps.out ?? ((text: string) => { process.stdout.write(text); }),
  };
  switch (args.positional[0]) {
    case 'acquire': return acquire(args, resolved);
    case 'show': return show(args, resolved);
    default: throw new CourierError('usage', credentialUsage());
  }
}
