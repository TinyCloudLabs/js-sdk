import { SqliteReplicaStore, loadSqlite } from "@tinycloud/replica/sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join("/var/tmp", "tc-replica-logout-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { removeProfileReplicas, removeProfileReplicasAndReplication, removeProfileReplication } = await import("./profile-replicas.js");
const { appendGrantHistory, grantHistoryPath, loadLocalGrantArtifacts, localGrantArtifactsPath, readGrantHistory } = await import("./permissions.js");

beforeEach(async () => {
  await rm(home, { recursive: true, force: true });
  await mkdir(join(home, ".tinycloud", "profiles"), { recursive: true });
  await ProfileManager.setProfile("dogfood", {
    name: "dogfood", host: "https://node.example.test", did: "did:key:device", chainId: 1,
    spaceName: "default", createdAt: "2026-10-01T00:00:00.000Z",
  });
});

afterAll(async () => { await rm(home, { recursive: true, force: true }); });

test("legacy-only logout cleanup is idempotent and leaves flag-owned replicas untouched", async () => {
  const legacy = join(profilePath("dogfood"), "replicas", "notes");
  const flag = join(profilePath("dogfood"), "replication", "a".repeat(26), "replicas", "b".repeat(26));
  for (const [path, prefix] of [[legacy, "notes/"], [flag, "apps/"]] as const) {
    const store = await SqliteReplicaStore.open(path, { create: true });
    await store.init({
      name: prefix, replicaId: "b".repeat(26), host: "https://node.example.test",
      space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
      prefix, deviceDid: "did:key:device", allowSecrets: false,
      localReadPolicy: "whileGrantValid", retentionGrantCid: null,
    });
    await store.close();
  }
  const legacyDb = join(legacy, "replica.db");
  const flagDb = join(flag, "replica.db");
  const flagBefore = await readFile(flagDb);

  expect(await removeProfileReplicas("dogfood")).toEqual(["notes"]);
  await expect(stat(legacyDb)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(flagDb)).toEqual(flagBefore);
  expect(await removeProfileReplicas("dogfood")).toEqual([]);
  expect(await readFile(flagDb)).toEqual(flagBefore);
});

test("interrupted legacy cleanup removes an empty child through direct and combined logout only after rejecting unknown siblings", async () => {
  const root = join(profilePath("dogfood"), "replicas");
  const empty = join(root, "notes");
  const unknown = join(root, "unrecognized");
  await mkdir(empty, { recursive: true });
  await mkdir(unknown);
  const foreign = join(unknown, "owner-data.bin");
  const bytes = Buffer.from("not a replica database");
  await writeFile(foreign, bytes);

  await expect(removeProfileReplicas("dogfood")).rejects.toMatchObject({ code: "REPLICA_PURGE_FAILED" });
  expect((await stat(empty)).isDirectory()).toBe(true);
  expect(await readFile(foreign)).toEqual(bytes);

  await rm(unknown, { recursive: true });
  expect(await removeProfileReplicas("dogfood")).toEqual(["notes"]);
  await expect(stat(empty)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await removeProfileReplicas("dogfood")).toEqual([]);
  const interruptedAgain = join(root, "again");
  await mkdir(interruptedAgain);
  expect(await removeProfileReplicasAndReplication("dogfood")).toEqual(["again"]);
  await expect(stat(interruptedAgain)).rejects.toMatchObject({ code: "ENOENT" });
});

test("local grant artifact reads refuse an alias instead of exposing another profile", async () => {
  await ProfileManager.setProfile("victim", {
    name: "victim", host: "https://node.example.test", did: "did:key:victim", chainId: 1,
    spaceName: "default", createdAt: "2026-10-01T00:00:00.000Z",
  });
  await writeFile(localGrantArtifactsPath("victim"), JSON.stringify([{
    delegationCid: "bafy-victim",
    delegation: { cid: "bafy-victim", delegationHeader: { Authorization: "Bearer victim" } },
  }]));
  await symlink(profilePath("victim"), profilePath("linked"));

  await expect(loadLocalGrantArtifacts("linked")).rejects.toMatchObject({ code: "PROFILE_SYMLINK" });
  await writeFile(grantHistoryPath("victim"), "victim-history\n");
  await expect(readGrantHistory("linked")).rejects.toMatchObject({ code: "PROFILE_SYMLINK" });
  await expect(appendGrantHistory("linked", { addedCaps: [], source: "cli" })).rejects.toMatchObject({ code: "PROFILE_SYMLINK" });
  expect(await readFile(grantHistoryPath("victim"), "utf8")).toBe("victim-history\n");
  expect((await loadLocalGrantArtifacts("victim")).map((record) => record.delegationCid)).toEqual(["bafy-victim"]);
});

