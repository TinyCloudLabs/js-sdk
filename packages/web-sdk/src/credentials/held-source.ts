import { CredentialError, decodeBase64Url, type IKVService } from "@tinycloud/sdk-core";
import { HeldCredentialError, IssuerSet, pkhPrincipalsEqual } from "@tinycloud/sdk-core/held-credentials";
import {
  acquireEmailProof,
  EMAIL_PROOF_PINS,
  type EmailProofAcquireInput,
  type EmailProofAcquisition,
  type EmailProofOptions,
  type EmailProofPending,
  type EmailProofPendingStore,
  type HolderSigner,
} from "@tinycloud/node-sdk/credentials";
import {
  heldAccountOwner,
  HELD_STORE_PERMISSION_DENIED_STATE,
  HeldListingLimitError,
  listHeldEmailCredentials,
  pruneHeldCredentials,
  storeHeldCredential,
  type HeldIssuerPolicy,
  type HeldMatch,
  type StoreHeldCredentialResult,
} from "./held-store";

/** Held profile id. Its pin is disabled by default: an acquisition needs the caller's per-call `allowHeldProfile: true`. */
const HELD_PROFILE = "tinycloud.email-held/v1" as const;
const HELD_VCT = "opencredentials.email/v1";
/** How far the client clock may be behind the issuer's: the post-issue bound, and how far ahead the reuse read looks. */
const CLOCK_SKEW_BOUND_MS = 300_000;

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
 * The caller's policy must accept the pinned issuer for the held profile now, or nothing is requested. No network: the witness mails
 * a code on the first challenge, and `storeHeldCredential` would refuse an unaccepted issuer only after that mail and the issuance.
 */
function assertPolicyAcceptsPinnedIssuer(policy: HeldIssuerPolicy, now: Date): void {
  const refuse = () => new CredentialError("VERIFICATION_FAILED", "The issuer policy does not accept the held credential issuer");
  const { issuerDid, issuerKid } = EMAIL_PROOF_PINS;
  if (!Array.isArray(policy.acceptedIssuers) || !policy.acceptedIssuers.some((a) => a.issuerDid === issuerDid && (a.kid === undefined || a.kid === issuerKid))) throw refuse();
  if (!IssuerSet.is(policy.issuerSet)) throw refuse();
  const entry = policy.issuerSet.resolveIssuer(issuerDid, issuerKid);
  const at = now.getTime();
  if (!entry || !entry.vcts.includes(HELD_VCT) || !entry.profiles.includes(HELD_PROFILE) || at < entry.notBefore || (entry.retiredAt !== null && at >= entry.retiredAt) || (entry.notAfter !== null && at >= entry.notAfter)) throw refuse();
}

/**
 * Strict read of the owner's held records: a store that cannot be read is OFFLINE (or PERMISSION_DENIED when the app session may not read it), never
 * "nothing stored". `listHeldEmailCredentials` throws those for a failed list or a failed get (not KV_NOT_FOUND); a throwing `kv` is wrapped here. Every
 * other refusal (truncated or too long a listing, a refused owner, a configuration error) passes through unchanged.
 */
async function readHeldStrictly(kv: IKVService, policy: HeldIssuerPolicy, owner: string, now: Date): Promise<readonly HeldMatch[]> {
  try {
    return await listHeldEmailCredentials({ ...policy, kv, ownerDid: owner, now });
  } catch (error) {
    if (error instanceof CredentialError || error instanceof HeldCredentialError) throw error;
    throw new CredentialError("OFFLINE", "Held credentials could not be read", { cause: error });
  }
}

/** The newest-expiring record among `matches`; the listing order (newest issued first) breaks ties. */
function latestExpiry(matches: readonly HeldMatch[]): HeldMatch | undefined {
  let best: HeldMatch | undefined;
  for (const match of matches) if (best === undefined || match.expiresAt.getTime() > best.expiresAt.getTime()) best = match;
  return best;
}

/**
 * Owner-scoped reuse lookup over the strict read. The read uses `now + 300 s`, so a record issued up to 300 s in a slow client's future is
 * found instead of re-acquired (conservative for expiry: a record is offered only if it expires more than 15 minutes after the real time).
 * On the listing-limit refusal it prunes the owner's records once and retries once. Prune deletes expired records AND, for each email, every
 * verified record but the newest, so a valid older record for the same email is removed too. A refusal that survives either step is a
 * HeldSourceError. Any other error passes through unchanged. Never re-acquires: that would spend the mailbox limit and add records to a full store.
 */
