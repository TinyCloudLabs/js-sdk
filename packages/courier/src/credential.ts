import { createPrivateKey, sign as cryptoSign, type JsonWebKey, type KeyObject } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  completeEmailProof,
  createEd25519HolderSigner,
  EmailProofError,
  emailProofRequirement,
  requestEmailProofCode,
  type EmailProofPending,
  type EmailProofResult,
  type HolderSigner,
} from '@tinycloud/node-sdk/credentials';
import { createFileEmailProofPendingStore, PendingStoreError, type FileEmailProofPendingStore } from '@tinycloud/node-sdk/credential-pending-store';
import { credentialRequirementDigest } from '@tinycloud/sdk-core';
import { CourierError } from './errors.js';
import { requireFlag, type ParsedArgs } from './args.js';
import { cmd } from './program.js';
import { loadKey, profileDir, type AgentKey } from './profile.js';
import { StoredCredentialSource } from './credential-source.js';

type Step = 'request' | 'code' | 'credential' | 'session';

export interface CredentialDeps {
  home?: string;
  now?: () => Date;
  fetch?: typeof fetch;
  loadKey?: (home: string) => AgentKey;
  requestCode?: typeof requestEmailProofCode;
  completeProof?: typeof completeEmailProof;
  /** Reads the first line of stdin for `--code-stdin`. */
  readStdinLine?: () => Promise<string>;
  out?: (text: string) => void;
}

interface Resolved {
  home: string;
  now: () => Date;
  fetch: typeof fetch | undefined;
  loadKey: (home: string) => AgentKey;
  requestCode: typeof requestEmailProofCode;
  completeProof: typeof completeEmailProof;
  readStdinLine: () => Promise<string>;
  out: (text: string) => void;
}

const acquireUsage = () => `Usage: ${cmd('credential acquire --email <addr> [--code-stdin]')}`;
const showUsage = () => `Usage: ${cmd('credential show --email <addr>')}`;
const credentialUsage = () => `${acquireUsage()}\n${showUsage()}`;

/**
 * Holder over Courier's did:key Ed25519 agent key. The private key stays inside
 * Node's KeyObject; only signature bytes leave this function.
 */
function holderFor(key: AgentKey): HolderSigner {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: key.jwk as JsonWebKey, format: 'jwk' });
  } catch {
    throw new CourierError('credential.request.HOLDER_INVALID', 'Agent signing key is unusable.');
  }
  try {
    return createEd25519HolderSigner(key.did, async (bytes: Uint8Array) => new Uint8Array(cryptoSign(null, bytes, privateKey)));
  } catch (error) {
    throw mapEmailProofError(error, 'request');
  }
}

function isEmailProofError(error: unknown): error is EmailProofError {
  return error instanceof EmailProofError;
}

/**
 * Maps a witness-flow failure to a stable `credential.<step>.<CODE>` code. The
 * message never contains the verification code, the pending verifier, or key material.
 */
function mapEmailProofError(error: unknown, fallbackStep: Step): CourierError {
  if (isEmailProofError(error)) return new CourierError(`credential.${error.step}.${error.code}`, error.message);
  return new CourierError(`credential.${fallbackStep}.FAILED`, 'Email verification failed.');
}

/** The witness marks which failures leave the pending request usable for another code. */
function keepsPendingAfterFailure(error: unknown): boolean {
  return isEmailProofError(error) && error.recoverable;
}

/** Pending-store failures keep their store codes (`credential-permissions`, `credential-store-invalid`). */
async function withStoreErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PendingStoreError) throw new CourierError(error.code, error.message);
    throw error;
  }
}

async function readStdinFirstLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return '';
}

async function acquire(args: ParsedArgs, deps: Resolved): Promise<void> {
  const address = requireFlag(args, 'email', acquireUsage()).trim();
  if (args.has('code') && args.has('code-stdin')) throw new CourierError('usage', acquireUsage());
  const key = deps.loadKey(deps.home);
  const holder = holderFor(key);
  const store: FileEmailProofPendingStore = createFileEmailProofPendingStore({ home: deps.home });

  if (!args.has('code') && !args.has('code-stdin')) {
    // Step 1: the witness emails an 8-digit code. Pending state persists until the owner supplies it.
    let pending: EmailProofPending;
    try {
      pending = await deps.requestCode({ address, holder, fetch: deps.fetch, now: deps.now });
    } catch (error) {
      throw mapEmailProofError(error, 'request');
    }
    await withStoreErrors(async () => {
      // At most one live request per address: the older request is replaced.
      const existing = await store.findLive(address, deps.now());
      if (existing) await store.delete(existing.requestId);
      await store.put(pending);
    });
    deps.out(`Verification code sent to ${address}. Run \`${cmd(`credential acquire --email ${address} --code-stdin`)}\` and enter the code within 15 minutes.\n`);
    return;
  }

  // Step 2: the code is validated before any store or network access, then used once and never written.
  const code = args.has('code-stdin') ? (await deps.readStdinLine()).trim() : (args.get('code') ?? '');
  if (!/^\d{8}$/.test(code)) throw new CourierError('credential.code.CODE_INVALID', 'Verification code must be 8 digits.');

  const pending = await withStoreErrors(() => store.findLive(address, deps.now()));
  if (!pending) {
    throw new CourierError('credential-request-missing', `No pending verification for ${address}. Run \`${cmd(`credential acquire --email ${address}`)}\` first.`);
  }
  if (pending.holderDid !== holder.did) {
    await withStoreErrors(() => store.delete(pending.requestId));
    throw new CourierError('credential.session.SESSION_INVALID', 'Pending verification belongs to a different agent key. Request a new code.');
  }

  let result: EmailProofResult;
  try {
    result = await deps.completeProof({ pending, code, holder, fetch: deps.fetch, now: deps.now });
  } catch (error) {
    if (keepsPendingAfterFailure(error)) {
      // Retryable: the same pending request stays until its expiry.
      const mapped = mapEmailProofError(error, 'credential');
      throw new CourierError(mapped.code, `${mapped.message} Retry with --code-stdin before ${pending.expiresAt}.`);
    }
    // Terminal: attempts exhausted, session/signature/credential failure, or unknown. A new request is needed.
    await withStoreErrors(() => store.delete(pending.requestId));
    throw mapEmailProofError(error, 'credential');
  }

  const requirement = emailProofRequirement(address);
  const requirementDigest = await credentialRequirementDigest(requirement);
  await new StoredCredentialSource(deps.home).store({
    verified: result.verified,
    requirement,
    requirementDigest,
    holderDid: holder.did,
    now: deps.now(),
  });
  await withStoreErrors(() => store.delete(pending.requestId));
  deps.out(`Email credential stored for ${address}. It is valid for up to 1 hour from issuance.\n`);
}

async function show(args: ParsedArgs, deps: Resolved): Promise<void> {
  const address = requireFlag(args, 'email', showUsage()).trim();
  const holder = holderFor(deps.loadKey(deps.home));
  const requirement = emailProofRequirement(address);
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
    readStdinLine: deps.readStdinLine ?? readStdinFirstLine,
    out: deps.out ?? ((text: string) => { process.stdout.write(text); }),
  };
  switch (args.positional[0]) {
    case 'acquire': return acquire(args, resolved);
    case 'show': return show(args, resolved);
    default: throw new CourierError('usage', credentialUsage());
  }
}
