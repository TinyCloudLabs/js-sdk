import { describe, expect, test } from "bun:test";
import { createDelegatedShareKey } from "./owner-policy";
import type { OwnerSharePolicyRegistrationReceipt } from "./owner-policy";
import {
  MemorySenderShareKeyStorage,
  MemorySenderShareRecordStorage,
  SenderShareStore,
} from "./sender-share-store";

function receiptFor(shareKeyDid: string, overrides?: Partial<OwnerSharePolicyRegistrationReceipt["registration"]>): OwnerSharePolicyRegistrationReceipt {
  return {
    registration: {
      registrationCid: "bafy-registration",
      policyCid: "bafy-policy",
      ownerDelegationCid: "bafy-owner-delegation",
      enforcementDelegationCid: "bafy-enforcement-delegation",
      ownerDid: "did:pkh:eip155:1:0xowner",
      shareKeyDid,
      enforcerDid: "did:key:z6MkEnforcer",
      shareId: "share-1",
      recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
      target: { origin: "https://share.tinycloud.xyz", nodeAudience: "did:web:tee.node.tinycloud.xyz", spaceId: "tinycloud:pkh:eip155:1:0xowner:applications" },
      resource: { kind: "exact", path: "shares/share-1/document.md" },
      actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
      contentSource: { kind: "kv", space: "tinycloud:pkh:eip155:1:0xowner:applications", path: "shares/share-1/document.md", action: "tinycloud.kv/get" },
      contentSourceDigest: "digest",
      registeredAt: "2029-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      ...overrides,
    },
    proof: { alg: "EdDSA", kid: "did:web:tee.node.tinycloud.xyz#key", signature: "sig" },
  };
}

describe("SenderShareStore", () => {
  test("rejects saving a receipt whose shareKeyDid does not match the provided key", async () => {
    const key = await createDelegatedShareKey({ extractable: false });
    const store = new SenderShareStore({ records: new MemorySenderShareRecordStorage(), keys: new MemorySenderShareKeyStorage() });
    await expect(store.save(receiptFor("did:key:z6MkSomeoneElse"), key)).rejects.toThrow("does not match");
  });

  test("persists a registered share and recovers a working signer after a reload", async () => {
    const key = await createDelegatedShareKey({ extractable: false });
    const records = new MemorySenderShareRecordStorage();
    const keys = new MemorySenderShareKeyStorage();
    const store = new SenderShareStore({ records, keys });

    const record = await store.save(receiptFor(key.did), key);
    expect(record.shareId).toBe("share-1");
    expect(record.registrationCid).toBe("bafy-registration");

    // Simulate a reload: a fresh store instance backed by the same storage.
    const reloaded = new SenderShareStore({ records, keys });
    const listed = await reloaded.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.shareId).toBe("share-1");

    const restoredKey = await reloaded.loadKey("share-1");
    expect(restoredKey).toBeDefined();
    expect(restoredKey?.did).toBe(key.did);
    const signature = await restoredKey!.sign(new TextEncoder().encode("reload-safe"));
    expect(signature).toHaveLength(64);
  });

  test("excludes expired shares from list unless includeExpired is set", async () => {
    const key = await createDelegatedShareKey({ extractable: false });
    const store = new SenderShareStore({ records: new MemorySenderShareRecordStorage(), keys: new MemorySenderShareKeyStorage() });
    await store.save(receiptFor(key.did, { shareId: "share-expired", expiresAt: "2000-01-01T00:00:00.000Z" }), key);
    expect(await store.list()).toHaveLength(0);
    expect(await store.list({ includeExpired: true })).toHaveLength(1);
  });

  test("resolves the direct and ancestor revocation targets and hides revoked shares by default", async () => {
    const key = await createDelegatedShareKey({ extractable: false });
    const store = new SenderShareStore({ records: new MemorySenderShareRecordStorage(), keys: new MemorySenderShareKeyStorage() });
    await store.save(receiptFor(key.did), key);

    expect(await store.revocationTarget("share-1", "direct")).toBe("bafy-enforcement-delegation");
    expect(await store.revocationTarget("share-1", "ancestor")).toBe("bafy-owner-delegation");

    const revoked = await store.markRevoked("share-1");
    expect(revoked.revokedAt).toBeDefined();
    expect(await store.list()).toHaveLength(0);
    expect(await store.list({ includeRevoked: true })).toHaveLength(1);
  });

  test("forgets a share and clears its persisted key handle", async () => {
    const key = await createDelegatedShareKey({ extractable: false });
    const records = new MemorySenderShareRecordStorage();
    const keys = new MemorySenderShareKeyStorage();
    const store = new SenderShareStore({ records, keys });
    await store.save(receiptFor(key.did), key);
    await store.remove("share-1");
    expect(await store.get("share-1")).toBeUndefined();
    expect(await store.loadKey("share-1")).toBeUndefined();
  });

  test("revocationTarget throws for an unknown share", async () => {
    const store = new SenderShareStore({ records: new MemorySenderShareRecordStorage(), keys: new MemorySenderShareKeyStorage() });
    await expect(store.revocationTarget("unknown", "direct")).rejects.toThrow("Unknown share");
  });
});
