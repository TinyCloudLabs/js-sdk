import { expect, test } from "bun:test";
import { liveStoredLease, restoreStoredSession } from "./profile.js";

const lease = "synthetic-lease-authorization";
const stored = { renewal: { receipt: { leaseAuthorization: lease, leaseExpiresAt: new Date(Date.now() + 86_400_000).toISOString() } } };
const coded = (code: string) => Object.assign(new Error(code), { code });

function fakeNode(restore: () => Promise<void>, renew: () => Promise<void> = async () => {}) {
  const calls: string[] = [];
  return {
    calls,
    restoreSession: async () => { calls.push("restore"); await restore(); },
    restoreSessionWithRenewal: async (_data: unknown, authorization: string) => { calls.push(`renew:${authorization}`); await renew(); },
  };
}

test("a session without a saved lease never takes the renewal path", async () => {
  const node = fakeNode(async () => { throw coded("AUTH_EXPIRED"); });
  await expect(restoreStoredSession(node, {}, {})).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  expect(node.calls).toEqual(["restore"]);
});

test("a live original grant restores normally even with a saved lease", async () => {
  const node = fakeNode(async () => {});
  await restoreStoredSession(node, {}, stored);
  expect(node.calls).toEqual(["restore"]);
});

test("after the original grant expires, the saved lease restores through the node", async () => {
  const node = fakeNode(async () => { throw coded("AUTH_EXPIRED"); });
  await restoreStoredSession(node, {}, stored);
  expect(node.calls).toEqual(["restore", `renew:${lease}`]);
});

test("any other restore failure is not retried as a renewal", async () => {
  const node = fakeNode(async () => { throw coded("INVALID_SESSION"); });
  await expect(restoreStoredSession(node, {}, stored)).rejects.toMatchObject({ code: "INVALID_SESSION" });
  expect(node.calls).toEqual(["restore"]);
});

test.each(["RENEWAL_LEASE_EXPIRED", "RENEWAL_AUTHORITY_INACTIVE", "RENEWAL_LEASE_ORIGINAL_EXPIRED"])(
  "a lease the node reports as ended (%s) reads as an expired session",
  async (code) => {
    const node = fakeNode(async () => { throw coded("AUTH_EXPIRED"); }, async () => { throw coded(code); });
    await expect(restoreStoredSession(node, {}, stored)).rejects.toMatchObject({ code: "AUTH_EXPIRED", cause: { code } });
  },
);

test("a node that cannot answer is not reported as an expired session", async () => {
  const unreachable = new TypeError("fetch failed");
  const node = fakeNode(async () => { throw coded("AUTH_EXPIRED"); }, async () => { throw unreachable; });
  await expect(restoreStoredSession(node, {}, stored)).rejects.toBe(unreachable);
});

test("a saved lease counts only until its signed end", () => {
  const now = Date.parse("2026-11-13T21:00:00.000Z");
  const lease = (leaseExpiresAt: unknown) => ({ renewal: { receipt: { leaseAuthorization: "lease", leaseExpiresAt } } });
  expect(liveStoredLease(lease("2026-11-13T21:00:00.001Z"), now)).toEqual({ authorization: "lease", expiresAt: "2026-11-13T21:00:00.001Z" });
  expect(liveStoredLease(lease("2026-11-13T21:00:00.000Z"), now)).toBeUndefined();
  expect(liveStoredLease(lease("not a date"), now)).toBeUndefined();
  expect(liveStoredLease({ renewal: { receipt: { leaseExpiresAt: "2026-11-14T00:00:00.000Z" } } }, now)).toBeUndefined();
});

test("an ended lease restores as the original grant alone, without asking the node", async () => {
  const ended = { renewal: { receipt: { leaseAuthorization: lease, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() } } };
  const node = fakeNode(async () => { throw coded("AUTH_EXPIRED"); });
  await expect(restoreStoredSession(node, {}, ended)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  expect(node.calls).toEqual(["restore"]);
});
