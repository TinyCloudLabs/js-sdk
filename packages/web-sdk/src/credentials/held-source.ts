import { CredentialError, type IKVService } from "@tinycloud/sdk-core";
import { pkhPrincipalsEqual } from "@tinycloud/sdk-core/held-credentials";
import {
  acquireEmailProof,
  type EmailProofAcquireInput,
  type EmailProofAcquisition,
  type EmailProofOptions,
  type EmailProofPending,
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
  type StoreHeldCredentialResult,
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
 * Owner-scoped find. On the listing-limit refusal it prunes the owner's records once and retries the find
 * once. Prune deletes expired records AND, for each email, every verified record but the newest, so a valid
 * older record for the same email is removed too. A refusal that survives either step is a HeldSourceError.
 * Any other error passes through unchanged. Never re-acquires: that would spend the mailbox limit and add
 * records to a full store.
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

/** Acquisition step. Production passes `acquireEmailProof`; tests inject a fake to reach the success branch. */
export type HeldAcquireStep = (input: EmailProofAcquireInput) => Promise<EmailProofAcquisition>;

/**
 * Returns a verified, stored held credential for the account and email.
 * Order: owner canonicalisation, session match, reuse lookup, acquisition, store-on-issue.
 * Stored records are returned without network. A store failure after verification is VERIFIED_NOT_SAVED.
 */
export async function acquireHeldCredential(input: HeldAcquireInput): Promise<HeldCredentialResult> {
  return acquireHeldCredentialWith(input, acquireEmailProof);
}

/**
 * `acquireHeldCredential` with the acquisition step injected. Production calls `acquireHeldCredential`.
 * This seam exists so the issued branch can be exercised while the held profile pin stays disabled.
 */
export async function acquireHeldCredentialWith(input: HeldAcquireInput, acquire: HeldAcquireStep): Promise<HeldCredentialResult> {
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

  const acquisition = await acquire({
    address,
    holder,
    profile: HELD_PROFILE,
    getCode,
    pendingStore: scopeHeldPendingStore(pendingStore, holderDid, now),
    fetch,
    signal,
    now,
  });
  if (acquisition.status !== "issued") {
    throw new CredentialError("PROOF_REJECTED", "Held acquisition did not issue a credential");
  }
  const credential = acquisition.result.envelope.credential;
  let stored: StoreHeldCredentialResult;
  try {
    stored = await storeHeldCredential({ ...policy, kv, ownerDid: holderDid, sdJwt: credential, now: now() });
  } catch {
    throw new CredentialError("VERIFIED_NOT_SAVED", "Verified held credential could not be stored");
  }
  // The signed `exp` of the verified credential, never the witness response's own `expiresAt`.
  return { credential, holderDid, expiresAt: stored.verified.expiresAt };
}

/**
 * Scopes a shared pending store to one held owner. The did:key email flow uses the same store, so a held
 * acquisition must never resume, prompt for, or delete a pending request of another profile or holder.
 * Pending requests are matched by profile and by holder principal, never by string equality.
 */
export function scopeHeldPendingStore(store: EmailProofPendingStore | undefined, holderDid: string, now: () => Date): EmailProofPendingStore | undefined {
  if (store === undefined) return undefined;
  const owned = (pending: EmailProofPending | undefined): pending is EmailProofPending =>
    pending !== undefined && pending.profile === HELD_PROFILE && pkhPrincipalsEqual(pending.holderDid, holderDid);
  return {
    async findLive(address, now) {
      const pending = await store.findLive(address, now);
      return owned(pending) ? pending : undefined;
    },
    put: (pending) => store.put(pending),
    async delete(requestId) {
      if (owned(await store.get(requestId, now()))) await store.delete(requestId);
    },
    async get(requestId, now) {
      const pending = await store.get(requestId, now);
      return owned(pending) ? pending : undefined;
    },
  };
}
