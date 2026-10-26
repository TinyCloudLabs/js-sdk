/*
 * Runtime grants requested from the panel survive a reload with the session record, and go with it: sign-out, a new
 * sign-in and the session's expiry remove them. Only a grant that is exactly the panel's own entry is stored; a stored
 * grant the node refuses for good is removed, one that failed for a transient reason stays; a failing storage or node
 * never throws. Storage is an in-memory Storage; nothing touches a real browser profile or home directory.
 */
import { describe, expect, test } from "bun:test";
import type { PersistedSessionData } from "@tinycloud/sdk-core";
import type { PortableDelegation } from "@tinycloud/node-sdk/core";

import { BrowserSessionStorage } from "../src/adapters/BrowserSessionStorage";
import {
  isPanelGrant,
  rememberRuntimeGrants,
  reuseRuntimeGrants,
} from "../src/modules/runtimeGrantPersistence";

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const APPLICATIONS = `tinycloud:pkh:eip155:1:${ADDRESS}:applications`;
const SESSION_DID = "did:key:z6MkSession";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  /** Writes of this kind of key throw, as a full or blocked storage does. */
  failWrites = false;
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
    if (this.failWrites) throw new DOMException("quota", "QuotaExceededError");
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
      spaceId: APPLICATIONS,
      verificationMethod: `${SESSION_DID}#z6MkSession`,
    },
    expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
    createdAt: now.toISOString(),
    version: "1.0",
  };
}

interface GrantOptions {
  delegateDID?: string;
  expiresInMs?: number;
  resources?: PortableDelegation["resources"];
}

/** By default exactly the panel's entry: delegation/list on the applications space. */
function grant(cid: string, over: GrantOptions = {}): PortableDelegation {
  return {
    cid,
    delegationHeader: { Authorization: `Bearer ${cid}` },
    ownerAddress: ADDRESS,
    chainId: 1,
    spaceId: APPLICATIONS,
    path: "",
    actions: ["tinycloud.delegation/list"],
    resources: over.resources ?? [
      { service: "delegation", space: APPLICATIONS, path: "", actions: ["tinycloud.delegation/list"] },
    ],
    expiry: new Date(Date.now() + (over.expiresInMs ?? 24 * 60 * 60_000)),
    delegateDID: over.delegateDID ?? SESSION_DID,
  } as PortableDelegation;
}

/** As the SDK's validated activation rejects a grant. */
function rejected(reason: string): Error {
  return Object.assign(new Error(`rejected: ${reason}`), { name: "RuntimeDelegationRejectedError", reason });
}

async function signedIn() {
  const backing = new MemoryStorage();
  const storage = new BrowserSessionStorage({ storage: backing });
  await storage.save(ADDRESS, session());
  return { backing, storage };
}

const reloaded = (backing: MemoryStorage) => new BrowserSessionStorage({ storage: backing });
const grantKeys = (backing: MemoryStorage) => backing.keys().filter((key) => key.includes("runtime-grants"));
const cids = async (storage: BrowserSessionStorage) => (await storage.loadRuntimeGrants(ADDRESS)).map((g) => g.cid);

