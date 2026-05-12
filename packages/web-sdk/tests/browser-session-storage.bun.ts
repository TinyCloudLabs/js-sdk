import { describe, expect, it } from "bun:test";
import type { PersistedSessionData } from "@tinycloud/sdk-core";

import { BrowserSessionStorage } from "../src/adapters/BrowserSessionStorage";
import {
  clientSessionFromPersisted,
  restoreDataFromPersisted,
} from "../src/modules/browserSessionPersistence";

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

function persistedSession(overrides: Partial<PersistedSessionData> = {}): PersistedSessionData {
  const now = new Date();
  return {
    address: ADDRESS,
    chainId: 1,
    sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "secret" }),
    siwe: "example.com wants you to sign in\n\nExpiration Time: 2999-01-01T00:00:00.000Z",
    signature: "0xsig",
    tinycloudSession: {
      delegationHeader: { Authorization: "Bearer delegation" },
      delegationCid: "bafydelegation",
      spaceId: "space://tinycloud/1/owner/default",
      verificationMethod: "did:key:z6MkSession#z6MkSession",
    },
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    createdAt: now.toISOString(),
    version: "1.0",
    ...overrides,
  };
}

describe("BrowserSessionStorage", () => {
  it("loads a valid persisted session with status", async () => {
    const storage = new BrowserSessionStorage({ storage: new MemoryStorage() });
    const session = persistedSession();

    await storage.save(ADDRESS, session);

    await expect(storage.loadWithStatus(ADDRESS)).resolves.toEqual({
      status: "loaded",
      data: session,
    });
  });

  it("rejects and removes expired sessions", async () => {
    const backend = new MemoryStorage();
    const storage = new BrowserSessionStorage({ storage: backend });
    backend.setItem(
      `tinycloud:session:${ADDRESS}`,
      JSON.stringify(
        persistedSession({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      ),
    );

    await expect(storage.loadWithStatus(ADDRESS)).resolves.toEqual({
      status: "expired",
      data: null,
    });
    expect(backend.length).toBe(0);
  });

  it("rejects and removes corrupted storage", async () => {
    const backend = new MemoryStorage();
    const storage = new BrowserSessionStorage({ storage: backend });
    backend.setItem(`tinycloud:session:${ADDRESS}`, "{not-json");

    await expect(storage.loadWithStatus(ADDRESS)).resolves.toEqual({
      status: "corrupt",
      data: null,
    });
    expect(backend.length).toBe(0);
  });

  it("does not save impossible session data", async () => {
    const storage = new BrowserSessionStorage({ storage: new MemoryStorage() });

    expect(() =>
      storage.save(ADDRESS, persistedSession({ sessionKey: "not-json" })),
    ).toThrow("invalid session key");
  });

  it("clears a persisted session", async () => {
    const storage = new BrowserSessionStorage({ storage: new MemoryStorage() });

    await storage.save(ADDRESS, persistedSession());
    expect(storage.exists(ADDRESS)).toBe(true);

    await storage.clear(ADDRESS);

    expect(storage.exists(ADDRESS)).toBe(false);
    await expect(storage.loadWithStatus(ADDRESS)).resolves.toEqual({
      status: "missing",
      data: null,
    });
  });

  it("isolates sessions by storage key prefix", async () => {
    const backend = new MemoryStorage();
    const appA = new BrowserSessionStorage({ storage: backend, keyPrefix: "app-a:" });
    const appB = new BrowserSessionStorage({ storage: backend, keyPrefix: "app-b:" });
    const sessionA = persistedSession({ signature: "0xa" });
    const sessionB = persistedSession({ signature: "0xb" });

    await appA.save(ADDRESS, sessionA);
    await appB.save(ADDRESS, sessionB);

    await expect(appA.load(ADDRESS)).resolves.toEqual(sessionA);
    await expect(appB.load(ADDRESS)).resolves.toEqual(sessionB);
  });
});

describe("browser session restore data", () => {
  it("converts a valid persisted session to restore data and client session", async () => {
    const session = persistedSession();

    expect(clientSessionFromPersisted(session)).toEqual({
      address: session.address,
      walletAddress: session.address,
      chainId: session.chainId,
      sessionKey: session.sessionKey,
      siwe: session.siwe,
      signature: session.signature,
    });
    expect(restoreDataFromPersisted(session)).toEqual({
      delegationHeader: session.tinycloudSession?.delegationHeader,
      delegationCid: session.tinycloudSession?.delegationCid,
      spaceId: session.tinycloudSession?.spaceId,
      jwk: JSON.parse(session.sessionKey),
      verificationMethod: session.tinycloudSession?.verificationMethod,
      address: session.address,
      chainId: session.chainId,
      siwe: session.siwe,
      signature: session.signature,
    });
  });
});
