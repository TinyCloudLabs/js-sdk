/**
 * Replica writes against profile deletion, through the real profile lock and
 * `tc profile delete` (TC-18): a deleted profile is never recreated, and
 * nothing is written into it.
 */
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { KVService, type IServiceContext } from "@tinycloud/sdk-core";
import {
  Replica,
  ReplicaErrorCode,
  ReplicaError,
  contentHash,
  isReplicaError,
  kvSyncTransport,
  type ReplicaConfig,
  type VerifiedPage,
} from "@tinycloud/replica";
import { SqliteReplicaStore, loadSqlite } from "@tinycloud/replica/sqlite";
import { establishSessionStamp } from "@tinycloud/replica/profile-gate";

// The profile store reads TC_HOME when it loads (and replica.js loads it), so import them afterwards.
const home = await mkdtemp(join("/var/tmp", "tc-replica-guard-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { PROFILES_DIR } = await import("../config/constants.js");
const { createReplica, profileGuard, registerReplicaCommand, replicaSecretsWarning } = await import("./replica.js");
const { registerAuthCommand } = await import("./auth.js");
const { removeProfileReplicas } = await import("../lib/profile-replicas.js");
const { profilePath, withPinnedProfileDirectory } = await import("@tinycloud/operations/state");
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
async function establishReadableSession(profile = PROFILE): Promise<void> {
  const ownerDid = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
  const replicaStamp = await establishSessionStamp(join(PROFILES_DIR, profile), ownerDid, { siweIssuedAt: Date.now() });
  await ProfileManager.setSession(profile, { ownerDid, replicaStamp });
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

async function readFromCli(profile: string, args: string[]): Promise<{ exited: boolean; exitCode: number | null; stdout: string; stderr: string }> {
  const program = new Command().option("--profile <name>").option("--json");
  registerReplicaCommand(program);
  const previousExit = process.exit;
  const previousOutput = process.stdout.write;
  const previousError = process.stderr.write;
  let stdout = "";
  let stderr = "";
  let exited = false;
  let exitCode: number | null = null;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error("expected CLI exit"); }) as typeof process.exit;
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
  return { exited, exitCode, stdout, stderr };
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
test("replica budget and expired consent report distinct actionable exit codes", async () => {
  const store = await createReplica(PROFILE, config);
  await store.close();
  await establishReadableSession();
  for (const { code, message, exitCode, guidance } of [
    { code: ReplicaErrorCode.STORAGE_BUDGET, message: "The replica page exceeds the origin's byte budget.", exitCode: 10, guidance: /byte budget/i },
    { code: ReplicaErrorCode.CONSENT_EXPIRED, message: "The account consent has expired.", exitCode: 5, guidance: /sign in again.*renew consent/i },
  ]) {
    const get = spyOn(Replica.prototype, "get").mockRejectedValueOnce(new ReplicaError(code, message));
    try {
      const result = await readFromCli(PROFILE, ["replica", "get", "notes/a", "--replica", "notes"]);
      expect(result.stdout).toBe("");
      const displayed = JSON.parse(result.stderr) as { error: { code: string; message: string; hint?: string } };
      expect(displayed.error.code).toBe(code);
      expect(result.exitCode).toBe(exitCode);
      expect(displayed.error.message).toContain(message);
      expect(`${displayed.error.message} ${displayed.error.hint ?? ""}`).toMatch(guidance);
    } finally {
      get.mockRestore();
    }
  }
}, 30_000);

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

  const readCommands: Array<[string, string[]]> = [
    ["reset", ["replica", "reset", "--replica", "notes"]],
    ["get", ["replica", "get", "notes/a", "--replica", "notes"]],
    ["list", ["replica", "list", "--replica", "notes"]],
    ["status", ["replica", "status", "--replica", "notes"]],
    ["sync", ["replica", "sync", "--replica", "notes"]],
    ["report", ["replica", "report"]],
  ];

  async function victimDatabaseAtOldVersion(): Promise<{ path: string; before: Buffer }> {
    await createProfile("victim");
    await ProfileManager.setKey(PROFILE, { kty: "OKP", d: "selected-key" });
    const victim = await createReplica("victim", config);
    await victim.close();
    const path = join(PROFILES_DIR, "victim", "replicas", "notes", "replica.db");
    const sqlite = await loadSqlite();
    const db = sqlite(path);
    try {
      db.exec("PRAGMA user_version = 0");
    } finally {
      db.close();
    }
    return { path, before: await readFile(path) };
  }

  async function expectVictimDatabaseUnchanged(path: string, before: Buffer): Promise<void> {
    expect((await readFile(path)).equals(before)).toBe(true);
    const sqlite = await loadSqlite();
    const readonly = sqlite(path, { readonly: true });
    try {
      expect(readonly.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(0);
    } finally {
      readonly.close();
    }
  }

  test.each(readCommands)("a symlinked replicas root refuses %s before opening a victim database", async (_command, args) => {
    const victim = await victimDatabaseAtOldVersion();
    await symlink(join(PROFILES_DIR, "victim", "replicas"), join(PROFILES_DIR, PROFILE, "replicas"));
    await establishReadableSession();

    const result = await readFromCli(PROFILE, args);
    await expectVictimDatabaseUnchanged(victim.path, victim.before);
    expect(result.exited).toBe(true);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
  });

  test.each(readCommands)("a symlinked replica entry refuses %s before opening a victim database", async (_command, args) => {
    const victim = await victimDatabaseAtOldVersion();
    const root = join(PROFILES_DIR, PROFILE, "replicas");
    await mkdir(root);
    await symlink(join(PROFILES_DIR, "victim", "replicas", "notes"), join(root, "notes"));
    await establishReadableSession();

    const result = await readFromCli(PROFILE, args);
    await expectVictimDatabaseUnchanged(victim.path, victim.before);
    expect(result.exited).toBe(true);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
  });

  test.each(readCommands)("a symlinked replica.db refuses %s before opening a victim database", async (_command, args) => {
    const victim = await victimDatabaseAtOldVersion();
    const own = await createReplica(PROFILE, config);
    await own.close();
    const selectedDb = join(PROFILES_DIR, PROFILE, "replicas", "notes", "replica.db");
    await unlink(selectedDb);
    await symlink(victim.path, selectedDb);
    await establishReadableSession();

    const result = await readFromCli(PROFILE, args);
    await expectVictimDatabaseUnchanged(victim.path, victim.before);
    expect(result.exited).toBe(true);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
  });

  test("replica creation refuses a linked root before writing to a victim database", async () => {
    const victim = await victimDatabaseAtOldVersion();
    await symlink(join(PROFILES_DIR, "victim", "replicas"), join(PROFILES_DIR, PROFILE, "replicas"));
    await expect(createReplica(PROFILE, config)).rejects.toMatchObject({ code: "PROFILE_SYMLINK" });
    await expectVictimDatabaseUnchanged(victim.path, victim.before);
  });

  test.each(["darwin", "win32"])("named-path %s reset refuses a linked replicas root without DB writes", async (platform) => {
    const victim = await victimDatabaseAtOldVersion();
    await symlink(join(PROFILES_DIR, "victim", "replicas"), join(PROFILES_DIR, PROFILE, "replicas"));
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: platform });
    try {
      const result = await readFromCli(PROFILE, ["replica", "reset", "--replica", "notes"]);
      await expectVictimDatabaseUnchanged(victim.path, victim.before);
      expect(result.exited).toBe(true);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test.each(["darwin", "win32"])("named-path %s status still reads a real selected replica", async (platform) => {
    const store = await createReplica(PROFILE, config);
    await store.close();
    await establishReadableSession();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: platform });
    try {
      const result = await readFromCli(PROFILE, ["replica", "status", "--replica", "notes"]);
      expect(result.exited).toBe(false);
      expect(JSON.parse(result.stdout)).toMatchObject({ name: "notes" });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test.each(["darwin", "win32"])("named-path %s reset rechecks a moved profile immediately before SQLite open", async (platform) => {
    await createProfile("victim");
    const own = await createReplica(PROFILE, config);
    await own.close();
    const victim = await victimDatabaseAtOldVersion();
    const selected = join(PROFILES_DIR, PROFILE);
    const parked = `${selected}.parked`;
    const originalLstat = fsPromises.lstat;
    const originalOpen = SqliteReplicaStore.open;
    const originalPlatform = process.platform;
    let moved = false;
    let sqliteOpenAttempted = false;
    const lstatSpy = spyOn(fsPromises, "lstat").mockImplementation(async (...args) => {
      const info = await originalLstat(...args);
      if (!moved && String(args[0]) === join(selected, "replicas", "notes", "replica.db")) {
        await rename(selected, parked);
        await symlink(join(PROFILES_DIR, "victim"), selected);
        moved = true;
      }
      return info;
    });
    SqliteReplicaStore.open = async function (dir, options) {
      if (!options.create) sqliteOpenAttempted = true;
      return originalOpen.call(this, dir, options);
    };
    Object.defineProperty(process, "platform", { value: platform });
    try {
      const result = await readFromCli(PROFILE, ["replica", "reset", "--replica", "notes"]);
      expect(moved).toBe(true);
      expect(result.exited).toBe(true);
      expect(sqliteOpenAttempted).toBe(false);
      await expectVictimDatabaseUnchanged(victim.path, victim.before);
      expect(await exists(join(parked, "replicas", "notes", "replica.db"))).toBe(true);
    } finally {
      lstatSpy.mockRestore();
      SqliteReplicaStore.open = originalOpen;
      Object.defineProperty(process, "platform", { value: originalPlatform });
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

  test("report refuses a whole-profile alias without reading the target diagnostics", async () => {
    await createProfile("victim");
    const partition = join(PROFILES_DIR, "victim", "replication", "a".repeat(26));
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify({ host: "victim.example", space: "victim-space" }));
    const selected = join(PROFILES_DIR, PROFILE);
    await rm(selected, { recursive: true });
    await symlink(join(PROFILES_DIR, "victim"), selected);
    const result = await readFromCli(PROFILE, ["replica", "report"]);
    expect(result.exited).toBe(true);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
    expect(result.stdout).toBe("");
  });

  test("report refuses a symlinked replication root without exposing another profile", async () => {
    await createProfile("victim");
    const victimRoot = join(PROFILES_DIR, "victim", "replication");
    const partition = join(victimRoot, "a".repeat(26));
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify({ host: "victim.example", space: "victim-space" }));
    await symlink(victimRoot, join(PROFILES_DIR, PROFILE, "replication"));

    const result = await readFromCli(PROFILE, ["replica", "report"]);
    expect(result.exited).toBe(true);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
    expect(result.stderr).not.toContain("victim.example");
  });

  test("report refuses a symlinked partition directory instead of skipping it", async () => {
    await createProfile("victim");
    const partitionName = "a".repeat(26);
    const victimPartition = join(PROFILES_DIR, "victim", "replication", partitionName);
    await mkdir(victimPartition, { recursive: true });
    await writeFile(join(victimPartition, "identity.json"), JSON.stringify({ host: "victim.example" }));
    const selectedRoot = join(PROFILES_DIR, PROFILE, "replication");
    await mkdir(selectedRoot);
    await symlink(victimPartition, join(selectedRoot, partitionName));

    const result = await readFromCli(PROFILE, ["replica", "report"]);
    expect(result.exited).toBe(true);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
    expect(result.stderr).not.toContain("victim.example");
  });

  test("report refuses a symlinked identity file without disclosing its host", async () => {
    await createProfile("victim");
    const partitionName = "a".repeat(26);
    const victimPartition = join(PROFILES_DIR, "victim", "replication", partitionName);
    const selectedPartition = join(PROFILES_DIR, PROFILE, "replication", partitionName);
    await mkdir(victimPartition, { recursive: true });
    await mkdir(selectedPartition, { recursive: true });
    await writeFile(join(victimPartition, "identity.json"), JSON.stringify({ host: "victim.example" }));
    await symlink(join(victimPartition, "identity.json"), join(selectedPartition, "identity.json"));

    const result = await readFromCli(PROFILE, ["replica", "report"]);
    expect(result.exited).toBe(true);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
    expect(result.stderr).not.toContain("victim.example");
  });

  test("report refuses a symlinked event file without disclosing its counts", async () => {
    await createProfile("victim");
    const victimRoot = join(PROFILES_DIR, "victim", "replication");
    const selectedRoot = join(PROFILES_DIR, PROFILE, "replication");
    await mkdir(victimRoot);
    await mkdir(selectedRoot);
    await writeFile(join(victimRoot, "events.jsonl"), `${JSON.stringify({
      type: "replication.read", at: new Date().toISOString(), source: "replica", reason: "hit",
    })}\n`);
    await symlink(join(victimRoot, "events.jsonl"), join(selectedRoot, "events.jsonl"));

    const result = await readFromCli(PROFILE, ["replica", "report"]);
    expect(result.exited).toBe(true);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
  });

  test("report refuses a symlinked pending file without disclosing its records", async () => {
    await createProfile("victim");
    const partitionName = "a".repeat(26);
    const victimPartition = join(PROFILES_DIR, "victim", "replication", partitionName);
    const selectedPartition = join(PROFILES_DIR, PROFILE, "replication", partitionName);
    await mkdir(victimPartition, { recursive: true });
    await mkdir(selectedPartition, { recursive: true });
    await writeFile(join(victimPartition, "pending.json"), JSON.stringify({ records: [{ state: "in_flight" }] }));
    await symlink(join(victimPartition, "pending.json"), join(selectedPartition, "pending.json"));

    const result = await readFromCli(PROFILE, ["replica", "report"]);
    expect(result.exited).toBe(true);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
  });

  test.each(["darwin", "win32"])("report checks named descendant identity on %s", async (platform) => {
    await createProfile("victim");
    const victimRoot = join(PROFILES_DIR, "victim", "replication");
    await mkdir(victimRoot);
    await symlink(victimRoot, join(PROFILES_DIR, PROFILE, "replication"));
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: platform });
    try {
      const result = await readFromCli(PROFILE, ["replica", "report"]);
      expect(result.exited).toBe(true);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test("report reads a regular persisted identity and pending summary", async () => {
    const partitionName = "a".repeat(26);
    const partition = join(PROFILES_DIR, PROFILE, "replication", partitionName);
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify({ host: "selected.example", space: "selected-space" }));
    await writeFile(join(partition, "pending.json"), JSON.stringify({ records: [{ state: "in_flight" }, { state: "committed" }] }));

    const result = await readFromCli(PROFILE, ["replica", "report"]);
    expect(result.exited).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      partitions: [{ idHash: partitionName, host: "selected.example", space: "selected-space", pinned: 1 }],
      replicasUnavailable: true,
    });
  });

  test("report refuses a real diagnostics-root replacement between event and partition reads", async () => {
    const selectedRoot = join(PROFILES_DIR, PROFILE, "replication");
    const parked = join(PROFILES_DIR, PROFILE, "replication-parked");
    const victimRoot = join(PROFILES_DIR, "victim", "replication");
    await createProfile("victim");
    await mkdir(selectedRoot);
    await mkdir(join(victimRoot, "a".repeat(26)), { recursive: true });
    await writeFile(join(selectedRoot, "events.jsonl"), `${JSON.stringify({
      type: "replication.read", at: new Date().toISOString(), source: "replica",
      reason: "tc841-report-swap", latencyMs: 1, stalenessMs: 0,
    })}\n`);
    await writeFile(join(victimRoot, "a".repeat(26), "identity.json"), JSON.stringify({ host: "victim.example" }));
    const originalParse = JSON.parse;
    let swapped = false;
    JSON.parse = ((text: string, reviver?: (this: any, key: string, value: any) => any) => {
      const parsed = originalParse(text, reviver);
      if (!swapped && text.includes("tc841-report-swap")) {
        renameSync(selectedRoot, parked);
        renameSync(victimRoot, selectedRoot);
        swapped = true;
      }
      return parsed;
    }) as typeof JSON.parse;
    let result: Awaited<ReturnType<typeof readFromCli>>;
    try {
      result = await readFromCli(PROFILE, ["replica", "report"]);
    } finally {
      JSON.parse = originalParse;
    }
    expect(swapped).toBe(true);
    expect(result.exited).toBe(true);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_SYMLINK" } });
  });

  test("report reads persisted events without starting replication", async () => {
    const root = join(PROFILES_DIR, PROFILE, "replication");
    await mkdir(root, { recursive: true });
    const eventsPath = join(root, "events.jsonl");
    const original = Buffer.from(`${JSON.stringify({
      type: "replication.read",
      at: new Date().toISOString(),
      source: "replica",
      reason: "hit",
      latencyMs: 1,
      stalenessMs: 0,
    })}\n`);
    await writeFile(eventsPath, original);
    const previousReplication = process.env.TC_REPLICATION;
    process.env.TC_REPLICATION = "1";
    try {
      const result = await readFromCli(PROFILE, ["replica", "report"]);
      expect(result.exited).toBe(false);
      expect(JSON.parse(result.stdout)).toMatchObject({ totals: { reads: 1 }, replicasUnavailable: true });
      expect(await readFile(eventsPath)).toEqual(original);
    } finally {
      if (previousReplication === undefined) delete process.env.TC_REPLICATION;
      else process.env.TC_REPLICATION = previousReplication;
    }
  });

  test.skipIf(process.platform !== "linux")("report never closes a control whose descriptor now names another profile", async () => {
    await createProfile("victim");
    const victimEvents = join(PROFILES_DIR, "victim", "replication", "events.jsonl");
    await mkdir(join(PROFILES_DIR, "victim", "replication"), { recursive: true });
    const original = Buffer.from("victim-event-sentinel\n");
    await writeFile(victimEvents, original);
    await withPinnedProfileDirectory("victim", async () => {
      const reusedRoot = profilePath("victim");
      const sink = createReplicationEventSink(reusedRoot, { debug: false, quiet: true });
      let emitOnClose = true;
      registerReplication(PROFILE, {
        status: async () => [],
        sync: async () => undefined,
        purge: async () => ({ purged: [], failed: [] }),
        clearPending: async () => 0,
        close: async () => {
          if (emitOnClose) sink({ type: "replication.state", at: new Date().toISOString(), space: "default", replica: "notes/", state: "closed" });
        },
      });
      try {
        const result = await readFromCli(PROFILE, ["replica", "report"]);
        expect(result.exited).toBe(false);
        expect(await readFile(victimEvents)).toEqual(original);
        expect(JSON.parse(result.stdout)).toMatchObject({ replicasUnavailable: true });
      } finally {
        emitOnClose = false;
        await closeReplication();
      }
    });
  });

  test.each([
    ["--purge", "replica reset --replica <name> --purge"],
    ["--clear-pending", "TC-1309"],
  ])("report refuses %s without starting a runtime", async (option, guidance) => {
    const result = await readFromCli(PROFILE, ["replica", "report", option]);
    expect(result.exited).toBe(true);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "REPORT_READ_ONLY" } });
    expect(result.stderr).toContain(guidance);
  });

  test("report refuses an absent profile without reading another profile's diagnostics", async () => {
    await createProfile("victim");
    const partition = join(PROFILES_DIR, "victim", "replication", "a".repeat(26));
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify({ host: "victim.example", space: "victim-space" }));
    await rm(join(PROFILES_DIR, PROFILE), { recursive: true });
    const result = await readFromCli(PROFILE, ["replica", "report"]);
    expect(result.exited).toBe(true);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "PROFILE_NOT_FOUND" } });
    expect(result.stdout).toBe("");
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
    await establishReadableSession();
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
    await establishReadableSession();
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
    await establishReadableSession("victim");
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