describe("which grants are the panel's own", () => {
  test("exactly the tab's entry, for this owner, is a panel grant", () => {
    expect(isPanelGrant(grant("a"), ADDRESS)).toBe(true);
    // Address casing does not decide it.
    expect(isPanelGrant(grant("a"), ADDRESS.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  test("an app's larger grant is not: extra actions, extra resources, another space, caveats, another owner", () => {
    const list = { service: "delegation", space: APPLICATIONS, path: "", actions: ["tinycloud.delegation/list"] };
    const larger = [
      { ...list, actions: ["tinycloud.delegation/list", "tinycloud.delegation/create", "tinycloud.delegation/revoke"] },
    ];
    expect(isPanelGrant(grant("w", { resources: larger }), ADDRESS)).toBe(false);
    expect(isPanelGrant(grant("x", { resources: [list, { ...list, path: "notes/" }] }), ADDRESS)).toBe(false);
    expect(isPanelGrant(grant("y", { resources: [{ ...list, space: `tinycloud:pkh:eip155:1:${ADDRESS}:account` }] }), ADDRESS)).toBe(false);
    expect(isPanelGrant(grant("z", { resources: [{ ...list, actions: ["tinycloud.kv/get"] }] }), ADDRESS)).toBe(false);
    expect(isPanelGrant(grant("c", { resources: [{ ...list, caveats: [{ tenant: "a" }] }] }), ADDRESS)).toBe(false);
    expect(isPanelGrant(grant("o"), "0xffffffffffffffffffffffffffffffffffffffff")).toBe(false);
    expect(isPanelGrant({ ...grant("n"), resources: undefined } as PortableDelegation, ADDRESS)).toBe(false);
  });

  test("remembering stores the panel's grant and not a larger one returned with it", async () => {
    const { storage } = await signedIn();
    const larger = grant("wide", {
      resources: [
        {
          service: "delegation",
          space: APPLICATIONS,
          path: "",
          actions: ["tinycloud.delegation/list", "tinycloud.delegation/create", "tinycloud.delegation/revoke"],
        },
      ],
    });
    await rememberRuntimeGrants(storage, ADDRESS, [larger]);
    expect(await cids(storage)).toEqual([]);

    await rememberRuntimeGrants(storage, ADDRESS, [larger, grant("mine")]);
    expect(await cids(storage)).toEqual(["mine"]);
  });

  test("remembering a grant with a stored cid replaces it and keeps the others", async () => {
    const { storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("a")]);
    await rememberRuntimeGrants(storage, ADDRESS, [grant("b")]);
    await rememberRuntimeGrants(storage, ADDRESS, [grant("b", { expiresInMs: 5 * 60 * 60_000 })]);

    expect((await cids(storage)).sort()).toEqual(["a", "b"]);
  });
});

describe("runtime grants kept with the session", () => {
  test("grant, reload: the grant is activated again", async () => {
    const { backing, storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("g1")]);

    const used: string[] = [];
    await reuseRuntimeGrants(reloaded(backing), ADDRESS, async (g) => void used.push(g.cid));

    expect(used).toEqual(["g1"]);
    const again = await reloaded(backing).loadRuntimeGrants(ADDRESS);
    expect(again.map((g) => g.cid)).toEqual(["g1"]);
    expect(again[0]?.expiry).toBeInstanceOf(Date);
  });

  test("an expired stored grant is not activated again and is removed", async () => {
    const { backing, storage } = await signedIn();
    await storage.saveRuntimeGrants(ADDRESS, [grant("old", { expiresInMs: -1_000 })]);

    const used: string[] = [];
    await reuseRuntimeGrants(reloaded(backing), ADDRESS, async (g) => void used.push(g.cid));

    expect(used).toEqual([]);
    expect(grantKeys(backing)).toEqual([]);
  });

  test("a grant the node refuses for good is removed; the others stay", async () => {
    const { backing, storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("mine"), grant("other", { delegateDID: "did:key:z6MkOther" })]);

    await reuseRuntimeGrants(reloaded(backing), ADDRESS, async (g) => {
      if (g.delegateDID !== SESSION_DID) throw rejected("audience_mismatch");
    });

    expect(await cids(reloaded(backing))).toEqual(["mine"]);
  });

  test.each(["expired", "cid_mismatch", "proof_invalid", "activation_rejected", "activation_unauthenticated"])(
    "refusal %s removes the grant",
    async (reason) => {
      const { backing, storage } = await signedIn();
      await rememberRuntimeGrants(storage, ADDRESS, [grant("g1")]);
      await reuseRuntimeGrants(reloaded(backing), ADDRESS, async () => {
        throw rejected(reason);
      });
      expect(grantKeys(backing)).toEqual([]);
    },
  );

  test.each(["activation_unavailable", "host_mismatch", "unsupported"])(
    "a transient or undecided outcome (%s) keeps the grant",
    async (reason) => {
      const { backing, storage } = await signedIn();
      await rememberRuntimeGrants(storage, ADDRESS, [grant("g1")]);
      await reuseRuntimeGrants(reloaded(backing), ADDRESS, async () => {
        throw rejected(reason);
      });
      expect(await cids(reloaded(backing))).toEqual(["g1"]);
    },
  );

  test("an error that is not a rejection (an abort, a network error) keeps the grant", async () => {
    const { backing, storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("g1")]);
    await reuseRuntimeGrants(reloaded(backing), ADDRESS, async () => {
      throw new TypeError("Failed to fetch");
    });
    await reuseRuntimeGrants(reloaded(backing), ADDRESS, async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    expect(await cids(reloaded(backing))).toEqual(["g1"]);
  });

  test("sign-out clears them", async () => {
    const { backing, storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("g1")]);

    await storage.clear(ADDRESS);

    expect(grantKeys(backing)).toEqual([]);
    expect(await cids(reloaded(backing))).toEqual([]);
  });

  test("a new session record does not inherit the previous session's grants", async () => {
    const { backing, storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("g1")]);

    await storage.save(ADDRESS, session());

    expect(grantKeys(backing)).toEqual([]);
    expect(await cids(storage)).toEqual([]);
  });

  test("once the session has expired, its grants are gone with it", async () => {
    const backing = new MemoryStorage();
    const storage = new BrowserSessionStorage({ storage: backing });
    await storage.save(ADDRESS, session(60_000));
    await storage.saveRuntimeGrants(ADDRESS, [grant("g1")]);
    // The session record lapses.
    backing.setItem(backing.keys().find((key) => key.endsWith(ADDRESS)) as string, JSON.stringify(session(-1_000)));

    expect(await cids(storage)).toEqual([]);
    expect(grantKeys(backing)).toEqual([]);
  });

  test("a stored grant past its own expiry is not returned, whatever the session says", async () => {
    const { backing, storage } = await signedIn();
    await storage.saveRuntimeGrants(ADDRESS, [grant("live"), grant("lapsed", { expiresInMs: -5 })]);

    expect(await cids(reloaded(backing))).toEqual(["live"]);
  });

  test("stored data that is not a list of grants is ignored and removed", async () => {
    const { backing, storage } = await signedIn();
    await storage.saveRuntimeGrants(ADDRESS, [grant("g1")]);
    const key = grantKeys(backing)[0] as string;
    backing.setItem(key, JSON.stringify([{ cid: "no-header" }, "text", null]));

    expect(await cids(storage)).toEqual([]);
    expect(grantKeys(backing)).toEqual([]);
    backing.setItem(key, "{not json");
    expect(await cids(storage)).toEqual([]);
    expect(grantKeys(backing)).toEqual([]);
  });
});

