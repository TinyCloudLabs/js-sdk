/**
 * Replica writes against profile deletion, through the real profile lock and
 * `tc profile delete` (TC-18): a deleted profile is never recreated, and
 * nothing is written into it.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplicaErrorCode, contentHash, isReplicaError, type ReplicaConfig, type VerifiedPage } from "@tinycloud/replica";

// The profile store reads TC_HOME when it loads (and replica.js loads it), so import them afterwards.
const home = await mkdtemp(join(tmpdir(), "tc-replica-guard-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { PROFILES_DIR } = await import("../config/constants.js");
const { createReplica, profileGuard } = await import("./replica.js");

const PROFILE = "doomed";
const NOT_FOUND = { code: ReplicaErrorCode.NOT_FOUND };

const config: ReplicaConfig = {
  name: "notes",
  replicaId: "r-test",
  host: "https://node.tinycloud.test",
  space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
  prefix: "notes/",
  deviceDid: "did:key:zDevice",
  allowSecrets: false,
  localReadPolicy: "whileGrantValid",
  retentionGrantCid: null,
};

const exists = (path: string) => stat(path).then(() => true, () => false);

async function createProfile(): Promise<void> {
  await ProfileManager.setProfile(PROFILE, {
    name: PROFILE,
    host: config.host,
    did: "did:key:zDoomed",
    chainId: 1,
    spaceName: "default",
    createdAt: "2026-10-01T00:00:00.000Z",
  });
}

function page(): VerifiedPage {
  const bytes = new TextEncoder().encode("secret");
  const hash = contentHash(bytes);
  return {
    changes: [{ key: "notes/a", deleted: false, etag: `"blake3-${hash}"`, hash, metadata: {}, content: true }],
    blobs: new Map([[hash, bytes]]),
    cursor: "1",
    source: { nodeDid: "did:key:zNode", space: config.space, prefix: config.prefix },
    authority: null,
    coverage: "complete",
    at: new Date().toISOString(),
    window: { notBefore: null, expiresAt: null },
    complete: true,
    promoteGrant: null,
  };
}

beforeEach(async () => {
  await rm(join(home, ".tinycloud"), { recursive: true, force: true });
  await mkdir(PROFILES_DIR, { recursive: true });
  await createProfile();
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("replica writes and profile deletion", () => {
  test("the guard of a deleted profile runs nothing and does not recreate the profile", async () => {
    await ProfileManager.deleteProfile(PROFILE);
    let ran = false;
    await expect(profileGuard(PROFILE)(async () => (ran = true))).rejects.toMatchObject(NOT_FOUND);
    expect(ran).toBe(false);
    expect(await readdir(PROFILES_DIR)).toEqual([]);
  });

  test("a guard that waited while the profile was deleted runs nothing and recreates nothing", async () => {
    const contended = join(home, "contended");
    process.env.NODE_ENV = "test";
    process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = contended;
    try {
      const entered = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      const deleting = ProfileManager.withLock(PROFILE, async () => {
        entered.resolve();
        await proceed.promise;
        await ProfileManager.deleteProfile(PROFILE);
      });
      await entered.promise;
      let ran = false;
      const writing = profileGuard(PROFILE)(async () => (ran = true));
      while (!(await exists(contended))) {
        /* each stat yields to the waiting writer */
      }
      proceed.resolve();
      await deleting;
      await expect(writing).rejects.toMatchObject(NOT_FOUND);
      expect(ran).toBe(false);
      expect(await readdir(PROFILES_DIR)).toEqual([]);
    } finally {
      delete process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
    }
  });

  test("creating a replica in a deleted profile writes nothing", async () => {
    await ProfileManager.deleteProfile(PROFILE);
    await expect(createReplica(PROFILE, config)).rejects.toMatchObject(NOT_FOUND);
    expect(await readdir(PROFILES_DIR)).toEqual([]);
  });

  test("a replica whose profile is deleted mid-sync takes no lease, commits nothing and leaves no directory", async () => {
    const store = await createReplica(PROFILE, config);
    const lease = (await store.acquireSyncLease(60_000))!;
    await ProfileManager.deleteProfile(PROFILE);
    const refused: Record<string, string | undefined> = {};
    for (const [name, write] of [
      ["applyPage", () => store.applyPage(lease, page())],
      ["acquireSyncLease", () => store.acquireSyncLease(60_000)],
      ["recordError", () => store.recordError({ at: "t", code: "X", message: "x" })],
      ["markRevoked", () => store.markRevoked("x")],
    ] as const) {
      refused[name] = await write().then(
        () => undefined,
        (error: unknown) => (isReplicaError(error) ? error.code : String(error)),
      );
    }
    await store.close();
    expect(refused).toEqual({
      applyPage: ReplicaErrorCode.NOT_FOUND,
      acquireSyncLease: ReplicaErrorCode.NOT_FOUND,
      recordError: ReplicaErrorCode.NOT_FOUND,
      markRevoked: ReplicaErrorCode.NOT_FOUND,
    });
    expect(await readdir(PROFILES_DIR)).toEqual([]);
  });

  test("a replica in an existing profile is created under the guard", async () => {
    const store = await createReplica(PROFILE, config);
    expect((await store.open())?.config.replicaId).toBe("r-test");
    await store.close();
    expect(await exists(join(PROFILES_DIR, PROFILE, "replicas", "notes", "replica.db"))).toBe(true);
  });
});
