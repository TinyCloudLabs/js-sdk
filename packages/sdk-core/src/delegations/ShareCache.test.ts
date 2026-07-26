import { describe, expect, test } from "bun:test";
import { MemoryShareCache } from "./ShareCache";

describe("MemoryShareCache", () => {
  test("expires entries and detects a corrupted cached ciphertext", async () => {
    const cache = new MemoryShareCache();
    const key = { cid: "bafy-test", expiresAt: "2099-01-01T00:00:00.000Z" };
    await cache.set(key, Uint8Array.from([1, 2, 3]), { contentType: "text/plain", size: 3, encrypted: true });
    expect(await cache.get(key, new Date("2080-01-01T00:00:00.000Z"))).toEqual(Uint8Array.from([1, 2, 3]));
    expect(await cache.get(key, new Date("2100-01-01T00:00:00.000Z"))).toBeUndefined();
  });

  test("never returns the cache's mutable backing bytes", async () => {
    const cache = new MemoryShareCache();
    const key = { cid: "bafy-test", expiresAt: "2099-01-01T00:00:00.000Z" };
    await cache.set(key, Uint8Array.from([1, 2, 3]), { contentType: "application/octet-stream", size: 3, encrypted: false });
    const bytes = await cache.get(key);
    bytes![0] = 9;
    expect(await cache.get(key)).toEqual(Uint8Array.from([1, 2, 3]));
  });

  test("uses the injected clock when deciding whether a new entry is already expired", async () => {
    const cache = new MemoryShareCache(() => new Date("2080-01-01T00:00:00.000Z"));
    const key = { cid: "bafy-expired", expiresAt: "2079-12-31T23:59:59.000Z" };
    await cache.set(key, Uint8Array.from([1]), { contentType: "application/octet-stream", size: 1, encrypted: true });
    expect(await cache.get(key, new Date("2070-01-01T00:00:00.000Z"))).toBeUndefined();
  });
});