test("logout cleanup refuses a linked profile instead of deleting the target profile's replica", async () => {
  await ProfileManager.setProfile("victim", {
    name: "victim", host: "https://node.example.test", did: "did:key:victim", chainId: 1,
    spaceName: "default", createdAt: "2026-10-01T00:00:00.000Z",
  });
  const replica = join(profilePath("victim"), "replicas", "notes");
  const store = await SqliteReplicaStore.open(replica, { create: true });
  await store.init({
    name: "notes", replicaId: "notes", host: "https://node.example.test",
    space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
    prefix: "notes/", deviceDid: "did:key:victim", allowSecrets: false,
    localReadPolicy: "whileGrantValid", retentionGrantCid: null,
  });
  await store.close();
  await symlink(profilePath("victim"), profilePath("linked"));

  await expect(removeProfileReplicasAndReplication("linked")).rejects.toThrow("symlink");
  expect(await stat(join(replica, "replica.db"))).toBeTruthy();
});

test("logout refuses a linked replica.db without advancing the victim lease", async () => {
  await ProfileManager.setProfile("victim", {
    name: "victim", host: "https://node.example.test", did: "did:key:victim", chainId: 1,
    spaceName: "default", createdAt: "2026-10-01T00:00:00.000Z",
  });
  const selected = join(profilePath("dogfood"), "replicas", "notes");
  const victim = join(profilePath("victim"), "replicas", "notes");
  for (const entry of [selected, victim]) {
    const store = await SqliteReplicaStore.open(entry, { create: true });
    await store.init({
      name: "notes", replicaId: "notes", host: "https://node.example.test",
      space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
      prefix: "notes/", deviceDid: "did:key:device", allowSecrets: false,
      localReadPolicy: "whileGrantValid", retentionGrantCid: null,
    });
    await store.close();
  }
  const victimDb = join(victim, "replica.db");
  const sqlite = await loadSqlite();
  const token = () => {
    const db = sqlite(victimDb, { readonly: true });
    try { return db.get<{ lease_token: number }>("SELECT lease_token FROM replica WHERE id = 1")?.lease_token; }
    finally { db.close(); }
  };
  const before = token();
  await rm(join(selected, "replica.db"));
  await symlink(victimDb, join(selected, "replica.db"));

  await expect(removeProfileReplicasAndReplication("dogfood")).rejects.toBeDefined();
  expect(token()).toBe(before);
  expect(await stat(victimDb)).toBeTruthy();
});

test("logout refuses a replica swapped for a symlink after opening it", async () => {
  const entry = join(profilePath("dogfood"), "replicas", "notes");
  const outside = join(home, "moved-logout-replica");
  const store = await SqliteReplicaStore.open(entry, { create: true });
  await store.init({
    name: "notes", replicaId: "notes", host: "https://node.example.test",
    space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
    prefix: "notes/", deviceDid: "did:key:device", allowSecrets: false,
    localReadPolicy: "whileGrantValid", retentionGrantCid: null,
  });
  await store.close();
  const originalDestroy = SqliteReplicaStore.prototype.destroy;
  SqliteReplicaStore.prototype.destroy = async function (lease) {
    await rename(entry, outside);
    await symlink(outside, entry);
    return originalDestroy.call(this, lease);
  };
  try {
    await expect(removeProfileReplicasAndReplication("dogfood")).rejects.toThrow("symlink");
    expect(await stat(join(outside, "replica.db"))).toBeTruthy();
  } finally {
    SqliteReplicaStore.prototype.destroy = originalDestroy;
  }
});

