import { CourierError } from './errors.js';

/**
 * PLACEHOLDER. The real verifier lives on branch tc712/verify-proof (uncommitted in its worktree).
 * This stub never returns ok: every hello is held until the real module replaces this file.
 * The interface below matches that module's exports so the swap is a file replacement.
 */

/** Replay ledger: `has(replayKey)` is true when the caller has already consumed this credential for this invite. */
export interface SeenCredentials {
  has(replayKey: string): boolean;
}

export interface VerifyEmailProofInput {
  /** The credential string exactly as the invitee sent it in hello. */
  credential?: string;
  /** Possession proof from the same hello. */
  possession: string;
  expectEmail: string;
  inviteId: string;
  /** sha256 hex of the one-time key `x`. */
  oneTimeKeyHash: string;
  /** Unix milliseconds. Defaults to Date.now(). */
  now?: number;
  seenCredentials: SeenCredentials;
}

export type VerifyFailure =
  | 'no-credential'
  | 'bad-format'
  | 'issuer-not-pinned'
  | 'descriptor-mismatch'
  | 'from-the-future'
  | 'expired'
  | 'too-old'
  | 'address-mismatch'
  | 'bad-signature'
  | 'holder-mismatch'
  | 'bad-possession'
  | 'replayed';

export type VerifyEmailProofResult =
  | { ok: true; address: string; credentialId: string; issuedAt: string }
  | { ok: false; reason: VerifyFailure };

export async function verifyEmailProof(_input: VerifyEmailProofInput): Promise<VerifyEmailProofResult> {
  throw new CourierError('verifier-not-linked', 'Email proof verifier is not linked in this build.');
}
