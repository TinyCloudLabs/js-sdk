/**
 * Regression tests for the TC-18 review findings: each fails on the code
 * before the fix.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { FakeNode, NODE_DID, SPACE, config, deviceGrant, etagOf, newStore, removeTempDirs, tempDir, type TestStoreOptions } from "../test/fixtures.js";
import { Replica, contentHash } from "./engine.js";
import { ReplicaError, ReplicaErrorCode, isReplicaError } from "./errors.js";
import { FAULTS, SqliteReplicaStore } from "./sqlite/store.js";
import { kvSyncTransport, type KVSyncClient } from "./transport.js";
import type { GrantRecord, ReplicaStore, VerifiedChange } from "./types.js";

afterAll(removeTempDirs);

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return isReplicaError(error) ? error.code : String(error);
  }
  return undefined;
}

async function blobCount(dir: string): Promise<number> {
  let count = 0;
  for (const shard of await readdir(join(dir, "blobs"))) {
    if (shard === ".tmp") continue;
    count += (await readdir(join(dir, "blobs", shard))).length;
  }
  return count;
}

describe("content reused within one page", () => {
  test("delete a, then put b with the same bytes", async () => {
    const node = new FakeNode();
    node.put("notes/a", "same bytes");
    const store = await newStore();
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    node.delete("notes/a");
    node.put("notes/b", "same bytes");
    expect(await replica.sync()).toMatchObject({ changes: 2, fetched: 0 });
    const b = await replica.get("notes/b");
    expect(b.status === "present" && text(b.value)).toBe("same bytes");
    expect((await replica.get("notes/a")).status).toBe("deleted");
  });

  test("update cur v1 to v2, then put prev = v1", async () => {
    const node = new FakeNode();
    node.put("notes/cur", "v1");
    const store = await newStore();
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    node.put("notes/cur", "v2");
    node.put("notes/prev", "v1");
    await replica.sync();
    const prev = await replica.get("notes/prev");
    const cur = await replica.get("notes/cur");
    expect([prev.status === "present" && text(prev.value), cur.status === "present" && text(cur.value)]).toEqual(["v1", "v2"]);
  });
});

describe("retention grant revocation", () => {
  async function retained() {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "one");
    node.authority = {
      notBefore: null,
      expiresAt: new Date(now + 60_000).toISOString(),
      retainUntil: new Date(now + 600_000).toISOString(),
    };
    const store = await newStore(undefined, { localReadPolicy: "retainAfterExpiry", retentionGrantCid: "bafyretain" });
    const replica = new Replica({ store, transport: node, now: () => now });
    await replica.sync();
    return { node, store, replica, advance: (ms: number) => (now += ms) };
  }

  test("a revoked retain grant is persisted and blocks post-expiry reads with GRANT_REVOKED", async () => {
    const { node, store, replica, advance } = await retained();
    node.failNextSync = new ReplicaError(ReplicaErrorCode.RETENTION_GRANT_REFUSED, "refused", { reason: "retention-grant-revoked" });
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.RETENTION_GRANT_REFUSED);
    const state = (await store.open())!;
    expect(state.retentionRevoked).not.toBeNull();
    expect(state.authority?.retainUntil).toBeNull();
    expect(state.config.retentionGrantCid).toBeNull();
    // Before expiry the sync grant still serves reads.
    expect((await replica.get("notes/a")).status).toBe("present");
    advance(120_000);
    expect(await codeOf(replica.get("notes/a"))).toBe(ReplicaErrorCode.GRANT_REVOKED);
  });

  test("other retention refusals stay plain errors", async () => {
    const { node, store, replica, advance } = await retained();
    node.failNextSync = new ReplicaError(ReplicaErrorCode.RETENTION_GRANT_REFUSED, "refused", { reason: "retention-grant-not-covering" });
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.RETENTION_GRANT_REFUSED);
    expect((await store.open())!.retentionRevoked).toBeNull();
    advance(120_000);
    expect((await replica.get("notes/a")).meta.authority).toBe("expired");
  });

  test("a refusal of the retain grant a request presented leaves a grant installed meanwhile", async () => {
    const { node, store, replica, advance } = await retained();
    node.onSyncPage = async () => {
      node.onSyncPage = undefined;
      await store.setRetentionGrant("bafynewretain");
    };
    node.failNextSync = new ReplicaError(ReplicaErrorCode.RETENTION_GRANT_REFUSED, "refused", { reason: "retention-grant-revoked" });
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.RETENTION_GRANT_REFUSED);
    const state = (await store.open())!;
    expect([state.config.retentionGrantCid, state.config.localReadPolicy, state.retentionRevoked]).toEqual([
      "bafynewretain",
      "retainAfterExpiry",
      null,
    ]);
    // The swap cleared the attested retainUntil: after the window the read
    // is a hard GRANT_EXPIRED, not an "expired" status.
    advance(120_000);
    expect(await codeOf(replica.get("notes/a"))).toBe(ReplicaErrorCode.GRANT_EXPIRED);
  });

  test("changing the retention CID drops the attested retainUntil until a new sync", async () => {
    const { node, store, replica, advance } = await retained();
    expect((await store.open())!.authority?.retainUntil).not.toBeNull();

    // A different retain grant cannot inherit the old grant's attestation.
    await store.setRetentionGrant("bafyother");
    expect((await store.open())!.authority?.retainUntil).toBeNull();
    // Re-setting the same CID is a no-op: the attestation stays cleared.
    await store.setRetentionGrant("bafyother");
    expect((await store.open())!.authority?.retainUntil).toBeNull();
    // Clearing the opt-in also drops it.
    await store.setRetentionGrant("bafyretain");
    await replica.sync();
    expect((await store.open())!.authority?.retainUntil).not.toBeNull();
    await store.setRetentionGrant(null);
    expect((await store.open())!.authority?.retainUntil).toBeNull();

    // After the window lapses with no new attestation, reads fail.
    advance(120_000);
    expect(await codeOf(replica.get("notes/a"))).toBe(ReplicaErrorCode.GRANT_EXPIRED);
  });

  test("an in-flight page cannot restore the retainUntil a CID swap invalidated", async () => {
    const { node, store, replica, advance } = await retained();
    expect((await store.open())!.authority?.retainUntil).not.toBeNull();

    // The next sync request is issued under `bafyretain`; mid-request a new
    // CID lands. The page still commits — under the new CID — but its
    // attested retainUntil belongs to the grant the request presented, so
    // the store must not persist it.
    node.onSyncPage = async () => {
      node.onSyncPage = undefined;
      await store.setRetentionGrant("bafyother");
    };
    await replica.sync();
    const state = (await store.open())!;
    expect(state.config.retentionGrantCid).toBe("bafyother");
    expect(state.authority?.retainUntil).toBeNull();
    // Post-expiry the read is a hard GRANT_EXPIRED, not a revived window.
    advance(120_000);
    expect(await codeOf(replica.get("notes/a"))).toBe(ReplicaErrorCode.GRANT_EXPIRED);
  });
});

describe("malformed authority bounds", () => {
  test("a page with an unparseable bound is a protocol error that changes nothing", async () => {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const attested = { notBefore: null, expiresAt: new Date(now + 60_000).toISOString(), retainUntil: null };
    node.authority = attested;
    const store = await newStore(undefined, {}, { now: () => now });
    const replica = new Replica({ store, transport: node, now: () => now });
    await replica.sync();
    const before = (await store.open())!;
    node.put("notes/b", "two");
    for (const bad of [
      { ...attested, expiresAt: "not-a-date" },
      { ...attested, notBefore: "yesterday" },
      { ...attested, retainUntil: "2030" },
    ]) {
      node.authority = bad;
      expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.PROTOCOL_ERROR);
      const after = (await store.open())!;
      expect([after.cursor, after.authority, await store.get("notes/b")]).toEqual([before.cursor, before.authority, undefined]);
    }
    now += 61_000;
    expect(await codeOf(replica.get("notes/a"))).toBe(ReplicaErrorCode.GRANT_EXPIRED);
  });
});

describe("false revocation", () => {
  test("a node error fetching a key named like a revocation fails the sync and keeps the replica", async () => {
    const key = "notes/delegation-revoked: bafyx";
    const value = new TextEncoder().encode("kept");
    const kept = new TextEncoder().encode("one");
    let feed = [{ key: "notes/a", deleted: false as const, etag: etagOf(kept), metadata: {} }];
    const sdk: KVSyncClient = {
      changes: async () => ({
        ok: true,
        data: {
          changes: feed,
          more: false,
          cursor: `c${feed.length}`,
          source: { nodeDid: NODE_DID, space: SPACE, prefix: "notes/" },
          authority: { notBefore: null, expiresAt: new Date(Date.now() + 3600_000).toISOString(), retainUntil: null },
        },
      }),
      batchGet: async (keys) =>
        keys.includes(key)
          ? { ok: false, error: { code: "NETWORK_ERROR", message: `Failed to batch read 1 key(s): 500 - storage error reading ${key}`, meta: { status: 500 } } }
          : { ok: true, data: { results: keys.map((k) => ({ key: k, result: { ok: true as const, data: { data: kept, headers: { etag: etagOf(kept) } } } })) } },
      get: async () => ({ ok: false, error: { code: "NETWORK_ERROR", message: `Failed to get key ${JSON.stringify(key)}: 500 - boom`, meta: { status: 500 } } }),
    };
    const store = await newStore();
    const replica = new Replica({ store, transport: kvSyncTransport(sdk) });
    await replica.sync();
    feed = [...feed, { key, deleted: false, etag: etagOf(value), metadata: {} }];
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.NODE_ERROR);
    expect((await store.open())!.revoked).toBeNull();
    const a = await replica.get("notes/a");
    expect(a.status === "present" && text(a.value)).toBe("one");
  });
});

describe("revocation learned while fetching content", () => {
  test("from the verify fetch: persisted, recorded as lastError, and reads blocked after restart", async () => {
    const dir = await tempDir();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newStore(dir);
    await new Replica({ store, transport: node }).sync();
    node.put("notes/b", "two");
    node.failNextFetch = new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, "delegation-revoked: bafy");
    expect(await codeOf(new Replica({ store, transport: node }).sync())).toBe(ReplicaErrorCode.GRANT_REVOKED);
    await store.close();
    const reopened = await SqliteReplicaStore.open(dir, { create: false });
    const state = (await reopened.open())!;
    expect(state.revoked).not.toBeNull();
    expect(state.lastError?.code).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect(await codeOf(new Replica({ store: reopened }).get("notes/a"))).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect(await blobCount(dir)).toBe(0);
  });

  test("from the repair fetch", async () => {
    const node = new FakeNode();
    node.put("notes/a", "v1");
    const store = await newStore();
    const replica = new Replica({ store, transport: node });
    const newer = new TextEncoder().encode("v2");
    node.tamper.set("notes/a", { bytes: newer, etag: `"x"` });
    await replica.sync();
    expect((await replica.get("notes/a")).status).toBe("content_missing");
    node.tamper.clear();
    node.failNextFetch = new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, "delegation-ancestor-revoked: bafy");
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect((await store.open())!.revoked).not.toBeNull();
  });
});

describe("source pin across an automatic reset", () => {
  test("a different node after a 410 is SOURCE_CHANGED with nothing committed; an explicit reset re-pins", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newStore();
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    node.nodeDid = "did:key:z6MkOtherNode";
    node.failNextSync = new ReplicaError(ReplicaErrorCode.RESET_REQUIRED, "reset", { reason: "position-unknown" });
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.SOURCE_CHANGED);
    const state = (await store.open())!;
    expect(state.nodeDid).toBe(NODE_DID);
    expect(state.cursor).toBeNull();
    expect(await store.get("notes/a")).toBeUndefined();

    await replica.reset("manual");
    await replica.sync();
    expect((await store.open())!.nodeDid).toBe("did:key:z6MkOtherNode");
  });
});

describe("grant promotion and pending-grant fallback", () => {
  test("promotion is bound to the CID the node validated; a grant installed meanwhile stays pending", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newStore();
    const validated = (await store.open())!.pendingGrant!;
    const newer = deviceGrant({ exp: Math.floor(Date.now() / 1000) + 9000 });
    node.onSyncPage = async () => {
      node.onSyncPage = undefined;
      await store.installGrant(newer);
    };
    await new Replica({ store, transport: node }).sync();
    const state = (await store.open())!;
    expect([state.grant?.cid, state.pendingGrant?.cid]).toEqual([validated.cid, newer.cid]);
  });

  async function withPending() {
    const good = new FakeNode();
    good.put("notes/a", "one");
    const store = await newStore();
    await new Replica({ store, transport: good }).sync();
    const active = (await store.open())!.grant!;
    const pending = deviceGrant({ exp: Math.floor(Date.now() / 1000) + 9000 });
    await store.installGrant(pending);
    const refusing = new FakeNode();
    const transportFor = (grant: GrantRecord) => (grant.cid === pending.cid ? refusing : good);
    return { good, refusing, store, active, pending, replica: new Replica({ store, transportFor }) };
  }

  test("a refused pending grant keeps its error and the active grant serves", async () => {
    const { good, refusing, store, active, pending, replica } = await withPending();
    refusing.failNextSync = new ReplicaError(ReplicaErrorCode.GRANT_UNAUTHORIZED, "401 - ancestor expired");
    good.put("notes/b", "two");
    expect(await replica.sync()).toMatchObject({ changes: 1, promotedGrant: false });
    const state = (await store.open())!;
    expect([state.grant?.cid, state.pendingGrant?.cid]).toEqual([active.cid, pending.cid]);
    expect(state.pendingGrantError?.code).toBe(ReplicaErrorCode.GRANT_UNAUTHORIZED);
    expect((await replica.status()).device.pendingDelegationError?.code).toBe(ReplicaErrorCode.GRANT_UNAUTHORIZED);
  });

  test("a revoked pending grant is discarded without purging the replica", async () => {
    const { refusing, store, active, replica } = await withPending();
    refusing.failNextSync = new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, "delegation-revoked: pending");
    await replica.sync();
    const state = (await store.open())!;
    expect(state.revoked).toBeNull();
    expect([state.grant?.cid, state.pendingGrant]).toEqual([active.cid, null]);
    expect((await replica.get("notes/a")).status).toBe("present");
  });
});

describe("authority at the commit boundary", () => {
  test("a page whose content fetch crosses the expiry instant does not commit", async () => {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "one");
    node.authority = { notBefore: null, expiresAt: new Date(now + 60_000).toISOString(), retainUntil: null };
    node.onFetch = () => {
      now += 61_000;
    };
    const store = await newStore(undefined, {}, { now: () => now });
    expect(await codeOf(new Replica({ store, transport: node, now: () => now }).sync())).toBe(ReplicaErrorCode.GRANT_EXPIRED);
    const state = (await store.open())!;
    expect([state.cursor, await store.get("notes/a")]).toEqual([null, undefined]);
  });

  test("a page whose blob writes cross the expiry instant does not commit", async () => {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "one");
    node.authority = { notBefore: null, expiresAt: new Date(now + 60_000).toISOString(), retainUntil: null };
    const store = await newStore(undefined, {}, { now: () => now, [FAULTS]: { afterBlobs: () => void (now += 61_000) } });
    expect(await codeOf(new Replica({ store, transport: node, now: () => now }).sync())).toBe(ReplicaErrorCode.GRANT_EXPIRED);
    const state = (await store.open())!;
    expect([state.cursor, state.grant, await store.get("notes/a")]).toEqual([null, null, undefined]);
  });

  test("a repair whose blob writes cross the expiry instant does not commit", async () => {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "v1");
    node.authority = { notBefore: null, expiresAt: new Date(now + 60_000).toISOString(), retainUntil: null };
    // afterBlobs runs once per commit: the first sync's page, then the second
    // sync's (empty) feed page, then its repair. Expire during the repair's.
    let commits = 0;
    const store = await newStore(undefined, {}, { now: () => now, [FAULTS]: { afterBlobs: () => void (++commits === 3 && (now += 61_000)) } });
    const replica = new Replica({ store, transport: node, now: () => now });
    node.tamper.set("notes/a", { bytes: new TextEncoder().encode("v2"), etag: `"x"` });
    await replica.sync();
    node.tamper.clear();
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.GRANT_EXPIRED);
    expect(commits).toBe(3);
    expect((await store.get("notes/a")) as { content?: boolean }).toMatchObject({ content: false });
  });

  test("a repair whose fetch crosses the expiry instant does not commit", async () => {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "v1");
    node.authority = { notBefore: null, expiresAt: new Date(now + 60_000).toISOString(), retainUntil: null };
    const store = await newStore(undefined, {}, { now: () => now });
    const replica = new Replica({ store, transport: node, now: () => now });
    node.tamper.set("notes/a", { bytes: new TextEncoder().encode("v2"), etag: `"x"` });
    await replica.sync();
    node.tamper.clear();
    node.onFetch = () => {
      now += 61_000;
    };
    expect(await codeOf(replica.sync())).toBe(ReplicaErrorCode.GRANT_EXPIRED);
    expect((await store.get("notes/a")) as { content?: boolean }).toMatchObject({ content: false });
  });
});

/** A one-change page the store can be handed directly. */
function pageOf(blob?: Uint8Array) {
  const changes: VerifiedChange[] =
    blob === undefined
      ? [{ key: "notes/z", deleted: true }]
      : [{ key: "notes/z", deleted: false, etag: `"blake3-${contentHash(blob)}"`, hash: contentHash(blob), metadata: {}, content: true }];
  return {
    changes,
    blobs: new Map(blob === undefined ? [] : [[contentHash(blob), blob]]),
    cursor: "9:9",
    source: { nodeDid: NODE_DID, space: "s", prefix: "notes/" },
    authority: null,
    coverage: "complete" as const,
    at: new Date().toISOString(),
    window: { notBefore: null, expiresAt: null },
    complete: true,
    retentionGrantCid: null,
    promoteGrant: null,
  };
}