type CliResult = { exited: boolean; stdout: string; stderr: string };

async function logoutFromCli(profile: string): Promise<CliResult> {
  const program = new Command().option("--profile <name>").option("--json");
  registerAuthCommand(program);
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
    await program.parseAsync(["node", "tc", "--profile", profile, "--json", "auth", "logout"], { from: "node" });
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

// Deny-first (CONTRACT.md §2 "Sign-out and account switch"): the durable logout
// fence commits before credentials go; a replica that cannot be erased stays
// behind that fence and the error says so.
describe("plain auth logout with real profile replicas", () => {
  const replicaDb = join(PROFILES_DIR, PROFILE, "replicas", "notes", "replica.db");
  const sessionFile = join(PROFILES_DIR, PROFILE, "session.json");

  test("removes the replicas and clears the session", async () => {
    const store = await createReplica(PROFILE, config);
    await store.close();
    await ProfileManager.setSession(PROFILE, { delegationCid: "doomed-session" });

    const result = await logoutFromCli(PROFILE);

    expect(result.exited).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({ profile: PROFILE, authenticated: false });
    expect(await exists(sessionFile)).toBe(false);
    expect(await exists(replicaDb)).toBe(false);
  });

  test("a replica still syncing stays behind the committed fence and the error says so", async () => {
    const store = await createReplica(PROFILE, config);
    expect(await store.acquireSyncLease(60_000)).not.toBeNull();
    await store.close();
    await ProfileManager.setSession(PROFILE, { delegationCid: "doomed-session" });

    const result = await logoutFromCli(PROFILE);

    expect(result.exited).toBe(true);
    const { error } = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(error.code).toBe("REPLICA_PURGE_FAILED");
    expect(error.message).toContain("the profile is signed out and the durable marker denies local reads");
    expect(await exists(join(PROFILES_DIR, PROFILE, "replica-logout-pending.json"))).toBe(true);
    expect(await exists(sessionFile)).toBe(false);
    expect(await exists(replicaDb)).toBe(true);
  });

  test.each(["darwin", "win32"])("on %s removes the legacy mirror through checked named paths", async (platform) => {
    const store = await createReplica(PROFILE, config);
    await store.close();
    await ProfileManager.setSession(PROFILE, { delegationCid: "doomed-session" });
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: platform });
    let result: CliResult;
    try {
      result = await logoutFromCli(PROFILE);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }

    expect(result.exited).toBe(false);
    expect(await exists(sessionFile)).toBe(false);
    expect(await exists(replicaDb)).toBe(false);
  });
});
