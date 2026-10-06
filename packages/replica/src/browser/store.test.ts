/**
 * The IndexedDB store and the engine over it (TC-19), driven under
 * `fake-indexeddb`: the same contracts the Chromium e2e exercises for real.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from "fake-indexeddb";

import { FakeNode, NODE_DID, config, deviceGrant, etagOf } from "../../test/fixtures.js";
import { Replica } from "../engine.js";
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { BrowserReplica } from "./index.js";
import {
  DEVICE_DATABASE,
  IndexedDbReplicaStore,
  deleteReplicaDatabase,
  deviceIdentity,
  replicaDatabaseName,
  type DeviceIdentity,
} from "./store.js";
import { SPACE, device, keyPair, owner, signUcan } from "../../test/fixtures.js";
import { parseUcanGrant } from "../grant.js";
import { requestAsPromise } from "./idb.js";
beforeAll(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDB;
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fakeIDBKeyRange;
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
let sequence = 0;
const nextId = () => `r-browser-${++sequence}`;

async function rejectsWith(promise: Promise<unknown>, code: ReplicaErrorCode): Promise<ReplicaError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReplicaError);
    expect((error as ReplicaError).code).toBe(code);
    return error as ReplicaError;
  }
  throw new Error(`expected ${code}`);
}

/** A created store (fresh database) with the pending device grant installed. */
async function newIdbStore(replicaId = nextId(), overrides = {}): Promise<IndexedDbReplicaStore> {
  const store = await IndexedDbReplicaStore.open(replicaId, { holder: `holder-${replicaId}` });
  await store.init(config({ replicaId, ...overrides }));
  await store.installGrant(deviceGrant({ prefix: "notes/" }));
  return store;
}

describe("sync and offline reads (indexeddb)", () => {
  test("bootstraps over several pages, then serves reads with no transport", async () => {
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "alpha", { "content-type": "text/plain" });
    node.put("notes/b", "beta");
    node.put("notes/c", new Uint8Array([0, 1, 2, 255]));
    node.put("notes-secret/x", "hidden");
    node.put("other/y", "hidden");

    const store = await newIdbStore(replicaId);
    const report = await new Replica({ store, transport: node }).sync({ limit: 2 });
    expect(report).toMatchObject({ pages: 2, changes: 3, fetched: 3, coverage: "complete", promotedGrant: true });
    await store.close();

    // A fresh tab: reopen from IndexedDB, no transport at all.
    node.online = false;
    const reopened = await IndexedDbReplicaStore.open(replicaId, { holder: "holder-2" });
    const replica = new Replica({ store: reopened });
    const a = await replica.get("notes/a");
    expect(a.status).toBe("present");
    if (a.status !== "present") throw new Error("unreachable");
    expect(text(a.value)).toBe("alpha");
    expect(a.metadata).toEqual({ "content-type": "text/plain" });
    expect(a.meta).toMatchObject({ consistency: "observed", coverage: "complete", authority: "valid" });
    expect(a.meta.source.nodeDid).toBe(NODE_DID);
    const c = await replica.get("notes/c");
    expect(c.status === "present" && [...c.value]).toEqual([0, 1, 2, 255]);
    expect((await replica.get("notes/zzz")).status).toBe("absent");
    expect((await replica.get("notes-secret/x")).status).toBe("not_covered");
    expect((await replica.list()).entries.map((entry) => entry.key)).toEqual(["notes/a", "notes/b", "notes/c"]);
    const status = await replica.status();
    expect(status.counts).toEqual({ keys: 3, contentMissing: 0, tombstones: 0 });
    expect(status.device.delegationCid).not.toBeNull();
    expect(status.device.pendingDelegationCid).toBeNull();
    await reopened.close();
  });

  test("catches up updates and deletes", async () => {
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "alpha");
    node.put("notes/b", "beta");
    const store = await newIdbStore(replicaId);
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    node.put("notes/a", "alpha-2");
    node.delete("notes/b");
    const report = await replica.sync();
    expect(report.changes).toBe(2);
    const a = await replica.get("notes/a");
    expect(a.status === "present" && text(a.value)).toBe("alpha-2");
    expect((await replica.get("notes/b")).status).toBe("deleted");
    await store.close();
  });

  test("out-of-scope keys never reach the database", async () => {
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "alpha");
    node.put("notes-secret/x", "hidden");
    node.put("other/y", "hidden");
    const store = await newIdbStore(replicaId);
    await new Replica({ store, transport: node }).sync();
    // Store-level enumeration: only notes/ rows exist, and no blob holds
    // out-of-scope bytes (the engine refused them at scope check).
    const listed = await store.list({});
    expect(listed.map((entry) => entry.key)).toEqual(["notes/a"]);
    await store.close();
  });
});

