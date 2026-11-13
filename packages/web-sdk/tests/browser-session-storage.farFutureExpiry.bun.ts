import { describe, expect, it } from "bun:test";
import type { PersistedSessionData } from "@tinycloud/sdk-core";

import { BrowserSessionStorage } from "../src/adapters/BrowserSessionStorage";

// TC-2276: a user-chosen expiry can be years away. The persisted record must save, load and restore unchanged.

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  key(index: number): string | null { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string): void { this.items.delete(key); }
  setItem(key: string, value: string): void { this.items.set(key, value); }
}

function session(expiresAt: string): PersistedSessionData {
  return {
    address: ADDRESS,
    chainId: 1,
    sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "secret" }),
    siwe: `example.com wants you to sign in\n\nExpiration Time: ${expiresAt}`,
    signature: "0xsig",
    tinycloudSession: {
      delegationHeader: { Authorization: "Bearer delegation" },
      delegationCid: "bafydelegation",
      spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:default`,
      verificationMethod: "did:key:z6MkSession#z6MkSession",
    },
    expiresAt,
    createdAt: new Date().toISOString(),
    version: "1.0",
  };
}

describe("BrowserSessionStorage with a user-chosen expiry", () => {
  for (const years of [1, 9]) {
    it(`round-trips an expiry ${years} year(s) away unchanged`, async () => {
      const storage = new BrowserSessionStorage({ storage: new MemoryStorage() });
      const record = session(new Date(Date.now() + years * 365 * 24 * 60 * 60 * 1000).toISOString());
      await storage.save(ADDRESS, record);
      await expect(storage.loadWithStatus(ADDRESS)).resolves.toEqual({ status: "loaded", data: record });
    });
  }

  it("still refuses to save and to load an expiry in the past", async () => {
    const backend = new MemoryStorage();
    const storage = new BrowserSessionStorage({ storage: backend });
    const expired = session(new Date(Date.now() - 1_000).toISOString());
    await expect(Promise.resolve().then(() => storage.save(ADDRESS, expired))).rejects.toThrow("Session data is expired.");
  });
});
