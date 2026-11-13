import { parseSignedSiweCacao } from "./cacao";
import { principalDidEquals } from "../identity";
import { assertRenewalNodeIdentity, type RenewalNodeIdentity } from "./renewal";

/** An owner-approved renewal as returned with an approval result (share-envelope `ApprovalRenewal`, already parsed). */
export interface OwnerRenewalApproval {
  readonly approvedAt: string;
  readonly approvedLeaseLifetimeSeconds: number;
  readonly receipt: {
    readonly originalCid: string;
    readonly leaseCid: string;
    readonly leaseAuthorization: string;
    readonly leaseExpiresAt: string;
    readonly nodeIdentity: RenewalNodeIdentity;
  };
}

/** The signed original grant the lease must renew, as received with the approval. */
export interface OwnerRenewalOriginal {
  readonly delegationHeader: { readonly Authorization: string };
  readonly delegationCid: string;
  /** The agent key the original grant delegates to. */
  readonly verificationMethod: string;
}

export const RENEWAL_LEASE_MISMATCH = "RENEWAL_LEASE_MISMATCH";

/** The lease or its receipt does not match the signed original grant or the verified node. */
export class OwnerRenewalMismatchError extends Error {
  readonly code = RENEWAL_LEASE_MISMATCH;
  constructor(message: string) {
    super(message);
    this.name = "OwnerRenewalMismatchError";
  }
}

/** Three production scheduler intervals (300 s each): a new lease is never admitted closer than this to original expiry. */
export const RENEWAL_ADMISSION_LEAD_MS = 15 * 60_000;

/**
 * Verify the signed lease against the signed original grant before saving it. Receipt metadata
 * alone is never authority. Live node admission is checked separately by renewal restore.
 * Returns the original grant's signed expiry.
 */
export async function verifyOwnerRenewalLease(
  original: OwnerRenewalOriginal,
  ownerDid: string,
  renewal: OwnerRenewalApproval,
): Promise<{ originalExpiresAt: string }> {
  const parsed = await parseSignedSiweCacao(original.delegationHeader.Authorization.replace(/^Bearer\s+/i, ""), original.delegationCid);
  const { receipt } = renewal;
  const lease = await parseSignedSiweCacao(receipt.leaseAuthorization.replace(/^Bearer\s+/i, ""), receipt.leaseCid);
  const now = Date.now();
  const approved = Date.parse(renewal.approvedAt);
  const originalStart = Date.parse(parsed.notBefore ?? parsed.issuedAt);
  const leaseStart = Date.parse(lease.notBefore ?? lease.issuedAt);
  const resource = lease.attenuation[`urn:cid:${parsed.cid}`];
  const caveats = resource?.["tinycloud.delegation/renew"];
  if (parsed.proofs.length !== 0 || lease.proofs.length !== 0
    || !Number.isFinite(originalStart) || !Number.isFinite(leaseStart)
    || originalStart > approved + 60_000 || leaseStart > now + 60_000
    || receipt.originalCid !== parsed.cid || !principalDidEquals(parsed.issuer, ownerDid)
    || !principalDidEquals(lease.issuer, ownerDid) || !principalDidEquals(parsed.audience, original.verificationMethod)
    || lease.audience !== receipt.nodeIdentity.renewerDid
    || Object.keys(lease.attenuation).length !== 1 || !resource || Object.keys(resource).length !== 1
    || !Array.isArray(caveats) || caveats.length !== 1 || !caveats[0] || typeof caveats[0] !== "object"
    || Array.isArray(caveats[0]) || Object.keys(caveats[0]).length !== 0
    || !lease.expiresAt || new Date(lease.expiresAt).toISOString() !== receipt.leaseExpiresAt
    || !parsed.expiresAt || approved >= Date.parse(parsed.expiresAt)
    || Date.parse(receipt.leaseExpiresAt) <= now) {
    throw new OwnerRenewalMismatchError("The renewal lease does not match the signed owner grant.");
  }
  return { originalExpiresAt: parsed.expiresAt };
}

/** The node identity a live host reports must be the one the owner's lease was issued to. */
export function assertOwnerRenewalNodeIdentity(renewal: OwnerRenewalApproval, live: RenewalNodeIdentity): void {
  assertRenewalNodeIdentity(live);
  assertRenewalNodeIdentity(renewal.receipt.nodeIdentity);
  const expected = renewal.receipt.nodeIdentity;
  if (live.nodeDid !== expected.nodeDid || live.renewerDid !== expected.renewerDid
    || live.renewerPublicKey !== expected.renewerPublicKey || live.renewerEpoch !== expected.renewerEpoch) {
    throw new OwnerRenewalMismatchError("The renewal node identity does not match the verified host.");
  }
}