describe("fencing and revocation (indexeddb)", () => {
  test("a second holder's lease cannot take over a live lease", async () => {
    const store = await newIdbStore();
    const lease = await store.acquireSyncLease(60_000);
    expect(lease).not.toBeNull();
    // A foreign holder (another tab's writer id) is refused.
    const foreign = await IndexedDbReplicaStore.open(nextId(), { holder: "other" });
    // Same replica, different holder id: open on the same database.
    await foreign.close();
    const sameDbOtherHolder = await IndexedDbReplicaStore.open(
      (await store.open())!.config.replicaId,
      { holder: "other-holder" },
    );
    expect(await sameDbOtherHolder.acquireSyncLease(60_000)).toBeNull();
    await store.releaseLease(lease!);
    expect(await sameDbOtherHolder.acquireSyncLease(60_000)).not.toBeNull();
    await store.close();
    await sameDbOtherHolder.close();
  });

  test("markRevoked purges entries and blobs and fences an in-flight writer", async () => {
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "alpha");
    const store = await newIdbStore(replicaId);
    await new Replica({ store, transport: node }).sync();
    const lease = await store.acquireSyncLease(60_000);

    await store.markRevoked("revoked by the node");
    // The outstanding lease is dead: the fence reports the revocation.
    await rejectsWith(
      store.applyPage(lease!, {
        changes: [],
        blobs: new Map(),
        cursor: null,
        source: { nodeDid: NODE_DID, space: "space", prefix: "notes/" },
        authority: null,
        coverage: "empty",
        at: new Date().toISOString(),
        window: { notBefore: null, expiresAt: null },

        complete: false,
        retentionGrantCid: null,
        promoteGrant: null,
      }),
      ReplicaErrorCode.GRANT_REVOKED,
    );
    expect(await store.list({})).toEqual([]);
    const status = await store.status();
    expect(status.authority.state).toBe("revoked");
    await store.close();
    // Survives a reopen.
    const reopened = await IndexedDbReplicaStore.open(replicaId, { holder: "h2" });
    expect((await reopened.status()).authority.state).toBe("revoked");
    await rejectsWith(new Replica({ store: reopened }).get("notes/a"), ReplicaErrorCode.GRANT_REVOKED);
    await reopened.close();
  });
});

describe("store mechanics (indexeddb)", () => {
  test("reset keeps the replica usable; purge deletes the database", async () => {
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "alpha");
    const store = await newIdbStore(replicaId);
    await new Replica({ store, transport: node }).sync();
    const lease = await store.acquireSyncLease(60_000);
    await store.reset(lease!, "test reset");
    expect(await store.list({})).toEqual([]);
    expect((await store.open())!.cursor).toBeNull();
    await store.close();

    await deleteReplicaDatabase(replicaId);
    // The database name is derived, and deleting it makes a fresh open empty.
    expect(replicaDatabaseName(replicaId)).toContain(replicaId);
    const fresh = await IndexedDbReplicaStore.open(replicaId, { holder: "h" });
    expect(await fresh.open()).toBeNull();
    await fresh.close();
  });

  test("content reused within one page resolves held-blob sizes", async () => {
    // Two keys, same bytes → same hash; only one blob record must exist and
    // both entries must be readable.
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "same-bytes");
    node.put("notes/b", "same-bytes");
    const store = await newIdbStore(replicaId);
    await new Replica({ store, transport: node }).sync();
    const a = await store.get("notes/a");
    const b = await store.get("notes/b");
    if (a === undefined || b === undefined || a.deleted || b.deleted) throw new Error("entries missing");
    expect(a.hash === b.hash).toBe(true);
    expect(text((await store.readContent(a.hash))!)).toBe("same-bytes");
    await store.close();
  });
});

