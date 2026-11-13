import { describe, expect, test } from "bun:test";
import { BrowserSessionStorage } from "../src/adapters/BrowserSessionStorage";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

function expiredSessionData() {
  return {
    address: "0x1234567890123456789012345678901234567890",
    chainId: 1,
    sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "public", d: "private" }),
    siwe: "signed original SIWE",
    signature: "owner signature",
    tinycloudSession: {
      delegationHeader: { Authorization: "Bearer original" },
      delegationCid: "bafkreioriginal",
      spaceId: "tinycloud:test:space",
      verificationMethod: "did:key:zsession#key-1",
    },
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    version: "1",
  };
}

describe("BrowserSessionStorage renewal candidates", () => {
  test("returns an expired record without deleting it, while ordinary loads keep expiring it", async () => {
    const storage = new MemoryStorage();
    const address = "0x1234567890123456789012345678901234567890";
    storage.setItem("renewal:" + address.toLowerCase(), JSON.stringify(expiredSessionData()));
    const sessions = new BrowserSessionStorage({ storage, keyPrefix: "renewal:" });

    const candidate = await sessions.loadRenewalCandidate(address);

    expect(candidate.status).toBe("renewal-candidate");
    if (candidate.status !== "renewal-candidate") throw new Error("expired record was not returned as a candidate");
    expect(new Date(candidate.data.expiresAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(storage.getItem("renewal:" + address.toLowerCase())).not.toBeNull();

    expect((await sessions.loadWithStatus(address)).status).toBe("expired");
    expect(storage.getItem("renewal:" + address.toLowerCase())).toBeNull();
  });
});