describe("revocation purge fencing", () => {
  test("an outstanding writer cannot commit, collect or reset after the purge", async () => {
    const dir = await tempDir();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newStore(dir);
    await new Replica({ store, transport: node }).sync();
    const writer = (await store.acquireSyncLease(60_000))!;
    await store.markRevoked("delegation-revoked: bafy");
    expect(await codeOf(store.applyPage(writer, pageOf()))).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect(await codeOf(store.collectGarbage(writer))).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect(await codeOf(store.reset(writer, "x"))).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect(await store.list({})).toEqual([]);
    expect(await blobCount(dir)).toBe(0);
  });

  test("a writer resuming after the purge writes no content, also after a reopen", async () => {
    const dir = await tempDir();
    const store = await newStore(dir);
    const writer = (await store.acquireSyncLease(60_000))!;
    await store.markRevoked("delegation-revoked: bafy");
    expect(await codeOf(store.applyPage(writer, pageOf(new TextEncoder().encode("secret"))))).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect(await blobCount(dir)).toBe(0);
    await store.close();
    await (await SqliteReplicaStore.open(dir, { create: false })).close();
    expect(await blobCount(dir)).toBe(0);
  });

  test("a writer revoked while it wrote its blobs takes them back out", async () => {
    const dir = await tempDir();
    const other = await newStore(dir);
    const faults: TestStoreOptions = { [FAULTS]: { afterBlobs: () => other.markRevoked("delegation-revoked: bafy") } };
    const store = await SqliteReplicaStore.open(dir, { ...faults, create: false });
    const writer = (await store.acquireSyncLease(60_000))!;
    expect(await codeOf(store.applyPage(writer, pageOf(new TextEncoder().encode("secret"))))).toBe(ReplicaErrorCode.GRANT_REVOKED);
    expect([await blobCount(dir), (await store.status()).purgePending]).toEqual([0, false]);
  });

  test("content files a crashed writer left in a revoked replica are removed on open", async () => {
    const dir = await tempDir();
    const store = await newStore(dir);
    await store.markRevoked("delegation-revoked: bafy");
    await store.close();
    const hash = contentHash(new TextEncoder().encode("secret"));
    await mkdir(join(dir, "blobs", hash.slice(0, 2)));
    await writeFile(join(dir, "blobs", hash.slice(0, 2), hash), "secret");
    await writeFile(join(dir, "blobs", ".tmp", `${hash}.abc`), "secret");
    const reopened = await SqliteReplicaStore.open(dir, { create: false });
    expect([await blobCount(dir), await readdir(join(dir, "blobs", ".tmp"))]).toEqual([0, []]);
    expect((await reopened.status()).purgePending).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)("an unreadable shard keeps the purge pending until a later open removes it", async () => {
    const dir = await tempDir();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newStore(dir);
    await new Replica({ store, transport: node }).sync();
    const [shard] = (await readdir(join(dir, "blobs"))).filter((name) => name !== ".tmp");
    await chmod(join(dir, "blobs", shard!), 0o000);
    try {
      await store.markRevoked("delegation-revoked: bafy");
      expect([(await store.open())!.revoked, (await store.status()).purgePending]).toEqual(["delegation-revoked: bafy", true]);
    } finally {
      await chmod(join(dir, "blobs", shard!), 0o700);
    }
    // Still there: the purge did not pretend the unreadable shard was empty.
    expect(await blobCount(dir)).toBe(1);
    const reopened = await SqliteReplicaStore.open(dir, { create: false });
    expect([await blobCount(dir), (await reopened.status()).purgePending]).toEqual([0, false]);
  });
});

describe("lease expiry", () => {
  test("an expired lease no one took over cannot commit, renew, collect, reset or remove", async () => {
    let now = Date.now();
    const dir = await tempDir();
    const store = await newStore(dir, {}, { now: () => now });
    const lease = (await store.acquireSyncLease(1000))!;
    now += 2000;
    expect(await codeOf(store.applyPage(lease, pageOf(new TextEncoder().encode("late"))))).toBe(ReplicaErrorCode.BUSY);
    expect(await codeOf(store.renewLease(lease, 1000))).toBe(ReplicaErrorCode.BUSY);
    expect(await codeOf(store.collectGarbage(lease))).toBe(ReplicaErrorCode.BUSY);
    expect(await codeOf(store.reset(lease, "x"))).toBe(ReplicaErrorCode.BUSY);
    expect(await codeOf(store.destroy(lease))).toBe(ReplicaErrorCode.BUSY);
    expect([(await store.open())!.cursor, await store.get("notes/z"), await blobCount(dir)]).toEqual([null, undefined, 0]);
  });
});

describe("replica removal (reset --purge)", () => {
  test("a stale lease cannot remove a replica another process took over", async () => {
    let now = Date.now();
    const dir = await tempDir();
    const a = await newStore(dir, {}, { now: () => now });
    const b = await SqliteReplicaStore.open(dir, { create: false, now: () => now });
    const stale = (await a.acquireSyncLease(1000))!;
    now += 2000;
    expect(await b.acquireSyncLease(60_000)).not.toBeNull();
    expect(await codeOf(a.destroy(stale))).toBe(ReplicaErrorCode.BUSY);
    expect((await b.open())?.config.name).toBe("notes");
  });

  test("a store cannot remove a replacement replica created at the same path", async () => {
    const dir = await tempDir();
    const a = await newStore(dir);
    const lease = (await a.acquireSyncLease(60_000))!;
    await rm(dir, { recursive: true, force: true });
    const replacement = await newStore(dir, { replicaId: "r-replacement" });
    expect(await codeOf(a.destroy(lease))).toBe(ReplicaErrorCode.NOT_FOUND);
    expect((await replacement.open())?.config.replicaId).toBe("r-replacement");
  });

  test("a live lease removes the replica, also a revoked one", async () => {
    const dir = await tempDir();
    const store = await newStore(dir);
    await store.markRevoked("delegation-revoked: bafy");
    await store.destroy((await store.acquireSyncLease(60_000))!);
    expect(await stat(dir).then(() => "exists", () => "gone")).toBe("gone");
  });
});

describe("deleted replica directory", () => {
  test("a sync whose replica was deleted mid-fetch fails cleanly and recreates nothing", async () => {
    const dir = await tempDir();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newStore(dir);
    node.onFetch = () => rm(dir, { recursive: true, force: true });
    expect(await codeOf(new Replica({ store, transport: node }).sync())).toBe(ReplicaErrorCode.NOT_FOUND);
    expect(await stat(dir).then(() => "exists", () => "gone")).toBe("gone");
  });

  test("a store refuses to write into a replica recreated at the same path", async () => {
    const dir = await tempDir();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const stale = await newStore(dir);
    node.onFetch = async () => {
      node.onFetch = undefined;
      await rm(dir, { recursive: true, force: true });
      await (await newStore(dir)).close();
    };
    expect(await codeOf(new Replica({ store: stale, transport: node }).sync())).toBe(ReplicaErrorCode.NOT_FOUND);
    const fresh = await SqliteReplicaStore.open(dir, { create: false });
    expect([(await fresh.open())!.cursor, await fresh.list({})]).toEqual([null, []]);
  });

  test("a refusing guard blocks every mutation: database and files stay exactly as they were", async () => {
    const dir = await tempDir();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const plain = await newStore(dir, { localReadPolicy: "retainAfterExpiry", retentionGrantCid: "bafyretain" });
    await new Replica({ store: plain, transport: node }).sync();
    await plain.installGrant(deviceGrant({ exp: Math.floor(Date.now() / 1000) + 9000 }));
    const lease = (await plain.acquireSyncLease(60_000))!;
    const snapshot = async () => JSON.stringify([await plain.open(), await plain.list({}), await blobCount(dir)]);
    const before = await snapshot();
    let sections = 0;
    const refusing = await SqliteReplicaStore.open(dir, {
      create: false,
      guard: async () => {
        sections += 1;
        throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, "profile deleted");
      },
    });
    const pending = (await plain.open())!.pendingGrant!;
    const mutations: Array<[string, () => Promise<unknown>]> = [
      ["init", () => refusing.init(config({ name: "other" }))],
      ["setRetentionGrant", () => refusing.setRetentionGrant(null)],
      ["installGrant", () => refusing.installGrant(deviceGrant({ exp: Math.floor(Date.now() / 1000) + 9999 }))],
      ["discardPendingGrant", () => refusing.discardPendingGrant(pending.cid, "x")],
      ["recordPendingGrantError", () => refusing.recordPendingGrantError(pending.cid, { at: "t", code: "X", message: "x" })],
      ["markRetentionRevoked", () => refusing.markRetentionRevoked("bafyretain", "x")],
      ["acquireSyncLease", () => refusing.acquireSyncLease(60_000)],
      ["renewLease", () => refusing.renewLease(lease, 60_000)],
      ["releaseLease", () => refusing.releaseLease(lease)],
      ["recordError", () => refusing.recordError({ at: "t", code: "X", message: "x" })],
      ["applyPage", () => refusing.applyPage(lease, pageOf(new TextEncoder().encode("new")))],
      ["collectGarbage", () => refusing.collectGarbage(lease)],
      ["reset", () => refusing.reset(lease, "x")],
      ["markRevoked", () => refusing.markRevoked("x")],
      ["destroy", () => refusing.destroy(lease)],
    ];
    const refused: Record<string, string | undefined> = {};
    for (const [name, mutation] of mutations) refused[name] = await codeOf(mutation());
    expect(refused).toEqual(Object.fromEntries(mutations.map(([name]) => [name, ReplicaErrorCode.NOT_FOUND])));
    expect(sections).toBe(mutations.length);
    expect(await snapshot()).toBe(before);
  });
});

