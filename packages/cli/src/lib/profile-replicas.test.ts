import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "tc-replica-logout-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { removeProfileReplication } = await import("./profile-replicas.js");

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
    await mkdir(replicas, { recursive: true });
    const { SqliteReplicaStore } = await import("@tinycloud/replica/sqlite");
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
});
