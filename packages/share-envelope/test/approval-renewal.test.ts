import { expect, test } from "bun:test";
import { checkApprovalResultBinding } from "../src/links/approval-client.js";
import { approvalRenewalRequestSchema, approvalRenewalSchema } from "../src/links/approval-renewal.js";

const now = Date.parse("2026-11-13T06:00:00.000Z");
const expected = { requestId: "request", bodyCid: "request-cid", now,
  request: { issuer: "agent", targetDid: "agent", renewal: { version: 1 as const, leaseLifetimeSeconds: 90 * 86400 } } };
const renewal = { version: 1 as const, approvedAt: new Date(now).toISOString(), approvedLeaseLifetimeSeconds: 86400,
  receipt: { originalCid: "original", leaseCid: "lease", leaseAuthorization: "signed-proof",
    leaseExpiresAt: new Date(now + 86400000).toISOString(), leaseGeneration: 1,
    nodeIdentity: { nodeDid: "did:key:zNode", renewerDid: "did:key:zRenewer", renewerPublicKey: "key", renewerEpoch: 0 } } };
const result = { resultVersion: 1, requestId: "request", requestDigest: "request-cid", requesterDid: "agent", targetDid: "agent",
  ownerDid: "owner", delegationExpiresAt: new Date(now + 3600000).toISOString(), delegation: {}, renewalChoice: "leased", renewal };

test("leased and explicit finite choices retain the chosen renewal metadata", () => {
  expect(checkApprovalResultBinding(result, expected).renewal).toEqual(renewal);
  const { renewal: _, ...finite } = result;
  expect(checkApprovalResultBinding({ ...finite, renewalChoice: "finite" }, expected).renewal).toBeUndefined();
});

test("refuses missing choice, partial leased results, silent finite downgrade and unsolicited renewal", () => {
  for (const bad of [{ ...result, renewalChoice: undefined }, { ...result, renewal: undefined },
    { ...result, renewalChoice: "finite" }, { ...result, unexpected: true }]) {
    expect(() => checkApprovalResultBinding(bad, expected)).toThrow();
  }
  expect(() => checkApprovalResultBinding(result, { ...expected, request: { issuer: "agent", targetDid: "agent" } })).toThrow();
});

test("refuses excess chosen lifetime, future approval time and expiry beyond approved end", () => {
  for (const bad of [
    { ...renewal, approvedLeaseLifetimeSeconds: 91 * 86400 },
    { ...renewal, approvedAt: new Date(now + 120000).toISOString() },
    { ...renewal, receipt: { ...renewal.receipt, leaseExpiresAt: new Date(now + 86400001).toISOString() } },
  ]) expect(() => checkApprovalResultBinding({ ...result, renewal: bad }, expected)).toThrow();
});

test("strict nested codecs reject unknown fields, wrong versions and invalid integers", () => {
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, 366 * 86400]) {
    expect(approvalRenewalRequestSchema.safeParse({ version: 1, leaseLifetimeSeconds: bad }).success).toBe(false);
  }
  for (const bad of [{ ...renewal, extra: true }, { ...renewal, version: 2 },
    { ...renewal, receipt: { ...renewal.receipt, extra: true } },
    { ...renewal, receipt: { ...renewal.receipt, nodeIdentity: { ...renewal.receipt.nodeIdentity, extra: true } } },
  ]) expect(approvalRenewalSchema.safeParse(bad).success).toBe(false);
});

test('expired originals may only be staged explicitly with leased proof metadata, never finite', () => {
  const expired = { ...result, delegationExpiresAt: new Date(now - 1000).toISOString() };
  expect(() => checkApprovalResultBinding(expired, expected)).toThrow();
  expect(checkApprovalResultBinding(expired, { ...expected, allowExpiredRenewal: true }).renewal).toBeDefined();
  const { renewal: _, ...finite } = expired;
  expect(() => checkApprovalResultBinding({ ...finite, renewalChoice: 'finite' }, { ...expected, allowExpiredRenewal: true })).toThrow();
});
