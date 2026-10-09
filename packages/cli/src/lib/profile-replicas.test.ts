import { SqliteReplicaStore } from "@tinycloud/replica/sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "tc-replica-logout-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { removeProfileReplicasAndReplication, removeProfileReplication } = await import("./profile-replicas.js");

beforeEach(async () => {
  await rm(home, { recursive: true, force: true });
  await mkdir(join(home, ".tinycloud", "profiles"), { recursive: true });
  await ProfileManager.setProfile("dogfood", {
    name: "dogfood", host: "https://node.example.test", did: "did:key:device", chainId: 1,
    spaceName: "default", createdAt: "2026-10-01T00:00:00.000Z",
  });
});

afterAll(async () => { await rm(home, { recursive: true, force: true }); });

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
