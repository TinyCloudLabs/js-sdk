/*
 * Runtime grants requested from the panel survive a reload with the session record, and go with it: sign-out, a new
 * sign-in and the session's expiry remove them; an expired grant or one for another key is not registered again.
 * Storage is an in-memory Storage; nothing touches a real browser profile or home directory.
 */
import { describe, expect, test } from "bun:test";
import type { PersistedSessionData } from "@tinycloud/sdk-core";
import type { PortableDelegation } from "@tinycloud/node-sdk/core";

import { BrowserSessionStorage } from "../src/adapters/BrowserSessionStorage";
import { rememberRuntimeGrants, reuseRuntimeGrants } from "../src/modules/runtimeGrantPersistence";

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const SESSION_DID = "did:key:z6MkSession";

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
  keys(): string[] {
    return [...this.items.keys()];
  }
}

function session(expiresInMs = 60 * 60_000): PersistedSessionData {
  const now = new Date();
  return {
    address: ADDRESS,
    chainId: 1,
    sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "secret" }),
    siwe: "example.com wants you to sign in",
    signature: "0xsig",
    tinycloudSession: {
      delegationHeader: { Authorization: "Bearer delegation" },
      delegationCid: "bafydelegation",
      spaceId: "tinycloud:pkh:eip155:1:0x1234567890abcdef1234567890abcdef12345678:applications",
      verificationMethod: `${SESSION_DID}#z6MkSession`,
    },
    expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
    createdAt: now.toISOString(),
    version: "1.0",
  };
}

function grant(cid: string, over: { delegateDID?: string; expiresInMs?: number } = {}): PortableDelegation {
  return {
    cid,
    delegationHeader: { Authorization: `Bearer ${cid}` },
    ownerAddress: ADDRESS,
    chainId: 1,
    spaceId: "tinycloud:pkh:eip155:1:0x1234567890abcdef1234567890abcdef12345678:applications",
    path: "",
    actions: ["tinycloud.delegation/list"],
    expiry: new Date(Date.now() + (over.expiresInMs ?? 24 * 60 * 60_000)),
    delegateDID: over.delegateDID ?? SESSION_DID,
  } as PortableDelegation;
}

/** As the node does: a grant is registered only when it is unexpired and issued to this session's key. */
const useLikeNode = (registered: string[]) => async (g: PortableDelegation) => {
  if (g.expiry.getTime() <= Date.now()) throw new Error("expired");
  if (g.delegateDID !== SESSION_DID) throw new Error("not this session key");
  registered.push(g.cid);
};

async function signedIn() {
  const backing = new MemoryStorage();
  const storage = new BrowserSessionStorage({ storage: backing });
  await storage.save(ADDRESS, session());
  return { backing, storage };
}

const reloaded = (backing: MemoryStorage) => new BrowserSessionStorage({ storage: backing });
const grantKeys = (backing: MemoryStorage) => backing.keys().filter((key) => key.includes("runtime-grants"));

describe("runtime grants kept with the session", () => {
  test("grant, reload: the grant is registered again and the tab can read", async () => {
    const { backing, storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("g1")]);

    const registered: string[] = [];
    await reuseRuntimeGrants(reloaded(backing), ADDRESS, useLikeNode(registered));

    expect(registered).toEqual(["g1"]);
    const again = await reloaded(backing).loadRuntimeGrants(ADDRESS);
    expect(again.map((g) => g.cid)).toEqual(["g1"]);
    expect(again[0]?.expiry).toBeInstanceOf(Date);
  });

  test("an expired grant is not registered again and is removed", async () => {
    const { backing, storage } = await signedIn();
    await storage.saveRuntimeGrants(ADDRESS, [grant("old", { expiresInMs: -1_000 })]);

    const registered: string[] = [];
    await reuseRuntimeGrants(reloaded(backing), ADDRESS, useLikeNode(registered));

    expect(registered).toEqual([]);
    expect(grantKeys(backing)).toEqual([]);
  });

  test("a grant issued to another session key is skipped and removed; the others stay", async () => {
    const { backing, storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("mine"), grant("other", { delegateDID: "did:key:z6MkOther" })]);

    const registered: string[] = [];
    await reuseRuntimeGrants(reloaded(backing), ADDRESS, useLikeNode(registered));

    expect(registered).toEqual(["mine"]);
    expect((await reloaded(backing).loadRuntimeGrants(ADDRESS)).map((g) => g.cid)).toEqual(["mine"]);
  });

  test("sign-out clears them", async () => {
    const { backing, storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("g1")]);

    await storage.clear(ADDRESS);

    expect(grantKeys(backing)).toEqual([]);
    expect(await reloaded(backing).loadRuntimeGrants(ADDRESS)).toEqual([]);
  });

  test("a new session record does not inherit the previous session's grants", async () => {
    const { backing, storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("g1")]);

    await storage.save(ADDRESS, session());

    expect(grantKeys(backing)).toEqual([]);
    expect(await storage.loadRuntimeGrants(ADDRESS)).toEqual([]);
  });

  test("once the session has expired, its grants are gone with it", async () => {
    const backing = new MemoryStorage();
    const storage = new BrowserSessionStorage({ storage: backing });
    await storage.save(ADDRESS, session(60_000));
    await storage.saveRuntimeGrants(ADDRESS, [grant("g1")]);
    // The session record lapses.
    backing.setItem(
      backing.keys().find((key) => key.endsWith(ADDRESS)) as string,
      JSON.stringify(session(-1_000)),
    );

    expect(await storage.loadRuntimeGrants(ADDRESS)).toEqual([]);
    expect(grantKeys(backing)).toEqual([]);
  });

  test("remembering a grant with a stored cid replaces it and keeps the others", async () => {
    const { storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("a"), grant("b")]);
    await rememberRuntimeGrants(storage, ADDRESS, [grant("b", { expiresInMs: 5 * 60 * 60_000 })]);

    const stored = await storage.loadRuntimeGrants(ADDRESS);
    expect(stored.map((g) => g.cid).sort()).toEqual(["a", "b"]);
  });

  test("stored data that is not a list of grants is ignored and removed", async () => {
    const { backing, storage } = await signedIn();
    await storage.saveRuntimeGrants(ADDRESS, [grant("g1")]);
    const key = grantKeys(backing)[0] as string;
    backing.setItem(key, JSON.stringify([{ cid: "no-header" }, "text", null]));

    expect(await storage.loadRuntimeGrants(ADDRESS)).toEqual([]);
    expect(grantKeys(backing)).toEqual([]);
    backing.setItem(key, "{not json");
    expect(await storage.loadRuntimeGrants(ADDRESS)).toEqual([]);
    expect(grantKeys(backing)).toEqual([]);
  });
});
