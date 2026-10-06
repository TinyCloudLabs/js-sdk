import { afterAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { FakeNode, NODE_DID, deviceGrant, etagOf, newStore, removeTempDirs, tempDir } from "../test/fixtures.js";
import { Replica } from "./engine.js";
import { ReplicaError, ReplicaErrorCode } from "./errors.js";
import { SqliteReplicaStore } from "./sqlite/store.js";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

afterAll(removeTempDirs);

async function blobFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const shard of await readdir(join(dir, "blobs"))) {
    for (const name of await readdir(join(dir, "blobs", shard))) out.push(`${shard}/${name}`);
  }
  return out;
}

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

describe("sync and offline reads", () => {
  test("bootstraps over several pages, then serves reads from disk with no transport", async () => {
    const dir = await tempDir();
    const node = new FakeNode();
    node.put("notes/a", "alpha", { "content-type": "text/plain" });
    node.put("notes/b", "beta");
    node.put("notes/c", new Uint8Array([0, 1, 2, 255]));
    node.put("notes-secret/x", "hidden");
    node.put("other/y", "hidden");

    const store = await newStore(dir);
    const report = await new Replica({ store, transport: node }).sync({ limit: 2 });
    expect(report).toMatchObject({ pages: 2, changes: 3, fetched: 3, coverage: "complete", promotedGrant: true });
    await store.close();

    // A fresh process: reopen from disk, no transport at all.
    node.online = false;
    const reopened = await SqliteReplicaStore.open(dir, { create: false });
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
    expect(status.bytes).toBe(5 + 4 + 4);
    expect(status.device.delegationCid).not.toBeNull();
    expect(status.device.pendingDelegationCid).toBeNull();
    await reopened.close();
  });

  test("catches up updates and deletes; metadata-only changes do not refetch", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    node.put("notes/b", "two");
    const store = await newStore();
    const replica = new Replica({ store, transport: node });
    await replica.sync();

    node.put("notes/a", "one-updated");
    node.delete("notes/b");
    node.put("notes/c", "three");
    const fetchesBefore = node.fetchCalls;
    const report = await replica.sync();
    expect(report).toMatchObject({ changes: 3, deleted: 1, fetched: 2 });
    const a = await replica.get("notes/a");
    expect(a.status === "present" && text(a.value)).toBe("one-updated");
    expect((await replica.get("notes/b")).status).toBe("deleted");
    expect((await replica.status()).counts).toEqual({ keys: 2, contentMissing: 0, tombstones: 1 });

    const value = node.values.get("notes/c")!;
    node.put("notes/c", value.bytes, { tag: "x" });
    const fetches = node.fetchCalls;
    await replica.sync();
    expect(node.fetchCalls).toBe(fetches);
    expect(fetchesBefore).toBeLessThan(fetches);
    const c = await replica.get("notes/c");
    expect(c.status === "present" && c.metadata).toEqual({ tag: "x" });
  });

  test("an empty feed after a full sync keeps reads and changes nothing", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newStore();
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    node.put("other/z", "unrelated");
    expect(await replica.sync()).toMatchObject({ changes: 0, cursorAdvanced: false });
  });
});