async function findWithListingRecovery(
  kv: IKVService,
  policy: HeldIssuerPolicy,
  owner: string,
  address: string,
  now: () => Date,
): Promise<HeldMatch | undefined> {
  const wanted = address.trim().replace(/[A-Z]+/g, (run) => run.toLowerCase());
  const reuse = async () => latestExpiry((await readHeldStrictly(kv, policy, owner, new Date(now().getTime() + CLOCK_SKEW_BOUND_MS))).filter((match) => match.email === wanted));
  try {
    return await reuse();
  } catch (error) {
    if (!(error instanceof HeldListingLimitError)) throw error;
  }
  try {
    await pruneHeldCredentials({ ...policy, kv, ownerDid: owner, now: now() });
    return await reuse();
  } catch (error) {
    if (error instanceof HeldListingLimitError) throw new HeldSourceError("held-store-listing-limit", LISTING_LIMIT_MESSAGE);
    throw error;
  }
}

/** The `iat` of an SD-JWT, read WITHOUT verifying it: only to choose the verification time. `storeHeldCredential` then verifies the signature. */
function credentialIssuedAtMs(credential: string): number {
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(credential.split("~")[0]!.split(".")[1]!)));
    const iat = typeof payload === "object" && payload !== null && "iat" in payload ? payload.iat : undefined;
    if (typeof iat === "number" && Number.isSafeInteger(iat)) return iat * 1000;
  } catch { /* fall through */ }
  throw new CredentialError("VERIFICATION_FAILED", "Issued credential is not readable");
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
  /** Per-call opt-in for the held profile (the pin stays disabled by default). Forwarded to the acquisition; without it a miss is refused PROFILE_UNAVAILABLE before any request. */
  readonly allowHeldProfile?: true;
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
  const { kv, address, holder, sessionDid, getCode, pendingStore, fetch, signal, now: clock, allowHeldProfile, ...policy } = input;
  const now = clock ?? (() => new Date());
  const holderDid = heldAccountOwner(holder.did);
  if (sessionDid !== undefined && !pkhPrincipalsEqual(sessionDid, holderDid)) {
    throw new CredentialError("HOLDER_MISMATCH", "Held acquisition holder must be the session account");
  }

  // The strict read comes first. Without the per-call opt-in a cache miss is PROFILE_UNAVAILABLE whatever the storage or the policy says: only an
  // unreadable store (OFFLINE, or PERMISSION_DENIED: no grant to read it) is allowed to fall through to the acquisition, which refuses before any request. A stored record is reused either way.
  const optedIn = allowHeldProfile === true;
  let cached: HeldMatch | undefined;
  try {
    cached = await findWithListingRecovery(kv, policy, holderDid, address, now);
  } catch (error) {
    if (optedIn || !(error instanceof CredentialError && (error.code === "OFFLINE" || error.code === "PERMISSION_DENIED"))) throw error;
  }
  if (cached !== undefined) {
    return { credential: cached.record.credential, holderDid, expiresAt: cached.verified.expiresAt };
  }
  // About to acquire, opted in: the caller's policy must accept the pinned issuer, before any request and so before any mail.
  if (optedIn) assertPolicyAcceptsPinnedIssuer(policy, now());

  const acquisition = await acquire({
    address,
    holder,
    profile: HELD_PROFILE,
    getCode,
    pendingStore: scopeHeldPendingStore(pendingStore, holderDid, now),
    fetch,
    signal,
    now,
    allowHeldProfile,
  });
  if (acquisition.status !== "issued") {
    throw new CredentialError("PROOF_REJECTED", "Held acquisition did not issue a credential");
  }
  const credential = acquisition.result.envelope.credential;
  // Verify at max(client, iat): the held verifier refuses now < nbf = iat, and a client up to 5 minutes slow must still store what was issued.
  const clientMs = now().getTime();
  const iatMs = credentialIssuedAtMs(credential);
  if (iatMs - clientMs > CLOCK_SKEW_BOUND_MS) throw new CredentialError("VERIFICATION_FAILED", "client clock is more than 5 minutes behind the issuer");
  let stored: StoreHeldCredentialResult;
  try {
    stored = await storeHeldCredential({ ...policy, kv, ownerDid: holderDid, sdJwt: credential, now: new Date(Math.max(clientMs, iatMs)) });
  } catch (error) {
    // A write the app may not make keeps VERIFIED_NOT_SAVED (a credential exists and is unsaved) and carries the fixed marker, nothing else.
    const permission = error instanceof CredentialError && error.details.state === HELD_STORE_PERMISSION_DENIED_STATE;
    throw new CredentialError("VERIFIED_NOT_SAVED", "Verified held credential could not be stored", permission ? { state: HELD_STORE_PERMISSION_DENIED_STATE } : {});
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
