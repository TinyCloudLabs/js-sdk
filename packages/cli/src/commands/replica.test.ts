/**
 * Replica writes against profile deletion, through the real profile lock and
 * `tc profile delete` (TC-18): a deleted profile is never recreated, and
 * nothing is written into it.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { KVService, type IServiceContext } from "@tinycloud/sdk-core";
import {
  Replica,
  ReplicaErrorCode,
  contentHash,
  isReplicaError,
  kvSyncTransport,
  type ReplicaConfig,
  type VerifiedPage,
} from "@tinycloud/replica";
import { SqliteReplicaStore } from "@tinycloud/replica/sqlite";

// The profile store reads TC_HOME when it loads (and replica.js loads it), so import them afterwards.
const home = await mkdtemp(join("/var/tmp", "tc-replica-guard-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { PROFILES_DIR } = await import("../config/constants.js");
const { createReplica, profileGuard, registerReplicaCommand, replicaSecretsWarning } = await import("./replica.js");
const { removeProfileReplicas } = await import("../lib/profile-replicas.js");

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

async function createProfile(name = PROFILE): Promise<void> {
  await ProfileManager.setProfile(name, {
    name,
    host: config.host,
    did: "did:key:zDoomed",
    chainId: 1,
    spaceName: "default",
    createdAt: "2026-10-01T00:00:00.000Z",
  });
}

async function resetFromCli(profile: string, name: string): Promise<{ exited: boolean; stderr: string }> {
  const program = new Command();
  program.option("--profile <name>").option("--json");
  registerReplicaCommand(program);
  const previousExit = process.exit;
  const previousWrite = process.stderr.write;
  let stderr = "";
  process.exit = (() => { throw new Error("expected CLI exit"); }) as typeof process.exit;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await program.parseAsync(["node", "tc", "--profile", profile, "--json", "replica", "reset", "--replica", name, "--purge"], { from: "node" });
    return { exited: false, stderr };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "expected CLI exit") throw error;
    return { exited: true, stderr };
  } finally {
    process.exit = previousExit;
    process.stderr.write = previousWrite;
  }
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
describe("profile replica removal", () => {
  test("removes all replicas through the store and is clean when none exist", async () => {
    const store = await createReplica(PROFILE, { ...config, name: "notes" });
    await store.close();

    expect(await removeProfileReplicas(PROFILE)).toEqual(["notes"]);
    expect(await readdir(join(PROFILES_DIR, PROFILE, "replicas")).catch(() => [])).toEqual([]);
    expect(await removeProfileReplicas(PROFILE)).toEqual([]);
  });

  test("a sync lease refuses logout purge before any replica is removed", async () => {
    const first = await createReplica(PROFILE, { ...config, name: "first" });
    const second = await createReplica(PROFILE, { ...config, name: "second" });
    const lease = await second.acquireSyncLease(60_000);
    expect(lease).not.toBeNull();
    await first.close();
    await second.close();

    await expect(removeProfileReplicas(PROFILE)).rejects.toThrow("is syncing");
    // readdir order is filesystem-defined (it differs on the CI runner), so compare as a set.
    expect((await readdir(join(PROFILES_DIR, PROFILE, "replicas"))).sort()).toEqual(["first", "second"]);
  });
});
describe("replica purge symlink safety", () => {
  test("refuses a symlinked replicas root and leaves the target profile untouched", async () => {
    await createProfile("victim");
    const victimStore = await createReplica("victim", config);
    await victimStore.close();
    await symlink(
      join(PROFILES_DIR, "victim", "replicas"),
      join(PROFILES_DIR, PROFILE, "replicas"),
    );

    await expect(removeProfileReplicas(PROFILE)).rejects.toMatchObject({
      code: "REPLICA_PURGE_FAILED",
      exitCode: 1,
      message: expect.stringContaining("replicas directory"),
    });
    expect(await exists(join(PROFILES_DIR, "victim", "replicas", "notes", "replica.db"))).toBe(true);
  });

  test("refuses a symlinked replica entry without touching its target", async () => {
    await createProfile("victim");
    const ownStore = await createReplica(PROFILE, config);
    const victimStore = await createReplica("victim", { ...config, name: "victim-replica" });
    await ownStore.close();
    await victimStore.close();
    await symlink(
      join(PROFILES_DIR, "victim", "replicas", "victim-replica"),
      join(PROFILES_DIR, PROFILE, "replicas", "escape"),
    );

    await expect(removeProfileReplicas(PROFILE)).rejects.toMatchObject({
      code: "REPLICA_PURGE_FAILED",
      exitCode: 1,
      message: expect.stringContaining("symlink"),
    });
    expect(await exists(join(PROFILES_DIR, PROFILE, "replicas", "notes", "replica.db"))).toBe(true);
    expect(await exists(join(PROFILES_DIR, "victim", "replicas", "victim-replica", "replica.db"))).toBe(true);
  });
});

describe("replica reset purge containment", () => {
  test("refuses a symlinked replicas root without removing the target replica", async () => {
    await createProfile("victim");
    const victim = await createReplica("victim", config);
    await victim.close();
    await symlink(join(PROFILES_DIR, "victim", "replicas"), join(PROFILES_DIR, PROFILE, "replicas"));

    const result = await resetFromCli(PROFILE, "notes");
    expect(result.exited).toBe(true);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "REPLICA_PURGE_FAILED" } });
    expect(await exists(join(PROFILES_DIR, "victim", "replicas", "notes", "replica.db"))).toBe(true);
  });

  test("refuses a symlinked replica entry without removing its target", async () => {
    await createProfile("victim");
    const victim = await createReplica("victim", config);
    await victim.close();
    await mkdir(join(PROFILES_DIR, PROFILE, "replicas"));
    await symlink(join(PROFILES_DIR, "victim", "replicas", "notes"), join(PROFILES_DIR, PROFILE, "replicas", "notes"));

    const result = await resetFromCli(PROFILE, "notes");
    expect(result.exited).toBe(true);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "REPLICA_PURGE_FAILED" } });
    expect(await exists(join(PROFILES_DIR, "victim", "replicas", "notes", "replica.db"))).toBe(true);
  });

  test("refuses a symlinked whole profile without removing the selected target's data", async () => {
    await createProfile("victim");
    const victim = await createReplica("victim", config);
    await victim.close();
    await symlink(join(PROFILES_DIR, "victim"), join(PROFILES_DIR, "linked"));

    const result = await resetFromCli("linked", "notes");
    expect(result.exited).toBe(true);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
    expect(await exists(join(PROFILES_DIR, "victim", "replicas", "notes", "replica.db"))).toBe(true);
  });

  test("rejects a whole-profile alias before reading or writing its key and session", async () => {
    await createProfile("victim");
    const key = { kty: "OKP", d: "victim-private-key" };
    const session = { delegationCid: "victim-session" };
    await ProfileManager.setKey("victim", key);
    await ProfileManager.setSession("victim", session);
    await symlink(join(PROFILES_DIR, "victim"), join(PROFILES_DIR, "linked"));

    for (const access of [
      () => ProfileManager.getProfile("linked"),
      () => ProfileManager.getKey("linked"),
      () => ProfileManager.getSession("linked"),
      () => ProfileManager.setKey("linked", { kty: "OKP", d: "attacker" }),
      () => ProfileManager.resolveContext({ profile: "linked" }, { storedSession: "unused" }),
    ]) {
      await expect(access()).rejects.toMatchObject({ code: "PROFILE_SYMLINK" });
    }
    expect(await ProfileManager.getKey("victim")).toEqual(key);
    expect(await ProfileManager.getSession("victim")).toEqual(session);
  });

  test("refuses an entry replaced after lookup, before opening the store", async () => {
    await createProfile("victim");
    const own = await createReplica(PROFILE, config);
    const victim = await createReplica("victim", config);
    await own.close();
    await victim.close();
    const entry = join(PROFILES_DIR, PROFILE, "replicas", "notes");
    const originalOpen = SqliteReplicaStore.open;
    let swapped = false;
    SqliteReplicaStore.open = async function (dir, options) {
      if (!swapped && dir.endsWith("/notes") && !options.create) {
        swapped = true;
        await rename(entry, `${entry}.original`);
        await symlink(join(PROFILES_DIR, "victim", "replicas", "notes"), entry);
      }
      return originalOpen.call(this, dir, options);
    };
    try {
      const result = await resetFromCli(PROFILE, "notes");
      expect(result.exited).toBe(true);
      expect(swapped).toBe(true);
      expect(await exists(join(PROFILES_DIR, "victim", "replicas", "notes", "replica.db"))).toBe(true);
      expect(await exists(`${entry}.original/replica.db`)).toBe(true);
    } finally {
      SqliteReplicaStore.open = originalOpen;
    }
  });

  test("purges only its selected replica when the replicas root moves during open", async () => {
    await createProfile("victim");
    const own = await createReplica(PROFILE, config);
    const victim = await createReplica("victim", config);
    await own.close();
    await victim.close();
    const root = join(PROFILES_DIR, PROFILE, "replicas");
    const originalOpen = SqliteReplicaStore.open;
    let swapped = false;
    SqliteReplicaStore.open = async function (dir, options) {
      if (!swapped && dir.endsWith("/notes") && !options.create) {
        swapped = true;
        await rename(root, `${root}.original`);
        await symlink(join(PROFILES_DIR, "victim", "replicas"), root);
      }
      return originalOpen.call(this, dir, options);
    };
    try {
      const result = await resetFromCli(PROFILE, "notes");
      expect(swapped).toBe(true);
      expect(result.exited).toBe(false);
      expect(await exists(join(PROFILES_DIR, "victim", "replicas", "notes", "replica.db"))).toBe(true);
      expect(await exists(`${root}.original/notes/replica.db`)).toBe(false);
    } finally {
      SqliteReplicaStore.open = originalOpen;
    }
  });

  test("refuses an entry swapped for a symlink after the store opens", async () => {
    const store = await createReplica(PROFILE, config);
    await store.close();
    const entry = join(PROFILES_DIR, PROFILE, "replicas", "notes");
    const outside = join(home, "moved-replica");
    const originalDestroy = SqliteReplicaStore.prototype.destroy;
    SqliteReplicaStore.prototype.destroy = async function (lease) {
      await rename(entry, outside);
      await symlink(outside, entry);
      return originalDestroy.call(this, lease);
    };
    try {
      const result = await resetFromCli(PROFILE, "notes");
      expect(result.exited).toBe(true);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "REPLICA_PURGE_FAILED" } });
      expect(await exists(join(outside, "replica.db"))).toBe(true);
    } finally {
      SqliteReplicaStore.prototype.destroy = originalDestroy;
    }
  });
});

describe("replica ciphertext warning", () => {
  test("warns for an allowed secrets prefix and omits the warning on a normal prefix", () => {
    const warning = replicaSecretsWarning(config.space, "vault/secrets/", true);
    expect(warning).toContain("stores the ciphertext of every secret under");
    expect(warning).toContain("tinycloud.encryption/decrypt grant covers the whole encryption network");
    expect(replicaSecretsWarning(config.space, "notes/", true)).toBeUndefined();
  });
});
describe("a replica over the SDK's kv/sync", () => {
  test("an ordinary 401 for a prefix named like a revocation fails the sync and keeps the replica", async () => {
    const prefix = "notes/delegation-revoked/";
    const key = `${prefix}a`;
    const bytes = new TextEncoder().encode("kept");
    const etag = `"blake3-${contentHash(bytes)}"`;
    const page = {
      changes: [{ key, deleted: false, etag, metadata: {} }],
      more: false,
      cursor: "c1",
      source: { nodeDid: "did:key:zNode", space: config.space, prefix },
      authority: { notBefore: null, expiresAt: new Date(Date.now() + 3600_000).toISOString(), retainUntil: null },
    };
    // What the node sends a caller its grant does not cover: the prefix is in the text.
    const unauthorized = `Unauthorized Action: ${config.space}/kv/${prefix} / tinycloud.kv/sync`;
    const answers = [
      { status: 200, body: JSON.stringify(page) },
      { status: 401, body: unauthorized },
    ];
    const context: IServiceContext = {
      session: { delegationHeader: { Authorization: "Bearer test" }, delegationCid: "bafygrant", spaceId: config.space, verificationMethod: "did:key:zDevice", jwk: {} },
      isAuthenticated: true,
      invoke: () => ({ Authorization: "Bearer signed-invocation" }),
      fetch: async () => {
        const { status, body } = answers.shift()!;
        return {
          ok: status === 200,
          status,
          statusText: status === 200 ? "OK" : "Unauthorized",
          headers: { get: () => null },
          json: async () => JSON.parse(body) as unknown,
          text: async () => body,
          arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
          blob: async () => new Blob([body]),
        };
      },
      hosts: [config.host],
      getService: () => undefined,
      emit: () => undefined,
      on: () => () => undefined,
      abortSignal: new AbortController().signal,
      retryPolicy: { maxAttempts: 1, backoff: "exponential", baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
    };
    const kv = new KVService({});
    kv.initialize(context);
    const transport = kvSyncTransport({
      changes: (options) => kv.changes(options),
      get: async () => ({ ok: true, data: { data: bytes, headers: { etag } } }),
      batchGet: async (keys) => ({ ok: true, data: { results: keys.map((k) => ({ key: k, result: { ok: true as const, data: { data: bytes, headers: { etag } } } })) } }),
    });
    const store = await SqliteReplicaStore.open(await mkdtemp(join(home, "replica-")), { create: true });
    await store.init({ ...config, prefix });
    await store.installGrant({ cid: "bafygrant", bytes: new Uint8Array([1]), audience: config.deviceDid, issuer: "did:key:zOwner", notBefore: null, expiresAt: null });
    const replica = new Replica({ store, transport });
    await replica.sync();

    const failed = await replica.sync().then(
      () => undefined,
      (error: unknown) => (isReplicaError(error) ? error.code : String(error)),
    );
    expect(failed).toBe(ReplicaErrorCode.GRANT_UNAUTHORIZED);
    expect((await store.open())?.revoked).toBeNull();
    const read = await replica.get(key);
    expect(read.status === "present" && new TextDecoder().decode(read.value)).toBe("kept");
    await store.close();
  });
});