test("logout preflight keeps its original root when another real directory replaces its name", async () => {
  const selectedRoot = join(profilePath("dogfood"), "replicas");
  const selectedEntry = join(selectedRoot, "notes");
  const victimRoot = join(home, "victim-replicas");
  const victimEntry = join(victimRoot, "notes");
  for (const entry of [selectedEntry, victimEntry]) {
    const store = await SqliteReplicaStore.open(entry, { create: true });
    await store.init({
      name: "notes", replicaId: "notes", host: "https://node.example.test",
      space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
      prefix: "notes/", deviceDid: "did:key:device", allowSecrets: false,
      localReadPolicy: "whileGrantValid", retentionGrantCid: null,
    });
    await store.close();
  }
  const sqlite = await loadSqlite();
  const victimDb = join(victimEntry, "replica.db");
  const token = (path: string) => {
    const db = sqlite(path, { readonly: true });
    try { return db.get<{ lease_token: number }>("SELECT lease_token FROM replica WHERE id = 1")?.lease_token; }
    finally { db.close(); }
  };
  const before = token(victimDb);
  const originalOpen = SqliteReplicaStore.open;
  let swapped = false;
  SqliteReplicaStore.open = async function (dir, options) {
    if (!swapped && !options.create) {
      swapped = true;
      await rename(selectedRoot, `${selectedRoot}.moved`);
      await rename(victimRoot, selectedRoot);
    }
    return originalOpen.call(this, dir, options);
  };
  try {
    await expect(removeProfileReplicasAndReplication("dogfood")).rejects.toBeDefined();
    expect(swapped).toBe(true);
    expect(token(join(selectedRoot, "notes", "replica.db"))).toBe(before);
    expect(await stat(join(selectedRoot, "notes", "replica.db"))).toBeTruthy();
  } finally {
    SqliteReplicaStore.open = originalOpen;
  }
});

test("logout refuses a real replica entry replaced before SQLite opens it", async () => {
  await ProfileManager.setProfile("victim", {
    name: "victim", host: "https://node.example.test", did: "did:key:victim", chainId: 1,
    spaceName: "default", createdAt: "2026-10-01T00:00:00.000Z",
  });
  const selected = join(profilePath("dogfood"), "replicas", "notes");
  const victim = join(profilePath("victim"), "replicas", "notes");
  for (const entry of [selected, victim]) {
    const store = await SqliteReplicaStore.open(entry, { create: true });
    await store.init({
      name: "notes", replicaId: "notes", host: "https://node.example.test",
      space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
      prefix: "notes/", deviceDid: "did:key:device", allowSecrets: false,
      localReadPolicy: "whileGrantValid", retentionGrantCid: null,
    });
    await store.close();
  }
  const originalOpen = SqliteReplicaStore.open;
  let sqliteCalled = false;
  SqliteReplicaStore.open = async function (dir, options) {
    await rename(selected, `${selected}.original`);
    await rename(victim, selected);
    return originalOpen.call(this, dir, {
      ...options,
      sqlite: () => {
        sqliteCalled = true;
        throw new Error("SQLite must not open the replacement");
      },
    });
  };
  try {
    await expect(removeProfileReplicasAndReplication("dogfood")).rejects.toBeDefined();
    expect(sqliteCalled).toBe(false);
    expect(await stat(join(selected, "replica.db"))).toBeTruthy();
    expect(await stat(`${selected}.original/replica.db`)).toBeTruthy();
  } finally {
    SqliteReplicaStore.open = originalOpen;
  }
});