describe("a failing storage or node never throws", () => {
  test("a storage that refuses writes (quota): saving and pruning do not throw, the session record is intact", async () => {
    const { backing, storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("g1")]);
    backing.failWrites = true;

    await expect(storage.saveRuntimeGrants(ADDRESS, [grant("g2")])).resolves.toBeUndefined();
    await expect(rememberRuntimeGrants(storage, ADDRESS, [grant("g3")])).resolves.toBeUndefined();
    // Pruning a lapsed grant tries a write that fails.
    backing.failWrites = false;
    await storage.saveRuntimeGrants(ADDRESS, [grant("live"), grant("lapsed", { expiresInMs: -5 })]);
    backing.failWrites = true;
    await expect(storage.loadRuntimeGrants(ADDRESS)).resolves.toBeDefined();
    expect(storage.exists(ADDRESS)).toBe(true);
  });

  test("a storage that throws on read answers no grants", async () => {
    const { backing, storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("g1")]);
    backing.getItem = () => {
      throw new Error("blocked");
    };
    await expect(storage.loadRuntimeGrants(ADDRESS)).resolves.toEqual([]);
  });

  test("reusing: a store that throws is swallowed", async () => {
    await expect(
      reuseRuntimeGrants(
        {
          loadRuntimeGrants: async () => {
            throw new Error("boom");
          },
          saveRuntimeGrants: async () => undefined,
        },
        ADDRESS,
        async () => undefined,
      ),
    ).resolves.toBeUndefined();
  });

  test("the wait is bounded: a node that never answers does not hold the restore", async () => {
    const { backing, storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("g1")]);
    const started = Date.now();
    await reuseRuntimeGrants(reloaded(backing), ADDRESS, () => new Promise(() => undefined), { budgetMs: 30 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await cids(reloaded(backing))).toEqual(["g1"]);
  });

  test("signed out meanwhile: nothing is written to storage", async () => {
    const { backing, storage } = await signedIn();
    await rememberRuntimeGrants(storage, ADDRESS, [grant("g1")]);
    let current = true;
    await reuseRuntimeGrants(
      reloaded(backing),
      ADDRESS,
      async () => {
        current = false;
        throw rejected("expired");
      },
      { isCurrent: () => current },
    );
    expect(await cids(reloaded(backing))).toEqual(["g1"]);
  });
});