describe("lease and reader timing", () => {
  test("the lease is renewed with the configured TTL while content is fetched", async () => {
    const dir = await tempDir();
    let now = Date.now();
    const node = new FakeNode();
    for (let index = 0; index < 250; index += 1) node.put(`notes/k${index}`, `value ${index}`);
    await (await newStore(dir)).close();
    const store = await SqliteReplicaStore.open(dir, { create: false, now: () => now });
    const rival = await SqliteReplicaStore.open(dir, { create: false, now: () => now });
    const stolen: boolean[] = [];
    node.onFetch = async () => {
      now += 40_000;
      stolen.push((await rival.acquireSyncLease(1000)) !== null);
    };
    await new Replica({ store, transport: node, now: () => now, leaseTtlMs: 50_000 }).sync();
    expect(stolen).toEqual([false, false, false]);
  });

  test("a read racing a sync that replaced the entry and collected its blob re-reads instead of reporting corruption", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newStore();
    await new Replica({ store, transport: node }).sync();
    let first = true;
    const readContent = async (hash: string) => {
      if (first) {
        first = false;
        return undefined; // collected between the entry read and this blob read
      }
      return store.readContent(hash);
    };
    const racing = new Proxy(store, {
      get(target, property) {
        if (property === "readContent") return readContent;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ReplicaStore;
    const a = await new Replica({ store: racing }).get("notes/a");
    expect(a.status === "present" && text(a.value)).toBe("one");
  });
});

describe("authority after a local read", () => {
  /** `store`, with `hook` run after `method` has its result and before the caller gets it. */
  function pausedAfter(store: ReplicaStore, method: "readContent" | "list", hook: () => Promise<unknown> | void): ReplicaStore {
    return new Proxy(store, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        if (property !== method) return value.bind(target);
        return async (...args: unknown[]) => {
          const result: unknown = await value.apply(target, args);
          await hook();
          return result;
        };
      },
    }) as ReplicaStore;
  }

  async function synced() {
    let now = Date.now();
    const node = new FakeNode();
    node.put("notes/a", "secret");
    node.authority = { notBefore: null, expiresAt: new Date(now + 60_000).toISOString(), retainUntil: null };
    const store = await newStore(undefined, {}, { now: () => now });
    await new Replica({ store, transport: node, now: () => now }).sync();
    return { store, clock: () => now, expire: () => void (now += 61_000) };
  }

  test("a revocation purged while a get held the bytes returns GRANT_REVOKED, not the bytes", async () => {
    const { store, clock } = await synced();
    const paused = pausedAfter(store, "readContent", () => store.markRevoked("delegation-revoked: bafy"));
    expect(await codeOf(new Replica({ store: paused, now: clock }).get("notes/a"))).toBe(ReplicaErrorCode.GRANT_REVOKED);
  });

  test("an expiry reached while a get held the bytes returns GRANT_EXPIRED, not the bytes", async () => {
    const { store, clock, expire } = await synced();
    const paused = pausedAfter(store, "readContent", expire);
    expect(await codeOf(new Replica({ store: paused, now: clock }).get("notes/a"))).toBe(ReplicaErrorCode.GRANT_EXPIRED);
  });

  test("a list that read its rows before a revocation or an expiry returns the error, not the rows", async () => {
    const revoked = await synced();
    const whileRevoking = pausedAfter(revoked.store, "list", () => revoked.store.markRevoked("delegation-revoked: bafy"));
    expect(await codeOf(new Replica({ store: whileRevoking, now: revoked.clock }).list())).toBe(ReplicaErrorCode.GRANT_REVOKED);
    const expiring = await synced();
    const whileExpiring = pausedAfter(expiring.store, "list", expiring.expire);
    expect(await codeOf(new Replica({ store: whileExpiring, now: expiring.clock }).list())).toBe(ReplicaErrorCode.GRANT_EXPIRED);
  });
});

describe("WAL checkpoint after a reset", () => {
  test("a reader holding the old pages makes the reset report busy instead of claiming success", async () => {
    const dir = await tempDir();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newStore(dir);
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    const { Database } = await import("bun:sqlite");
    const reader = new Database(join(dir, "replica.db"));
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM entry").get();
    try {
      // TRUNCATE waits out busy_timeout (5 s) for the reader, then gives up.
      expect(await codeOf(replica.reset("manual"))).toBe(ReplicaErrorCode.BUSY);
    } finally {
      reader.exec("COMMIT");
      reader.close();
    }
    await replica.reset("manual");
  }, 20_000);
});