describe("verification before commit", () => {
  test("bytes that claim the attested ETag but hash differently are refused, and nothing commits", async () => {
    const node = new FakeNode();
    node.put("notes/a", "genuine");
    const store = await newStore();
    node.tamper.set("notes/a", { bytes: new TextEncoder().encode("forged"), etag: etagOf(node.values.get("notes/a")!.bytes) });
    await rejectsWith(new Replica({ store, transport: node }).sync(), ReplicaErrorCode.CONTENT_MISMATCH);
    const state = await store.open();
    expect(state?.cursor).toBeNull();
    expect(await store.get("notes/a")).toBeUndefined();
    expect(state?.lastError?.code).toBe(ReplicaErrorCode.CONTENT_MISMATCH);
  });

  test("a stale fetch commits the row as content_missing, repaired on a later sync", async () => {
    const node = new FakeNode();
    node.put("notes/a", "v1");
    const store = await newStore();
    const replica = new Replica({ store, transport: node });
    // The value changed between the feed page and the fetch.
    const newer = new TextEncoder().encode("v2");
    node.tamper.set("notes/a", { bytes: newer, etag: etagOf(newer) });
    const report = await replica.sync();
    expect(report.contentMissing).toBe(1);
    expect((await replica.get("notes/a")).status).toBe("content_missing");

    node.tamper.clear();
    const repaired = await replica.sync();
    expect(repaired.repaired).toBe(1);
    const a = await replica.get("notes/a");
    expect(a.status === "present" && text(a.value)).toBe("v1");
  });

  test("a feed key outside the prefix fails the page with SCOPE_VIOLATION", async () => {
    const node = new FakeNode();
    node.put("notes/a", "ok");
    node.extraChanges = [{ key: "notes-secret/x", deleted: true }];
    const store = await newStore();
    await rejectsWith(new Replica({ store, transport: node }).sync(), ReplicaErrorCode.SCOPE_VIOLATION);
    expect(await store.get("notes/a")).toBeUndefined();
  });

  test("a different source node is refused once the source is pinned", async () => {
    const node = new FakeNode();
    node.put("notes/a", "ok");
    const store = await newStore();
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    node.nodeDid = "did:key:z6MkOtherNode";
    node.put("notes/b", "new");
    await rejectsWith(replica.sync(), ReplicaErrorCode.SOURCE_CHANGED);
    expect(await store.get("notes/b")).toBeUndefined();
  });

  test("local blob corruption is reported, not served", async () => {
    const dir = await tempDir();
    const node = new FakeNode();
    node.put("notes/a", "genuine");
    const store = await newStore(dir);
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    const [blob] = await blobFiles(dir);
    await Bun.write(join(dir, "blobs", blob!), "corrupt");
    await rejectsWith(replica.get("notes/a"), ReplicaErrorCode.INTEGRITY_ERROR);
    expect((await replica.get("notes/a", { verify: false })).status).toBe("present");
  });
});

describe("reset", () => {
  test("410 resets in place and re-bootstraps from an empty cursor", async () => {
    const dir = await tempDir();
    const node = new FakeNode();
    node.put("notes/a", "one");
    node.put("notes/b", "two");
    const store = await newStore(dir);
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    node.delete("notes/b");
    node.failNextSync = new ReplicaError(ReplicaErrorCode.RESET_REQUIRED, "reset", { reason: "position-unknown" });
    const report = await replica.sync();
    expect(report.resets).toBe(1);
    const status = await replica.status();
    expect(status.lastReset?.reason).toBe("node: position-unknown");
    expect(status.counts).toEqual({ keys: 1, contentMissing: 0, tombstones: 0 });
    expect((await replica.get("notes/b")).status).toBe("absent");
    expect(await blobFiles(dir)).toHaveLength(1);
  });

  test("a manual reset clears entries, blobs, cursor and the source pin, keeping the grant", async () => {
    const dir = await tempDir();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newStore(dir);
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    await replica.reset("manual");
    const state = await store.open();
    expect(state).toMatchObject({ cursor: null, nodeDid: null, coverage: "empty" });
    expect(state?.grant).not.toBeNull();
    expect(await blobFiles(dir)).toEqual([]);
    expect((await replica.get("notes/a")).status).toBe("coverage_incomplete");
  });
});

