/**
 * Replica writes against profile deletion, through the real profile lock and
 * `tc profile delete` (TC-18): a deleted profile is never recreated, and
 * nothing is written into it.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
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
import { SqliteReplicaStore, loadSqlite } from "@tinycloud/replica/sqlite";

// The profile store reads TC_HOME when it loads (and replica.js loads it), so import them afterwards.
const home = await mkdtemp(join("/var/tmp", "tc-replica-guard-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { PROFILES_DIR } = await import("../config/constants.js");
const { createReplica, profileGuard, registerReplicaCommand, replicaSecretsWarning } = await import("./replica.js");
const { removeProfileReplicas } = await import("../lib/profile-replicas.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { createReplicationEventSink } = await import("../lib/replication-log.js");
const { registerReplication, closeReplication } = await import("../lib/replication-registry.js");

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

async function resetFromCli(profile: string, name: string, purge = true): Promise<{ exited: boolean; stderr: string }> {
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
    await program.parseAsync(
      ["node", "tc", "--profile", profile, "--json", "replica", "reset", "--replica", name, ...(purge ? ["--purge"] : [])],
      { from: "node" },
    );
    return { exited: false, stderr };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "expected CLI exit") throw error;
    return { exited: true, stderr };
  } finally {
    process.exit = previousExit;
    process.stderr.write = previousWrite;
  }
}

async function readFromCli(profile: string, args: string[]): Promise<{ exited: boolean; stdout: string; stderr: string }> {
  const program = new Command().option("--profile <name>").option("--json");
  registerReplicaCommand(program);
  const previousExit = process.exit;
  const previousOutput = process.stdout.write;
  const previousError = process.stderr.write;
  let stdout = "";
  let stderr = "";
  let exited = false;
  process.exit = (() => { throw new Error("expected CLI exit"); }) as typeof process.exit;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += Buffer.from(chunk).toString("utf8"); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += Buffer.from(chunk).toString("utf8"); return true; }) as typeof process.stderr.write;
  try {
    await program.parseAsync(["node", "tc", "--profile", profile, "--json", ...args], { from: "node" });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "expected CLI exit") throw error;
    exited = true;
  } finally {
    process.exit = previousExit;
    process.stdout.write = previousOutput;
    process.stderr.write = previousError;
  }
  return { exited, stdout, stderr };
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

  test("non-purge reset refuses a profile alias before opening or migrating its database", async () => {
    await createProfile("victim");
    const victim = await createReplica("victim", config);
    await victim.close();
    const victimDb = join(PROFILES_DIR, "victim", "replicas", "notes", "replica.db");
    const sqlite = await loadSqlite();
    const db = sqlite(victimDb);
    try {
      db.exec("PRAGMA user_version = 0");
    } finally {
      db.close();
    }
    const before = await readFile(victimDb);
    await symlink(join(PROFILES_DIR, "victim"), join(PROFILES_DIR, "linked"));

    const result = await resetFromCli("linked", "notes", false);
    expect(result.exited).toBe(true);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
    expect(await readFile(victimDb)).toEqual(before);
    const readonly = sqlite(victimDb, { readonly: true });
    try {
      expect(readonly.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(0);
    } finally {
      readonly.close();
    }
  });

  test("sync pins the selected profile through its SQLite open after a real-directory swap", async () => {
    await createProfile("victim");
    await ProfileManager.setKey(PROFILE, { kty: "OKP", d: "selected-key" });
    const victim = await createReplica("victim", config);
    await victim.close();
    const victimDb = join(PROFILES_DIR, "victim", "replicas", "notes", "replica.db");
    const sqlite = await loadSqlite();
    const db = sqlite(victimDb);
    try {
      db.exec("PRAGMA user_version = 0");
    } finally {
      db.close();
    }
    const before = await readFile(victimDb);
    const selected = join(PROFILES_DIR, PROFILE);
    const moved = `${selected}.moved`;
    const originalGetKey = ProfileManager.getKey;
    let swapped = false;
    ProfileManager.getKey = async function (name) {
      const key = await originalGetKey.call(this, name);
      if (name === PROFILE && !swapped) {
        swapped = true;
        await rename(selected, moved);
        await symlink(join(PROFILES_DIR, "victim"), selected);
      }
      return key;
    };
    try {
      const result = await readFromCli(PROFILE, ["replica", "sync", "--replica", "notes"]);
      expect(swapped).toBe(true);
      expect(result.exited).toBe(true);
      expect(await readFile(victimDb)).toEqual(before);
      const readonly = sqlite(victimDb, { readonly: true });
      try {
        expect(readonly.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(0);
      } finally {
        readonly.close();
      }
    } finally {
      ProfileManager.getKey = originalGetKey;
    }
  });

  test("report keeps local diagnostics scoped to the selected profile after a directory swap", async () => {
    await createProfile("victim");
    const partition = join(PROFILES_DIR, "victim", "replication", "a".repeat(26));
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify({ host: "victim.example", space: "victim-space" }));
    const selected = join(PROFILES_DIR, PROFILE);
    const originalResolve = ProfileManager.resolveContext;
    let swapped = false;
    ProfileManager.resolveContext = async function (globals) {
      const context = await originalResolve.call(this, globals);
      if (!swapped) {
        swapped = true;
        await rename(selected, `${selected}.moved`);
        await symlink(join(PROFILES_DIR, "victim"), selected);
      }
      return context;
    };
    try {
      const result = await readFromCli(PROFILE, ["replica", "report"]);
      expect(swapped).toBe(true);
      expect(result.stdout).not.toContain("victim.example");
      expect(result.stdout).not.toContain("victim-space");
    } finally {
      ProfileManager.resolveContext = originalResolve;
    }
  });

  test.skipIf(process.platform !== "linux")("report closes its replication runtime before releasing the pinned profile", async () => {
    const originalResolve = ProfileManager.resolveContext;
    const selected = await stat(join(PROFILES_DIR, PROFILE));
    let closedWhilePinned = false;
    ProfileManager.resolveContext = async function (globals) {
      const context = await originalResolve.call(this, globals);
      const root = profilePath(PROFILE);
      const sink = createReplicationEventSink(root, { debug: false, quiet: true });
      registerReplication(PROFILE, {
        status: async () => [],
        sync: async () => undefined,
        purge: async () => ({ purged: [], failed: [] }),
        clearPending: async () => 0,
        close: async () => {
          const pinned = await stat(root).then(
            (entry) => entry.isDirectory() && entry.dev === selected.dev && entry.ino === selected.ino,
            () => false,
          );
          if (!pinned) return;
          sink({ type: "replication.state", at: new Date().toISOString(), space: "default", replica: "notes/", state: "closed" });
          closedWhilePinned = true;
        },
      });
      return context;
    };
    try {
      const result = await readFromCli(PROFILE, ["replica", "report"]);
      expect(result.exited).toBe(false);
      expect(closedWhilePinned).toBe(true);
      const events = await readFile(join(PROFILES_DIR, PROFILE, "replication", "events.jsonl"), "utf8");
      expect(events).toContain('"state":"closed"');
    } finally {
      ProfileManager.resolveContext = originalResolve;
      await closeReplication();
    }
  });

  test.skipIf(process.platform !== "linux")("report times out nonzero but retains the profile pin until a late close settles", async () => {
    const originalResolve = ProfileManager.resolveContext;
    const selected = await stat(join(PROFILES_DIR, PROFILE));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let root = "";
    let closedWhilePinned = false;
    ProfileManager.resolveContext = async function (globals) {
      const context = await originalResolve.call(this, globals);
      root = profilePath(PROFILE);
      const sink = createReplicationEventSink(root, { debug: false, quiet: true });
      registerReplication(PROFILE, {
        status: async () => [],
        sync: async () => undefined,
        purge: async () => ({ purged: [], failed: [] }),
        clearPending: async () => 0,
        close: async () => {
          entered.resolve();
          await release.promise;
          const pinned = await stat(root).then(
            (entry) => entry.isDirectory() && entry.dev === selected.dev && entry.ino === selected.ino,
            () => false,
          );
          if (!pinned) return;
          sink({ type: "replication.state", at: new Date().toISOString(), space: "default", replica: "notes/", state: "closed" });
          closedWhilePinned = true;
        },
      });
      return context;
    };
    let running: ReturnType<typeof readFromCli> | undefined;
    try {
      running = readFromCli(PROFILE, ["replica", "report"]);
      await entered.promise;
      const elapsed = Promise.withResolvers<void>();
      setTimeout(elapsed.resolve, 3_300);
      await elapsed.promise;
      const pinnedAfterDeadline = await stat(root).then(
        (entry) => entry.isDirectory() && entry.dev === selected.dev && entry.ino === selected.ino,
        () => false,
      );
      release.resolve();
      const result = await running;
      expect(pinnedAfterDeadline).toBe(true);
      expect(closedWhilePinned).toBe(true);
      expect(result.exited).toBe(true);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "REPLICATION_CLOSE_TIMEOUT" } });
      expect(result.stderr).toContain("replication close did not finish");
      const events = await readFile(join(PROFILES_DIR, PROFILE, "replication", "events.jsonl"), "utf8");
      expect(events).toContain('"state":"closed"');
    } finally {
      release.resolve();
      if (running) await running;
      ProfileManager.resolveContext = originalResolve;
      await closeReplication();
    }
  }, 10_000);

  test("report refuses an absent profile even when it becomes a victim alias during context resolution", async () => {
    await createProfile("victim");
    const partition = join(PROFILES_DIR, "victim", "replication", "a".repeat(26));
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify({ host: "victim.example", space: "victim-space" }));
    const selected = join(PROFILES_DIR, PROFILE);
    await rm(selected, { recursive: true });
    const originalResolve = ProfileManager.resolveContext;
    ProfileManager.resolveContext = async function (globals) {
      const context = await originalResolve.call(this, globals);
      await symlink(join(PROFILES_DIR, "victim"), selected);
      return context;
    };
    try {
      const result = await readFromCli(PROFILE, ["replica", "report"]);
      expect(result.exited).toBe(true);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_NOT_FOUND" } });
      expect(result.stdout).toBe("");
      expect(result.stdout).not.toContain("victim.example");
    } finally {
      ProfileManager.resolveContext = originalResolve;
    }
  });

  test("a symlinked replica.db cannot acquire a lease in the victim database", async () => {
    await createProfile("victim");
    const own = await createReplica(PROFILE, config);
    const victim = await createReplica("victim", config);
    await own.close();
    await victim.close();
    const selectedDb = join(PROFILES_DIR, PROFILE, "replicas", "notes", "replica.db");
    const victimDb = join(PROFILES_DIR, "victim", "replicas", "notes", "replica.db");
    const sqlite = await loadSqlite();
    const readToken = () => {
      const db = sqlite(victimDb, { readonly: true });
      try { return db.get<{ lease_token: number }>("SELECT lease_token FROM replica WHERE id = 1")?.lease_token; }
      finally { db.close(); }
    };
    const before = readToken();
    await unlink(selectedDb);
    await symlink(victimDb, selectedDb);

    expect((await resetFromCli(PROFILE, "notes")).exited).toBe(true);
    expect(readToken()).toBe(before);
    expect(await exists(victimDb)).toBe(true);
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

  test("replica status refuses a whole-profile alias without reading the victim store", async () => {
    await createProfile("victim");
    const victim = await createReplica("victim", config);
    await victim.close();
    await symlink(join(PROFILES_DIR, "victim"), join(PROFILES_DIR, "linked"));
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
      await expect(program.parseAsync(["node", "tc", "--profile", "linked", "--json", "replica", "status", "--replica", "notes"], { from: "node" }))
        .rejects.toThrow("expected CLI exit");
      expect(JSON.parse(stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
      expect(await exists(join(PROFILES_DIR, "victim", "replicas", "notes", "replica.db"))).toBe(true);
    } finally {
      process.exit = previousExit;
      process.stderr.write = previousWrite;
    }
  });

  test("a pending logout marker blocks every legacy read for its profile and an alias", async () => {
    const store = await createReplica(PROFILE, config);
    const lease = await store.acquireSyncLease(60_000);
    expect(lease).not.toBeNull();
    await store.applyPage(lease!, page());
    await store.releaseLease(lease!);
    await store.close();
    const commands = [
      ["replica", "get", "notes/a", "--replica", "notes", "--raw"],
      ["replica", "list", "--replica", "notes"],
      ["replica", "status", "--replica", "notes"],
    ];
    for (const command of commands) expect((await readFromCli(PROFILE, command)).exited).toBe(false);
    await writeFile(join(PROFILES_DIR, PROFILE, "replica-logout-pending.json"), "{}");
    await symlink(join(PROFILES_DIR, PROFILE), join(PROFILES_DIR, "linked"));

    for (const profile of [PROFILE, "linked"]) {
      for (const command of commands) {
        const result = await readFromCli(profile, command);
        expect(result.exited).toBe(true);
        expect(JSON.parse(result.stderr).error.code).toBe(profile === PROFILE ? "REPLICA_GATED" : "PROFILE_SYMLINK");
        expect(result.stdout).not.toContain("secret");
        expect(result.stdout).not.toContain("notes/a");
      }
    }
    expect(await exists(join(PROFILES_DIR, PROFILE, "replicas", "notes", "replica.db"))).toBe(true);
  });

  test("an in-flight legacy get refuses a marker committed after SQLite read", async () => {
    const store = await createReplica(PROFILE, config);
    const lease = await store.acquireSyncLease(60_000);
    expect(lease).not.toBeNull();
    await store.applyPage(lease!, page());
    await store.releaseLease(lease!);
    await store.close();
    const originalGet = SqliteReplicaStore.prototype.get;
    const marker = join(PROFILES_DIR, PROFILE, "replica-logout-pending.json");
    let readCompleted = false;
    SqliteReplicaStore.prototype.get = async function (key) {
      const entry = await originalGet.call(this, key);
      readCompleted = true;
      await writeFile(marker, "{}");
      return entry;
    };
    try {
      const result = await readFromCli(PROFILE, ["replica", "get", "notes/a", "--replica", "notes", "--raw"]);
      expect(readCompleted).toBe(true);
      expect(result.exited).toBe(true);
      expect(JSON.parse(result.stderr).error.code).toBe("REPLICA_GATED");
      expect(result.stdout).not.toContain("secret");
      expect(await exists(join(PROFILES_DIR, PROFILE, "replicas", "notes", "replica.db"))).toBe(true);
    } finally {
      SqliteReplicaStore.prototype.get = originalGet;
    }
  });

  test("a whole-profile alias cannot read another profile's legacy values or keys", async () => {
    await createProfile("victim");
    const store = await createReplica("victim", config);
    const lease = await store.acquireSyncLease(60_000);
    expect(lease).not.toBeNull();
    await store.applyPage(lease!, page());
    await store.releaseLease(lease!);
    await store.close();
    expect((await readFromCli("victim", ["replica", "get", "notes/a", "--replica", "notes", "--raw"])).stdout).toContain("secret");
    await symlink(join(PROFILES_DIR, "victim"), join(PROFILES_DIR, "linked"));

    for (const command of [
      ["replica", "get", "notes/a", "--replica", "notes", "--raw"],
      ["replica", "list", "--replica", "notes"],
      ["replica", "status", "--replica", "notes"],
    ]) {
      const result = await readFromCli("linked", command);
      expect(result.exited).toBe(true);
      expect(JSON.parse(result.stderr).error.code).toBe("PROFILE_SYMLINK");
      expect(result.stdout).not.toContain("secret");
      expect(result.stdout).not.toContain("notes/a");
    }
    expect((await readFromCli("victim", ["replica", "get", "notes/a", "--replica", "notes", "--raw"])).stdout).toContain("secret");
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

  test("refuses a real replica entry swapped before SQLite can open it", async () => {
    await createProfile("victim");
    const own = await createReplica(PROFILE, config);
    const victim = await createReplica("victim", config);
    await own.close();
    await victim.close();
    const entry = join(PROFILES_DIR, PROFILE, "replicas", "notes");
    const victimEntry = join(PROFILES_DIR, "victim", "replicas", "notes");
    const originalOpen = SqliteReplicaStore.open;
    let sqliteCalled = false;
    SqliteReplicaStore.open = async function (dir, options) {
      await rename(entry, `${entry}.original`);
      await rename(victimEntry, entry);
      return originalOpen.call(this, dir, {
        ...options,
        sqlite: () => {
          sqliteCalled = true;
          throw new Error("SQLite must not open a replaced replica entry");
        },
      });
    };
    try {
      expect((await resetFromCli(PROFILE, "notes")).exited).toBe(true);
      expect(sqliteCalled).toBe(false);
      expect(await exists(`${entry}.original/replica.db`)).toBe(true);
      expect(await exists(join(entry, "replica.db"))).toBe(true);
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
