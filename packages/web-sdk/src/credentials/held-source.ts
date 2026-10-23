import { CredentialError, type IKVService } from "@tinycloud/sdk-core";
import { pkhPrincipalsEqual } from "@tinycloud/sdk-core/held-credentials";
import {
  acquireEmailProof,
  type EmailProofAcquireInput,
  type EmailProofOptions,
  type EmailProofPendingStore,
  type HolderSigner,
} from "@tinycloud/node-sdk/credentials";
import {
  findHeldCredential,
  heldAccountOwner,
  HeldListingLimitError,
  pruneHeldCredentials,
  storeHeldCredential,
  type HeldIssuerPolicy,
  type HeldMatch,
} from "./held-store";

/** Held profile id. Its pin is disabled, so every acquisition is refused before network until the wire path ships. */
const HELD_PROFILE = "tinycloud.email-held/v1" as const;

export type HeldSourceErrorCode = "held-store-listing-limit";

/** Typed, non-retryable refusal. Its message carries no credential or email text. */
export class HeldSourceError extends Error {
  readonly code: HeldSourceErrorCode;
  readonly retryable = false;

  constructor(code: HeldSourceErrorCode, message: string) {
    super(message);
    this.name = "HeldSourceError";
    this.code = code;
  }
}

const LISTING_LIMIT_MESSAGE = "Saved held credentials list is too long to read; clear old ones";

/**
 * Owner-scoped find. On the listing-limit refusal it prunes the owner's expired records once and retries
 * the find once. A refusal that survives either step is a HeldSourceError. Any other error passes through
 * unchanged. Never re-acquires: that would spend the mailbox limit and add records to a full store.
 */
async function findWithListingRecovery(
  kv: IKVService,
  policy: HeldIssuerPolicy,
  owner: string,
  address: string,
  now: () => Date,
): Promise<HeldMatch | undefined> {
  try {
    return await findHeldCredential({ ...policy, kv, ownerDid: owner, email: address, now: now() });
  } catch (error) {
    if (!(error instanceof HeldListingLimitError)) throw error;
  }
  try {
    await pruneHeldCredentials({ ...policy, kv, ownerDid: owner, now: now() });
    return await findHeldCredential({ ...policy, kv, ownerDid: owner, email: address, now: now() });
  } catch (error) {
    if (error instanceof HeldListingLimitError) throw new HeldSourceError("held-store-listing-limit", LISTING_LIMIT_MESSAGE);
    throw error;
  }
}

export interface HeldAcquireInput extends HeldIssuerPolicy {
  readonly kv: IKVService;
  /** Email address to prove. Matched case-insensitively against stored records. */
  readonly address: string;
  /** Account holder. Its did must be did:pkh:eip155; its signer is supplied by the caller. */
  readonly holder: HolderSigner;
  /** Session principal, when one exists. Must be the same account as `holder`. */
  readonly sessionDid?: string;
  /** Caller-supplied code source. Not hard-wired here. */
  readonly getCode: NonNullable<EmailProofAcquireInput["getCode"]>;
  readonly pendingStore?: EmailProofPendingStore;
  readonly fetch?: EmailProofOptions["fetch"];
  readonly signal?: EmailProofOptions["signal"];
  readonly now?: () => Date;
}

export interface HeldCredentialResult {
  /** The verified SD-JWT, as stored. */
  readonly credential: string;
  /** Canonical account owner: did:pkh:eip155:<chain>:<EIP-55 address>. */
  readonly holderDid: string;
  readonly expiresAt: Date;
}

/**
 * Returns a verified, stored held credential for the account and email.
 * Order: owner canonicalisation, session match, reuse lookup, acquisition, store-on-issue.
 * Stored records are returned without network. A store failure after verification is VERIFIED_NOT_SAVED.
 */
export async function acquireHeldCredential(input: HeldAcquireInput): Promise<HeldCredentialResult> {
  const { kv, address, holder, sessionDid, getCode, pendingStore, fetch, signal, now: clock, ...policy } = input;
  const now = clock ?? (() => new Date());
  const holderDid = heldAccountOwner(holder.did);
  if (sessionDid !== undefined && !pkhPrincipalsEqual(sessionDid, holderDid)) {
    throw new CredentialError("HOLDER_MISMATCH", "Held acquisition holder must be the session account");
  }

  const cached = await findWithListingRecovery(kv, policy, holderDid, address, now);
  if (cached !== undefined) {
    return { credential: cached.record.credential, holderDid, expiresAt: cached.verified.expiresAt };
  }

  const acquisition = await acquireEmailProof({ address, holder, profile: HELD_PROFILE, getCode, pendingStore, fetch, signal, now });
  if (acquisition.status !== "issued") {
    throw new CredentialError("PROOF_REJECTED", "Held acquisition did not issue a credential");
  }
  const credential = acquisition.result.envelope.credential;
  try {
    await storeHeldCredential({ ...policy, kv, ownerDid: holderDid, sdJwt: credential, now: now() });
  } catch {
    throw new CredentialError("VERIFIED_NOT_SAVED", "Verified held credential could not be stored");
  }
  return { credential, holderDid, expiresAt: new Date(acquisition.result.expiresAt) };
}