describe("flag-owned logout cleanup", () => {
  test("destroys actual flag replica stores and removes every identity partition and event log", async () => {
    const root = join(profilePath("dogfood"), "replication");
    const idHash = "a".repeat(26);
    const replicaHash = "b".repeat(26);
    const partition = join(root, idHash);
    const replicas = join(partition, "replicas");
    const store = await SqliteReplicaStore.open(join(replicas, replicaHash), { create: true });
    await store.init({
      name: "notes",
      replicaId: replicaHash,
      host: "https://node.example.test",
      space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
      prefix: "notes/",
      deviceDid: "did:key:device",
      allowSecrets: false,
      localReadPolicy: "whileGrantValid",
      retentionGrantCid: null,
    });
    await store.close();
    await writeFile(join(partition, "identity.json"), JSON.stringify({ host: "https://node.example.test", space: "default", principal: "did:pkh:eip155:1:0xabc" }));
    await writeFile(join(partition, "pending.json"), JSON.stringify({ v: 2, epoch: 1, seq: 2, records: [{ state: "ambiguous" }] }));
    await writeFile(join(root, "events.jsonl"), "{}\\n");

    expect(await stat(join(replicas, replicaHash, "replica.db"))).toBeTruthy();
    expect(await removeProfileReplication("dogfood")).toEqual([`replication/${idHash}/${replicaHash}`]);
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("a real replication root swapped after the final store destroy is never recursively removed", async () => {
    const root = join(profilePath("dogfood"), "replication");
    const entry = join(root, "a".repeat(26), "replicas", "b".repeat(26));
    const store = await SqliteReplicaStore.open(entry, { create: true });
    await store.init({
      name: "notes", replicaId: "b".repeat(26), host: "https://node.example.test",
      space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
      prefix: "notes/", deviceDid: "did:key:device", allowSecrets: false,
      localReadPolicy: "whileGrantValid", retentionGrantCid: null,
    });
    await store.close();
    const victim = join(home, "unselected-replication");
    await mkdir(victim);
    await writeFile(join(victim, "keep.txt"), "untouched");
    const originalDestroy = SqliteReplicaStore.prototype.destroy;
    SqliteReplicaStore.prototype.destroy = async function (lease) {
      await originalDestroy.call(this, lease);
      await rename(root, `${root}.moved`);
      await rename(victim, root);
    };
    try {
      await expect(removeProfileReplication("dogfood")).rejects.toMatchObject({ code: "REPLICA_PURGE_FAILED" });
      expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("untouched");
    } finally {
      SqliteReplicaStore.prototype.destroy = originalDestroy;
    }
  });

  test("a lease guard failure closes the flag store before logout aborts", async () => {
    const entry = join(profilePath("dogfood"), "replication", "a".repeat(26), "replicas", "b".repeat(26));
    const store = await SqliteReplicaStore.open(entry, { create: true });
    await store.init({
      name: "notes", replicaId: "b".repeat(26), host: "https://node.example.test",
      space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
      prefix: "notes/", deviceDid: "did:key:device", allowSecrets: false,
      localReadPolicy: "whileGrantValid", retentionGrantCid: null,
    });
    await store.close();
    const originalLease = SqliteReplicaStore.prototype.acquireSyncLease;
    const originalClose = SqliteReplicaStore.prototype.close;
    let closed = 0;
    SqliteReplicaStore.prototype.acquireSyncLease = async function () {
      throw new Error("injected lease guard failure");
    };
    SqliteReplicaStore.prototype.close = async function () {
      closed++;
      return originalClose.call(this);
    };
    try {
      await expect(removeProfileReplication("dogfood")).rejects.toMatchObject({ code: "REPLICA_PURGE_FAILED" });
      expect(closed).toBe(1);
      expect(await stat(join(entry, "replica.db"))).toBeTruthy();
    } finally {
      SqliteReplicaStore.prototype.acquireSyncLease = originalLease;
      SqliteReplicaStore.prototype.close = originalClose;
    }
  });
  test("refuses a flag replica whose ancestor is swapped for an outside symlink", async () => {
    const replicas = join(profilePath("dogfood"), "replication", "a".repeat(26), "replicas");
    const outside = join(home, "moved-flag-replicas");
    const entry = join(replicas, "b".repeat(26));
    const store = await SqliteReplicaStore.open(entry, { create: true });
    await store.init({
      name: "notes", replicaId: "b".repeat(26), host: "https://node.example.test",
      space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
      prefix: "notes/", deviceDid: "did:key:device", allowSecrets: false,
      localReadPolicy: "whileGrantValid", retentionGrantCid: null,
    });
    await store.close();
    const originalDestroy = SqliteReplicaStore.prototype.destroy;
    SqliteReplicaStore.prototype.destroy = async function (lease) {
      await rename(replicas, outside);
      await symlink(outside, replicas);
      return originalDestroy.call(this, lease);
    };
    try {
      await expect(removeProfileReplication("dogfood")).rejects.toMatchObject({ code: "REPLICA_PURGE_FAILED" });
      expect(await stat(join(outside, "b".repeat(26), "replica.db"))).toBeTruthy();
    } finally {
      SqliteReplicaStore.prototype.destroy = originalDestroy;
    }
  });

  test("a busy flag-owned replica prevents deletion of legacy replicas", async () => {
    const flagPath = join(profilePath("dogfood"), "replication", "a".repeat(26), "replicas", "b".repeat(26));
    const legacyPath = join(profilePath("dogfood"), "replicas", "legacy");
    const initialize = async (path: string, prefix: string) => {
      const store = await SqliteReplicaStore.open(path, { create: true });
      await store.init({
        name: prefix,
        replicaId: "b".repeat(26),
        host: "https://node.example.test",
        space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
        prefix,
        deviceDid: "did:key:device",
        allowSecrets: false,
        localReadPolicy: "whileGrantValid",
        retentionGrantCid: null,
      });
      await store.close();
    };
    await initialize(legacyPath, "notes/");
    await initialize(flagPath, "apps/");
    const busy = await SqliteReplicaStore.open(flagPath, { create: false });
    await busy.open();
    const lease = await busy.acquireSyncLease(60_000);
    expect(lease).not.toBeNull();
    try {
      await expect(removeProfileReplicasAndReplication("dogfood")).rejects.toMatchObject({
        code: "REPLICA_BUSY",
        message: expect.stringContaining("flag replica"),
      });
      expect(await stat(join(legacyPath, "replica.db"))).toBeTruthy();
    } finally {
      await busy.releaseLease(lease!);
      await busy.close();
    }
  });
  test("reports the surviving flag inventory after legacy deletion fails with EACCES", async () => {
    const createStore = async (path: string, name: string) => {
      const store = await SqliteReplicaStore.open(path, { create: true });
      await store.init({
        name,
        replicaId: path.split("/").at(-1)!,
        host: "https://node.example.test",
        space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
        prefix: "notes/",
        deviceDid: "did:key:device",
        allowSecrets: false,
        localReadPolicy: "whileGrantValid",
        retentionGrantCid: null,
      });
      await store.close();
    };
    const firstLegacy = join(profilePath("dogfood"), "replicas", "a-first");
    const failingLegacy = join(profilePath("dogfood"), "replicas", "b-failing");
    const flagReplica = join(profilePath("dogfood"), "replication", "c".repeat(26), "replicas", "d".repeat(26));
    await createStore(firstLegacy, "a-first");
    await createStore(failingLegacy, "b-failing");
    await createStore(flagReplica, "flag");

    const originalDestroy = SqliteReplicaStore.prototype.destroy;
    let destroyCalls = 0;
    SqliteReplicaStore.prototype.destroy = async function (lease) {
      destroyCalls += 1;
      if (destroyCalls === 2) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return originalDestroy.call(this, lease);
    };
    try {
      await expect(removeProfileReplicasAndReplication("dogfood")).rejects.toMatchObject({
        code: "REPLICA_PURGE_FAILED",
        metadata: {
          replicasRemoved: ["a-first"],
          replicasRemaining: ["b-failing", `replication/${"c".repeat(26)}/${"d".repeat(26)}`],
        },
      });
    } finally {
      SqliteReplicaStore.prototype.destroy = originalDestroy;
    }
  });
  test("a competing store writer waits for the complete logout lock turn", async () => {
    const legacyPath = join(profilePath("dogfood"), "replicas", "legacy");
    const initialize = async (path: string, name: string) => {
      const store = await SqliteReplicaStore.open(path, { create: true });
      await store.init({
        name,
        replicaId: "c".repeat(26),
        host: "https://node.example.test",
        space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
        prefix: `${name}/`,
        deviceDid: "did:key:device",
        allowSecrets: false,
        localReadPolicy: "whileGrantValid",
        retentionGrantCid: null,
      });
      await store.close();
    };
    await initialize(legacyPath, "legacy");
    const writerPath = join(profilePath("dogfood"), "replication", "d".repeat(26), "replicas", "e".repeat(26));
    const writer = initialize(writerPath, "concurrent");
    const logout = removeProfileReplicasAndReplication("dogfood");

    const [removed] = await Promise.all([logout, writer]);
    expect(removed).toContain("legacy");
    await expect(stat(join(legacyPath, "replica.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
