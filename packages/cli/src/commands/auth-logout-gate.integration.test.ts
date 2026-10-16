import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileConfigPath, profilePath, sessionPath, withProfileLock, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";
import { establishSessionStamp, readGateSnapshot } from "@tinycloud/replica/profile-gate";
import { SqliteReplicaStore } from "@tinycloud/replica/sqlite";
import { sqliteReplicaStorage } from "@tinycloud/node-sdk";

const PROFILE = "owner";
const PRINCIPAL = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function run(home: string) {
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE, "--replication", "auth", "logout"], {
    env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("plain logout durably denies reads and ends the session even when a replica is busy, then resumes cleanup", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-cli-logout-gate-"));
  homes.push(home);
  const paths = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: "https://node.example.test", chainId: 1, spaceName: "default", did: PRINCIPAL,
      ownerDid: PRINCIPAL, createdAt: "2026-10-01T00:00:00.000Z",
    });
    await writeJsonAtomic(sessionPath(PROFILE), { ownerDid: PRINCIPAL, spaceId: "default" });
    const directory = profilePath(PROFILE);
    await establishSessionStamp(directory, PRINCIPAL, { siweIssuedAt: 1 });
    return { directory, session: sessionPath(PROFILE), replica: join(directory, "replicas", "notes") };
  });
  const store = await SqliteReplicaStore.open(paths.replica, { create: true });
  await store.init({
    name: "notes", replicaId: "r-test", host: "https://node.example.test", space: "default", prefix: "notes/",
    deviceDid: "did:key:zTestDevice", allowSecrets: false, localReadPolicy: "whileGrantValid", retentionGrantCid: null,
  });
  const lease = await store.acquireSyncLease(60_000);
  expect(lease).not.toBeNull();
  try {
    const busy = await run(home);
    expect(busy.exitCode).toBeGreaterThan(0);
    expect(busy.stderr).toContain("REPLICA_BUSY");
    await expect(stat(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readGateSnapshot(paths.directory))?.principalHash).toBeNull();
    expect(await stat(join(paths.replica, "replica.db"))).toBeTruthy();
  } finally {
    await store.releaseLease(lease!);
    await store.close();
  }

  const resumed = await run(home);
  expect(resumed.exitCode).toBe(0);
  await expect(stat(join(paths.replica, "replica.db"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(paths.session)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a pending flag-owned erase fences an open handle and is retried after its lease releases", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc858-cli-logout-pending-"));
  homes.push(home);
  await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: "https://node.example.test", chainId: 1, spaceName: "default", did: PRINCIPAL,
      ownerDid: PRINCIPAL, createdAt: "2026-10-01T00:00:00.000Z",
    });
    await writeJsonAtomic(sessionPath(PROFILE), { ownerDid: PRINCIPAL, spaceId: "default" });
    const directory = profilePath(PROFILE);
    const stamp = await establishSessionStamp(directory, PRINCIPAL, { siweIssuedAt: 1 });
    const replicationRoot = join(directory, "replication");
    const storage = sqliteReplicaStorage({
      dir: replicationRoot,
      guard: (section) => withProfileLock(PROFILE, section, { requireProfile: true }),
    });
    const handle = await storage.open({
      identity: { host: "https://node.example.test", space: SPACE, principal: PRINCIPAL },
      space: SPACE, prefix: "notes/", allowSecrets: false, stamp,
      device: { did: "did:key:zTestDevice", jwk: { kty: "OKP" } },
      grantPolicy: { grantTtlMs: 86_400_000, consentAnchor: { at: Date.now() - 1_000, source: "siwe" } },
    });
    const replicaFile = (await readdir(replicationRoot, { recursive: true })).find((entry) => entry.endsWith("replica.db"));
    expect(replicaFile).toBeDefined();
    const store = await SqliteReplicaStore.open(join(replicationRoot, replicaFile!, ".."), { create: false });
    await store.open();
    const lease = await store.acquireSyncLease(60_000);
    expect(lease).not.toBeNull();
    try {
      const pending = await run(home);
      expect(pending.exitCode).toBeGreaterThan(0);
      await expect(stat(sessionPath(PROFILE))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readGateSnapshot(directory))?.principalHash).toBeNull();
      await expect(handle.get("notes/a")).rejects.toMatchObject({ code: "REPLICA_GATED" });
      expect(await stat(join(replicationRoot, replicaFile!))).toBeTruthy();
    } finally {
      await store.releaseLease(lease!);
      await store.close();
      await handle.close();
    }
    const resumed = await run(home);
    expect(resumed).toMatchObject({ exitCode: 0 });
    await expect(stat(join(replicationRoot, replicaFile!))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
