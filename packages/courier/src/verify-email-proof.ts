import { CourierError } from './errors.js';

// PLACEHOLDER: replaced by the real verifier (tc712/verify-proof). Same exports; never returns ok.
export interface SeenCredentials {
  has(replayKey: string): boolean;
}

export interface VerifyEmailProofInput {
  credential?: string;
  possession: string;
  expectEmail: string;
  inviteId: string;
  oneTimeKeyHash: string;
  now?: number;
  seenCredentials: SeenCredentials;
}

export type VerifyFailure = 'no-credential' | 'bad-format' | 'issuer-not-pinned' | 'descriptor-mismatch' | 'from-the-future' | 'expired' | 'too-old' | 'address-mismatch' | 'bad-signature' | 'holder-mismatch' | 'bad-possession' | 'replayed';

export type VerifyEmailProofResult = { ok: true; address: string; credentialId: string; issuedAt: string } | { ok: false; reason: VerifyFailure };

export async function verifyEmailProof(_input: VerifyEmailProofInput): Promise<VerifyEmailProofResult> {
  throw new CourierError('verifier-not-linked', 'Email proof verifier is not linked in this build.');
}