describe("issuer binding and device identity (indexeddb)", () => {
  /** A grant signed by a second owner, for the same device and prefix. */
  function foreignGrant() {
    const other = keyPair();
    return parseUcanGrant(
      signUcan(other, {
        aud: device.did,
        exp: Math.floor(Date.now() / 1000) + 3600,
        att: { [`${SPACE}/kv/notes/`]: { "tinycloud.kv/sync": [{}] } },
        prf: ["bafyparent"],
      }),
    );
  }

  test("the first installed grant binds the replica to its issuer forever", async () => {
    const store = await newIdbStore();
    expect(await store.grantSubject()).toBe(owner.did);
    // A grant from another principal is refused, and the binding stays.
    await rejectsWith(store.installGrant(foreignGrant()), ReplicaErrorCode.GRANT_INVALID);
    expect(await store.grantSubject()).toBe(owner.did);
    // The bound issuer's grant (same CID is a no-op, a new one installs).
    await store.installGrant(deviceGrant({ prefix: "notes/", exp: Math.floor(Date.now() / 1000) + 7200 }));
    expect(await store.grantSubject()).toBe(owner.did);
    await store.close();
  });

  test("a replica that never saw a grant accepts its first issuer", async () => {
    const replicaId = nextId();
    const store = await IndexedDbReplicaStore.open(replicaId, { holder: "h" });
    await store.init(config({ replicaId }));
    expect(await store.grantSubject()).toBeNull();
    const foreign = foreignGrant();
    await store.installGrant(foreign);
    expect(await store.grantSubject()).toBe(foreign.issuer);
    // Now the original owner's grant is the foreign one.
    await rejectsWith(store.installGrant(deviceGrant({ prefix: "notes/" })), ReplicaErrorCode.GRANT_INVALID);
    await store.close();
  });

  test("concurrent first opens write one device key", async () => {
    await requestAsPromise(fakeIndexedDB.deleteDatabase(DEVICE_DATABASE));
    const a: DeviceIdentity = { did: "did:key:zA", jwk: { kty: "OKP" } };
    const b: DeviceIdentity = { did: "did:key:zB", jwk: { kty: "OKP" } };
    const [one, two] = await Promise.all([deviceIdentity(() => a), deviceIdentity(() => b)]);
    expect(one.did).toBe(two.did);
    expect([a.did, b.did]).toContain(one.did);
    // The stored identity wins; the generator is not consulted again.
    const c = await deviceIdentity(() => {
      throw new Error("must not generate");
    });
    expect(c.did).toBe(one.did);
  });
});

describe("engine commit notifications (indexeddb)", () => {
  test("onCommit fires per committed page, including a failed sync's partial commits", async () => {
    const replicaId = nextId();
    const node = new FakeNode();
    node.put("notes/a", "one");
    node.put("notes/b", "two");
    node.put("notes/c", "three");
    const store = await newIdbStore(replicaId);
    let commits = 0;
    const replica = new Replica({ store, transport: node, onCommit: () => commits++ });

    // The first page commits, then page two's transport call fails.
    let calls = 0;
    const syncPage = node.syncPage.bind(node);
    node.syncPage = async (a) => {
      calls += 1;
      if (calls === 2) node.failNextSync = new ReplicaError(ReplicaErrorCode.NETWORK_ERROR, "down");
      return syncPage(a);
    };
    await rejectsWith(replica.sync({ limit: 2 }), ReplicaErrorCode.NETWORK_ERROR);
    expect(commits).toBe(1);
    // The partial commit is readable offline.
    expect((await replica.list()).entries.length).toBe(2);

    node.failNextSync = undefined;
    await replica.sync({ limit: 2 });
    expect(commits).toBeGreaterThan(1);
    expect((await replica.list()).entries.length).toBe(3);
    await store.close();
  });

  test("onCommit also fires for a repair batch, not only feed pages", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    node.put("notes/b", "two");
    const store = await newIdbStore();
    let commits = 0;
    const replica = new Replica({ store, transport: node, onCommit: () => commits++ });
    // A fetch answering under a *different* etag is stale, not an attack: the
    // page commits the row as content-missing (one commit), nothing readable.
    node.tamper.set("notes/b", { bytes: new TextEncoder().encode("v-next"), etag: etagOf(new TextEncoder().encode("v-next")) });
    await replica.sync();
    expect(commits).toBe(1);
    expect((await replica.get("notes/b")).status).toBe("content_missing");
    // The next sync's repair batch re-fetches and commits the bytes: the
    // page commits, then the repair commits — two notifications.
    node.tamper.delete("notes/b");
    const before = commits;
    const report = await replica.sync();
    expect(report.repaired).toBe(1);
    expect(commits - before).toBe(2);
    expect((await replica.get("notes/b")).status).toBe("present");
    await store.close();
  });
});

