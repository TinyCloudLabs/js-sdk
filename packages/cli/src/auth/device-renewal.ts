import { activateSessionWithHost, parseSignedSiweCacao } from "@tinycloud/sdk-core";
import { admitOwnerRenewalLease, assertRenewalNodeIdentity, RENEWAL_RENEWER_CHANGED } from "@tinycloud/sdk-core/delegations/renewal";
import { verifyOwnerRenewalLease, type OwnerRenewalOriginal } from "@tinycloud/sdk-core/delegations/renewal-receipt";
import { parseApprovalRenewal, type ApprovalRenewal } from "@tinycloud/share-envelope/links";
import { CLOCK_SKEW_MS } from "./scoped-login.js";

const ADMISSION_AGE_MS = 8 * 60_000;
const ADMISSION_AFTER_RECEIPT_MS = 60_000;
const NODE_CALL_MS = 5000;

export type DeviceRenewalReason =
  | "renewal_declined" | "renewal_wallet_unsupported" | "renewal_unavailable"
  | "renewal_invalid_receipt" | "renewal_no_extension" | "renewal_admission_expired" | "renewal_admission_failed";

type DeviceRenewalOutcome = { renewal?: undefined } | { renewal: ApprovalRenewal } | { renewal: null; renewalReason: DeviceRenewalReason };

export async function admitDeviceRenewal(input: {
  renewal: unknown;
  reason: unknown;
  askedSeconds: number | undefined;
  original: OwnerRenewalOriginal;
  ownerDid: string;
  spaceId: string;
  expiresAt: string;
  nodeOrigin: string;
  /** From the successful, redirect-refusing token poll to the configured OpenKey origin. */
  serverTime: unknown;
  pollStartedAt: number;
  receivedAt: number;
}): Promise<DeviceRenewalOutcome> {
  const finite = (renewalReason: DeviceRenewalReason) => ({ renewal: null, renewalReason });
  if (input.askedSeconds === undefined) {
    return input.renewal == null ? {} : finite("renewal_invalid_receipt");
  }
  if (input.renewal === undefined && input.reason === undefined) return finite("renewal_unavailable");
  if (input.renewal === null && (input.reason === "renewal_declined" || input.reason === "renewal_wallet_unsupported")) {
    return finite(input.reason);
  }
  if (input.reason !== undefined) return finite("renewal_invalid_receipt");

  let renewal: ApprovalRenewal;
  let issuedAt: number;
  let signedEnd: string;
  const originalEnd = Date.parse(input.expiresAt);
  try {
    renewal = parseApprovalRenewal(input.renewal);
    const { receipt, approvedLeaseLifetimeSeconds } = renewal;
    if (receipt.leaseGeneration !== 1 || approvedLeaseLifetimeSeconds > input.askedSeconds) return finite("renewal_invalid_receipt");
    assertRenewalNodeIdentity(receipt.nodeIdentity);
    const signed = await verifyOwnerRenewalLease(input.original, input.ownerDid, renewal);
    // The shared receipt verifier binds both proofs but does not return lease iat.
    const lease = await parseSignedSiweCacao(receipt.leaseAuthorization.replace(/^Bearer\s+/i, ""), receipt.leaseCid);
    issuedAt = Date.parse(lease.issuedAt);
    signedEnd = signed.leaseSignedExpiresAt;
    if (issuedAt !== Date.parse(renewal.approvedAt) || Date.parse(signedEnd) - issuedAt !== approvedLeaseLifetimeSeconds * 1000 ||
        Date.parse(signed.originalExpiresAt) !== originalEnd) return finite("renewal_invalid_receipt");
  } catch {
    return finite("renewal_invalid_receipt");
  }
  if (Date.parse(signedEnd) <= originalEnd) return finite("renewal_no_extension");

  const serverTime = typeof input.serverTime === "string" ? Date.parse(input.serverTime) : NaN;
  if (!Number.isFinite(serverTime) || new Date(serverTime).toISOString() !== input.serverTime || issuedAt - serverTime > CLOCK_SKEW_MS) {
    return finite("renewal_admission_expired");
  }
  // Charge the full request time as transit, and never use future skew to extend the budget.
  const deadline = Math.min(input.receivedAt + ADMISSION_AFTER_RECEIPT_MS,
    input.pollStartedAt + ADMISSION_AGE_MS - Math.max(0, serverTime - issuedAt));
  const callSignal = () => {
    const remaining = Math.floor(deadline - performance.now());
    return remaining > 0 ? AbortSignal.timeout(Math.min(remaining, NODE_CALL_MS)) : undefined;
  };
  try {
    const { original, nodeOrigin } = input;
    const replaySignal = callSignal();
    if (!replaySignal) return finite("renewal_admission_expired");
    const registered = await activateSessionWithHost(nodeOrigin, original.delegationHeader, replaySignal);
    if (replaySignal.aborted || !registered.success ||
        (registered.commitEventCid !== undefined && registered.commitEventCid !== original.delegationCid)) {
      return finite("renewal_admission_failed");
    }
    const signal = callSignal();
    if (!signal) return finite("renewal_admission_expired");
    const { receipt } = renewal;
    await admitOwnerRenewalLease({ host: nodeOrigin, originalAuthorization: original.delegationHeader.Authorization,
      originalCid: original.delegationCid, ownerDid: input.ownerDid, agentDid: original.verificationMethod, spaceId: input.spaceId,
      nodeIdentity: receipt.nodeIdentity, leaseAuthorization: receipt.leaseAuthorization, leaseCid: receipt.leaseCid,
      leaseExpiresAt: signedEnd, signal });
    return signal.aborted || performance.now() >= deadline ? finite("renewal_admission_failed") : { renewal };
  } catch (error) {
    return finite(error instanceof Error && "code" in error && error.code === RENEWAL_RENEWER_CHANGED
      ? "renewal_invalid_receipt" : "renewal_admission_failed");
  }
}