describe("authority", () => {
  test("revocation learned online purges entries and blobs and blocks reads after restart", async () => {
    const dir = await tempDir();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newStore(dir);
    await new Replica({ store, transport: node }).sync();
    node.failNextSync = new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, "delegation-revoked: bafy");
    await rejectsWith(new Replica({ store, transport: node }).sync(), ReplicaErrorCode.GRANT_REVOKED);
    await store.close();

    const reopened = await SqliteReplicaStore.open(dir, { create: false });
    const replica = new Replica({ store: reopened });
    await rejectsWith(replica.get("notes/a"), ReplicaErrorCode.GRANT_REVOKED);
    await rejectsWith(replica.list(), ReplicaErrorCode.GRANT_REVOKED);
    expect(await blobFiles(dir)).toEqual([]);
    expect((await reopened.list({})).length).toBe(0);
    expect((await replica.status()).authority.state).toBe("revoked");
    node.online = true;
    await rejectsWith(new Replica({ store: reopened, transport: node }).sync(), ReplicaErrorCode.GRANT_REVOKED);
  });

  test("reads block at the node-attested expiry, which can precede the leaf's exp", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    let now = Date.now();
    node.authority = { notBefore: null, expiresAt: new Date(now + 60_000).toISOString(), retainUntil: null };
    const store = await newStore();
    const replica = new Replica({ store, transport: node, now: () => now });
    await replica.sync();
    expect((await replica.get("notes/a")).status).toBe("present");
    now += 61_000;
    await rejectsWith(replica.get("notes/a"), ReplicaErrorCode.GRANT_EXPIRED);
    await rejectsWith(replica.sync(), ReplicaErrorCode.GRANT_EXPIRED);
    expect((await replica.status()).authority.state).toBe("expired");
  });

  test("with a retention attestation, reads continue marked expired until retainUntil, with no new sync", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    let now = Date.now();
    node.authority = {
      notBefore: null,
      expiresAt: new Date(now + 60_000).toISOString(),
      retainUntil: new Date(now + 600_000).toISOString(),
    };
    const store = await newStore(undefined, { localReadPolicy: "retainAfterExpiry", retentionGrantCid: "bafyretain" });
    const replica = new Replica({ store, transport: node, now: () => now });
    await replica.sync();
    now += 120_000;
    const a = await replica.get("notes/a");
    expect(a.status).toBe("present");
    expect(a.meta.authority).toBe("expired");
    await rejectsWith(replica.sync(), ReplicaErrorCode.GRANT_EXPIRED);
    now += 600_000;
    await rejectsWith(replica.get("notes/a"), ReplicaErrorCode.GRANT_EXPIRED);
  });

  test("a page whose attested window has already ended is not committed", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    node.authority = { notBefore: null, expiresAt: new Date(Date.now() - 1000).toISOString(), retainUntil: null };
    const store = await newStore();
    await rejectsWith(new Replica({ store, transport: node }).sync(), ReplicaErrorCode.GRANT_EXPIRED);
    expect(await store.get("notes/a")).toBeUndefined();
  });

  test("a replacement grant stays pending until a sync under it succeeds, and keeps the cursor", async () => {
    const node = new FakeNode();
    node.put("notes/a", "one");
    const store = await newStore();
    const replica = new Replica({ store, transport: node });
    await replica.sync();
    const first = (await store.open())!;
    const renewal = deviceGrant({ exp: Math.floor(Date.now() / 1000) + 7200 });
    await store.installGrant(renewal);
    expect((await replica.status()).device).toMatchObject({ delegationCid: first.grant!.cid, pendingDelegationCid: renewal.cid });

    // The node refuses the sync: the old grant stays active, the renewal pending.
    node.online = false;
    await rejectsWith(replica.sync(), ReplicaErrorCode.NETWORK_ERROR);
    expect((await store.open())!.grant!.cid).toBe(first.grant!.cid);

    node.online = true;
    node.put("notes/b", "two");
    const report = await replica.sync();
    expect(report).toMatchObject({ promotedGrant: true, changes: 1 });
    const after = (await store.open())!;
    expect(after.grant!.cid).toBe(renewal.cid);
    expect(after.pendingGrant).toBeNull();
  });
});

describe("writer fencing", () => {
  test("a former lease holder cannot commit or collect garbage after another process took over", async () => {
    const dir = await tempDir();
    const node = new FakeNode();
    node.put("notes/a", "one");
    const a = await newStore(dir);
    let now = Date.now();
    const b = await SqliteReplicaStore.open(dir, { create: false, now: () => now });
    const stale = await a.acquireSyncLease(60_000);
    expect(stale).not.toBeNull();
    expect(await b.acquireSyncLease(60_000)).toBeNull();
    // The holder paused past its lease.
    now += 61_000;
    const current = await b.acquireSyncLease(60_000);
    expect(current).not.toBeNull();
    await rejectsWith(
      a.applyPage(stale!, {
        changes: [{ key: "notes/x", deleted: true }],
        blobs: new Map(),
        cursor: "9",
        source: { nodeDid: NODE_DID, space: "s", prefix: "notes/" },
        authority: null,
        coverage: "bootstrapping",
        at: new Date().toISOString(),
        complete: false,
        now: Date.now(),
        window: { notBefore: null, expiresAt: null },
        promoteGrant: null,
      }),
      ReplicaErrorCode.BUSY,
    );
    await rejectsWith(a.collectGarbage(stale!), ReplicaErrorCode.BUSY);
    await rejectsWith(a.reset(stale!, "x"), ReplicaErrorCode.BUSY);
    expect(await a.get("notes/x")).toBeUndefined();
    await rejectsWith(new Replica({ store: a, transport: node }).sync(), ReplicaErrorCode.BUSY);
    await b.releaseLease(current!);
    await new Replica({ store: a, transport: node }).sync();
    expect((await a.get("notes/a"))?.deleted).toBe(false);
  });
});
