import { describe, expect, it } from "bun:test";
import {
  MemoryEncryptedShareHistoryStorage,
  EncryptedSenderShareHistory,
  authorizeShare,
  listShares,
  notifyShare,
  recipientMatchesShareRecord,
  revokeShare,
  normalizeShareTarget,
  publishPolicyShare,
  type SenderShareRecord,
} from "../src/index.js";

const record: SenderShareRecord = {
  shareId: "share-1",
  registrationCid: "bafy-registration",
  policyCid: "bafy-policy",
  ownerDelegationCid: "bafy-owner",
  enforcementDelegationCid: "bafy-enforcement",
  shareKeyDid: "did:key:z6Mkshare",
  ownerDid: "did:key:z6Mkowner",
  enforcerDid: "did:web:node.example",
  target: { origin: "https://node.example", nodeAudience: "did:web:node.example", spaceId: "space" },
  resource: { kind: "exact", path: "shares/one/readme.md" },
  actions: ["tinycloud.kv/get"],
  recipientMatcher: { kind: "bearer" },
  targetKind: "bearer",
  registeredAt: "2026-07-01T00:00:00.000Z",
  expiresAt: "2030-01-01T00:00:00.000Z",
};

describe("Share lifecycle and authorization parity", () => {
  it("returns a resumable OpenKey outcome without serializing secrets", async () => {
    const result = await authorizeShare({
      envelope: {} as never,
      method: "openkey-device",
      adapter: {
        async begin() { return { state: "authorization-required", method: "openkey-device", resumeToken: "0123456789abcdef" }; },
        async resume() { return { state: "ready", value: "session" }; },
      },
    });
    expect(result).toMatchObject({ state: "authorization-required", method: "openkey-device" });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("uses one idempotency identity across delivery retries and reports partial failure", async () => {
    const keys: string[] = [];
    const result = await notifyShare({
      shareId: "share-1",
      recipient: "person@example.com",
      maxAttempts: 2,
      adapter: { async deliver(input) { keys.push(input.idempotencyKey!); throw new Error("offline"); } },
    });
    expect(result.state).toBe("partial-failure");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^tinycloud-share:share-1:[A-Za-z0-9_-]{43}$/);
    const other = await notifyShare({
      shareId: "share-1",
      recipient: "other@example.com",
      maxAttempts: 1,
      adapter: { async deliver(input) { keys.push(input.idempotencyKey!); throw new Error("offline"); } },
    });
    expect(other.state).toBe("partial-failure");
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("derives notification recipients from the stored matcher", async () => {
    const exact = { ...record, targetKind: "email" as const, recipientMatcher: { kind: "exactEmail" as const, value: "Alice@example.com" } };
    expect(recipientMatchesShareRecord(exact, "Alice@example.com")).toBe(true);
    expect(recipientMatchesShareRecord(exact, "Mallory@example.com")).toBe(false);
    const domain = { ...record, targetKind: "emailDomain" as const, recipientMatcher: { kind: "emailDomain" as const, value: "example.com" } };
    expect(recipientMatchesShareRecord(domain, "alice@example.com")).toBe(true);
    expect(recipientMatchesShareRecord(domain, "alice@other.example")).toBe(false);
    await expect(notifyShare({ shareId: exact.shareId, recipient: "Mallory@example.com", record: exact, adapter: { async deliver() { throw new Error("must not deliver"); } } })).rejects.toThrow(/stored share target/);
  });

  it("never reports bearer deletion as cryptographic revocation", async () => {
    await expect(revokeShare({ record })).resolves.toEqual({ state: "retention-only", target: "bearer", reason: "bearer-capability-cannot-be-revoked" });
  });

  it("classifies a missing addressed revocation authority as unsupported target", async () => {
    const addressed = { ...record, targetKind: "recipientDid" as const, recipientMatcher: { kind: "recipientDid" as const, value: "did:key:z6Mkrecipient" } };
    await expect(revokeShare({ record: addressed })).resolves.toEqual({
      state: "unsupported",
      target: "recipientDid",
      reason: "node revocation authority is required",
      code: "unsupported-target",
    });
  });

  it("revokes the owner delegation for ancestor scope", async () => {
    const calls: string[] = [];
    const addressed = { ...record, targetKind: "recipientDid" as const, recipientMatcher: { kind: "recipientDid" as const, value: "did:key:z6Mkrecipient" } };
    await expect(revokeShare({ record: addressed, scope: "ancestor", adapter: { async revokeDelegation(input) { calls.push(`${input.delegationCid}:${input.scope}`); } } })).resolves.toMatchObject({ state: "revoked", delegationCid: "bafy-owner" });
    expect(calls).toEqual(["bafy-owner:ancestor"]);
  });

  it("persists the revocation receipt state after a successful revoke", async () => {
    const records = new Map<string, SenderShareRecord>();
    const storage = {
      async put(value: SenderShareRecord) { records.set(value.shareId, value); },
      async list() { return [...records.values()]; },
      async get(shareId: string) { return records.get(shareId); },
      async delete(shareId: string) { records.delete(shareId); },
    };
    await storage.put({ ...record, targetKind: "recipientDid", recipientMatcher: { kind: "recipientDid", value: "did:key:z6Mkrecipient" } });
    const result = await revokeShare({
      record: (await storage.get("share-1"))!,
      records: storage,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
      adapter: { async revokeDelegation() {} },
    });
    expect(result).toMatchObject({ state: "revoked", revokedAt: "2026-07-29T12:00:00.000Z" });
    expect((await storage.get("share-1"))?.revokedAt).toBe("2026-07-29T12:00:00.000Z");
  });

  it("normalizes exact-email and domain policy targets and keeps claim resumable", async () => {
    expect(normalizeShareTarget({ kind: "email", address: "Alice@Example.COM" })).toEqual({ kind: "email", address: "Alice@example.com" });
    expect(normalizeShareTarget({ kind: "emailDomain", domain: "Example.COM" })).toEqual({ kind: "emailDomain", domain: "example.com" });
    expect(normalizeShareTarget({ kind: "recipientDid", did: "did:web:recipient.example:path" })).toEqual({ kind: "recipientDid", did: "did:web:recipient.example:path" });
    expect(() => normalizeShareTarget({ kind: "recipientDid", did: "did:key:zholder" })).toThrow(/recipient DID/);
    const called: string[] = [];
    const outcome = await publishPolicyShare({
      source: new TextEncoder().encode("# policy"),
      filename: "policy.md",
      target: { kind: "email", address: "Alice@Example.COM" },
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      origin: "https://share.tinycloud.xyz",
      notify: true,
      adapter: {
        async publishPolicy(input) { called.push(`${input.target.kind}:${input.notify}`); return { state: "authorization-required", method: "email-claim", resumeToken: "0123456789abcdef" }; },
        async claim() { return { state: "authorization-required", method: "email-otp", resumeToken: "fedcba9876543210" }; },
      },
    });
    expect(outcome).toMatchObject({ state: "authorization-required", method: "email-claim" });
    expect(called).toEqual(["email:true"]);
  });

  it("encrypts history bytes and redacts bearer links from list output", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const storage = new MemoryEncryptedShareHistoryStorage();
    const history = new EncryptedSenderShareHistory(storage, key as CryptoKey);
    await history.put(record);
    const raw = await storage.list();
    expect(raw[0]).toBeDefined();
    expect(new TextDecoder().decode(raw[0])).not.toContain("https://");
    const records = await history.list();
    expect(records[0]?.shareId).toBe("share-1");
    const view = await listShares({ list: async () => records, get: async () => records[0], put: async () => undefined, delete: async () => undefined });
    expect(view[0]).not.toHaveProperty("link");
  });
});
