import { LinkError } from "./errors.js";
import { z } from "zod";

/** D4: a lease lasts at most one year; the original grant has its own lifetime. */
export const MAX_APPROVAL_LEASE_SECONDS = 365 * 86_400;
const positiveSeconds = z.number().int().positive().safe().max(MAX_APPROVAL_LEASE_SECONDS);
const timestamp = z.string().datetime({ precision: 3 });
const did = z.string().startsWith("did:key:z");

export const approvalRenewalRequestSchema = z.object({
  version: z.literal(1), leaseLifetimeSeconds: positiveSeconds,
}).strict();

/** Metadata is not authority: the consumer must verify the signed grant and lease. */
export const approvalRenewalSchema = z.object({
  version: z.literal(1), approvedLeaseLifetimeSeconds: positiveSeconds, approvedAt: timestamp,
  receipt: z.object({
    originalCid: z.string().min(1), leaseCid: z.string().min(1), leaseAuthorization: z.string().min(1),
    leaseExpiresAt: timestamp, leaseGeneration: z.number().int().positive().safe(),
    nodeIdentity: z.object({
      nodeDid: did, renewerDid: did, renewerPublicKey: z.string().min(1),
      renewerEpoch: z.number().int().nonnegative().safe(),
    }).strict(),
  }).strict(),
}).strict().refine((value) => {
  const approved = Date.parse(value.approvedAt);
  const end = Date.parse(value.receipt.leaseExpiresAt);
  return end > approved && end <= approved + value.approvedLeaseLifetimeSeconds * 1000;
});

export type ApprovalRenewal = z.infer<typeof approvalRenewalSchema>;

/** Revalidate persisted renewal metadata before consuming its signed proofs. */
export function parseApprovalRenewal(value: unknown): ApprovalRenewal {
  const parsed = approvalRenewalSchema.safeParse(value);
  if (!parsed.success) throw new LinkError("body_validation_failed", "invalid approval renewal");
  return parsed.data;
}
