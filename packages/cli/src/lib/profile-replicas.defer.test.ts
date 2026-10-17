import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileReplicaPurge, sqliteReplicaStorage } from "@tinycloud/node-sdk";
import { establishSessionStamp } from "@tinycloud/replica/profile-gate";
import { SqliteReplicaStore } from "@tinycloud/replica/sqlite";
import {
  profileConfigPath,
  profilePath,
  withProfileLock,
  withTinyCloudStateRoot,
  writeJsonAtomic,
} from "@tinycloud/operations/state";
import { removeProfileReplicasAndReplication } from "./profile-replicas.js";

const PROFILE = "owner";
const PRINCIPAL = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const homes: string[] = [];
const signal = () => new AbortController().signal;

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function filesNamed(root: string, filename: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await filesNamed(path, filename));
    else if (entry.name === filename) found.push(path);
  }
  return found;
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "tc841-deferred-gate-"));
  homes.push(home);
  const profileDir = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: "https://node.example.test", chainId: 1, spaceName: "default",
      did: PRINCIPAL, createdAt: "2026-10-01T00:00:00.000Z",
    });
    return profilePath(PROFILE);
  });
  const guard = <T>(section: () => Promise<T>): Promise<T> =>
    withTinyCloudStateRoot(home, () => withProfileLock(PROFILE, section, { requireProfile: true }));
  const stamp = await establishSessionStamp(profileDir, PRINCIPAL, { siweIssuedAt: Date.now() - 1000 });
  const root = join(profileDir, "replication");
  const storage = sqliteReplicaStorage({ dir: root, guard });
  const handle = await storage.open({
    identity: { host: "https://node.example.test", space: SPACE, principal: PRINCIPAL },
    space: SPACE, prefix: "notes/", allowSecrets: false, stamp,
    grantPolicy: { grantTtlMs: 86_400_000, consentAnchor: { at: Date.now() - 1000, source: "siwe" } },
  });
  await handle.close();
  await storage.pendingWrites!({ host: "https://node.example.test", space: SPACE, principal: PRINCIPAL }, { stamp })
    .update((state) => { state.seq = 1; });
  const databases = await filesNamed(root, "replica.db");
  expect(databases).toHaveLength(1);
  return { home, profileDir, root, guard, databases };
}

describe("TC-841 deferred profile purge under the real profile lock", () => {
  test("wrong principal or stale epoch cannot erase a denied replica on restart", async () => {
    const { profileDir, root, guard, databases } = await fixture();
    const purge = createProfileReplicaPurge({ profileDir, guard });
    const denied = await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true });
    expect(denied.status).toBe("denied");
    if (denied.status !== "denied" || !denied.resumeToken) throw new Error("Missing durable resume token");
    const token = denied.resumeToken;
    const pending = await filesNamed(root, "pending.json");
    expect(pending).toHaveLength(1);

    const restarted = createProfileReplicaPurge({ profileDir, guard });
    expect(await restarted.deferredErase()).toEqual(token);
    expect((await restarted.recover({ signal: signal() })).remaining).toBeGreaterThan(0);
    for (const wrong of [
      { ...token, principalHash: `${token.principalHash[0] === "0" ? "1" : "0"}${token.principalHash.slice(1)}` },
      { ...token, deniedEpoch: token.deniedEpoch + 1 },
    ]) {
      await expect(restarted.resumeDeferredErase(wrong, { signal: signal() }))
        .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
      expect(await restarted.deferredErase()).toEqual(token);
      expect(await filesNamed(root, "pending.json")).toEqual(pending);
      expect(await filesNamed(root, "replica.db")).toEqual(databases);
    }
  });

  test("the same validated resume token is harmless after a successful erase", async () => {
    const { profileDir, root, guard } = await fixture();
    const purge = createProfileReplicaPurge({ profileDir, guard });
    const denied = await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true });
    if (denied.status !== "denied" || !denied.resumeToken) throw new Error("Missing durable resume token");
    const restarted = createProfileReplicaPurge({ profileDir, guard });
    const first = await restarted.resumeDeferredErase(denied.resumeToken, { signal: signal() });
    expect(first).toMatchObject({ failed: [], remaining: 0 });
    expect(await filesNamed(root, "pending.json")).toEqual([]);
    expect(await filesNamed(root, "replica.db")).toEqual([]);
    expect(await restarted.deferredErase()).toBeNull();
    expect(await restarted.resumeDeferredErase(denied.resumeToken, { signal: signal() }))
      .toEqual({ erased: [], failed: [], remaining: 0 });
  });
  test("successful revoke resume or plain denial still removes the legacy replica root", async () => {
    for (const deferred of [true, false]) {
      const { home, profileDir, guard } = await fixture();
      const legacyDir = join(profileDir, "replicas", "notes");
      const legacyDb = join(legacyDir, "replica.db");
      const legacy = await SqliteReplicaStore.open(legacyDir, { create: true });
      await legacy.init({
        name: "notes", replicaId: "r-test", host: "https://node.example.test",
        space: SPACE, prefix: "notes/", deviceDid: "did:key:zTestReplicaDevice",
        allowSecrets: false, localReadPolicy: "whileGrantValid", retentionGrantCid: null,
      });
      await legacy.close();
      const purge = createProfileReplicaPurge({ profileDir, guard });
      if (deferred) {
        const denied = await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true });
        if (denied.status !== "denied") throw new Error(`Expected a committed deferred denial, got ${denied.status}`);
        expect(await stat(legacyDb)).toBeTruthy();
        expect(await purge.resumeDeferredErase(denied.resumeToken, { signal: signal() }))
          .toMatchObject({ failed: [], remaining: 0 });
      } else {
        expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL })).status).toBe("denied");
        expect(await stat(legacyDb)).toBeTruthy();
        expect(await purge.erasePending({ signal: signal() })).toMatchObject({ failed: [], remaining: 0 });
      }
      // The S3 facade erases flag-owned partitions, not the older CLI replicas root.
      expect(await stat(legacyDb)).toBeTruthy();
      const removed = await withTinyCloudStateRoot(home, () => removeProfileReplicasAndReplication(PROFILE));
      expect(removed).toContain("notes");
      await expect(stat(legacyDb)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