describe("client lifecycle", () => {
  function stubWorker(behavior: { deliverGetMidClose?: boolean; ackClose?: boolean } = {}) {
    type Handler = ((message: MessageEvent) => void) | null;
    let onmessage: Handler = null;
    const state = { terminated: false, getId: -1, closeId: -1 };
    const worker = {
      postMessage(message: { id: number; op?: string }) {
        if (message.op === "close") {
          state.closeId = message.id;
          if (behavior.deliverGetMidClose === true && state.getId >= 0) {
            // A get reply arriving after close() started but before the
            // handshake acks must be ignored: it can never resolve with data.
            onmessage?.({ data: { id: state.getId, ok: true, result: { status: "present" } } } as MessageEvent);
          }
          if (behavior.ackClose !== false) {
            onmessage?.({ data: { id: message.id, ok: true, result: { closed: true } } } as MessageEvent);
          }
          return;
        }
        state.getId = message.id;
      },
      terminate() {
        state.terminated = true;
      },
      set onmessage(handler: Handler) {
        onmessage = handler;
      },
      set onerror(_handler: unknown) {},
    } as unknown as Worker;
    return { worker, state };
  }

  test("close() rejects in-flight calls even when their reply arrives mid-close", async () => {
    const { worker, state } = stubWorker({ deliverGetMidClose: true });
    const client = new BrowserReplica(worker);
    const pending = client.get("notes/a");
    await client.close();
    expect(state.terminated).toBe(true);
    // The reply was delivered between close() and the worker's ack; the call
    // rejects REPLICA_CLOSED — it never resolves with the delivered data.
    const error = await rejectsWith(pending, ReplicaErrorCode.CLOSED);
    expect(error.code).toBe("REPLICA_CLOSED");
    await rejectsWith(client.status(), ReplicaErrorCode.CLOSED);
    // `ready` rejects too: a consumer awaiting startup learns the client died.
    const readyError = (await client.ready.then(
      () => null,
      (e: unknown) => e,
    )) as ReplicaError;
    expect(readyError).toBeInstanceOf(ReplicaError);
    expect(readyError.code).toBe(ReplicaErrorCode.CLOSED);
  });

  test("close() resolves on its timeout when the worker never acks", async () => {
    const { worker, state } = stubWorker({ ackClose: false });
    const client = new BrowserReplica(worker);
    // Bounded wait: the 2 s in-code timeout must terminate the worker instead
    // of hanging the shutdown.
    await Promise.race([client.close(), Bun.sleep(10_000).then(() => Promise.reject(new Error("close() hung")))]);
    expect(state.terminated).toBe(true);
  }, 15_000);

  test("concurrent first opens converge on one database", async () => {
    const replicaId = nextId();
    const open = () => IndexedDbReplicaStore.open(replicaId, { holder: `holder-${Math.random().toString(36).slice(2)}` });
    const [a, b] = await Promise.all([open(), open()]);
    try {
      // Both see no replica; both init the identical config. The loser finds
      // the winner's database instead of failing with REPLICA_CONFIG_MISMATCH.
      const cfg = config({ replicaId });
      await Promise.all([a.init(cfg), b.init(cfg)]);
      const stateA = (await a.open())!;
      const stateB = (await b.open())!;
      expect(stateA.config.replicaId).toBe(replicaId);
      expect(stateB.config.replicaId).toBe(replicaId);
      // A genuinely different config still refuses.
      await rejectsWith(a.init(config({ replicaId, prefix: "other/" })), ReplicaErrorCode.CONFIG_MISMATCH);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});
