import { signedBrowserSession } from "./fixtures/signed-browser-session";
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

const EXPIRED_SESSION = await signedBrowserSession(new Date(Date.now() - 60_000).toISOString());

function expiredSessionData() {
  return structuredClone(EXPIRED_SESSION);
}

describe("BrowserSessionStorage renewal candidates", () => {
  test("returns an expired record without deleting it, while ordinary loads keep expiring it", async () => {
    const storage = new MemoryStorage();
    const address = EXPIRED_SESSION.address;
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
