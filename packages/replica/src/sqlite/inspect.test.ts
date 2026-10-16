import { linkSync, renameSync, symlinkSync } from "node:fs";
import { chmod, mkdtemp, readdir, readlink, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { FAULTS, SqliteReplicaStore } from "./store.js";
import { loadSqlite } from "./driver.js";
import { config, deviceGrant } from "../../test/fixtures.js";

const dirs: string[] = [];
async function makeStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tc-replica-inspect-"));
  dirs.push(dir);
  const store = await SqliteReplicaStore.open(dir, { create: true });
  await store.init(config());
  await store.installGrant(deviceGrant());
  await store.close();
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function databaseDescriptors(): Promise<string[]> {
  const fds = await readdir("/proc/self/fd");
  const links = await Promise.all(fds.map(async (fd) => readlink(`/proc/self/fd/${fd}`).catch(() => "")));
  return links.filter((link) => /\/replica\.db(?:-wal|-shm)?$/.test(link));
}


test("opening a symlinked replica.db refuses before changing the victim lease", async () => {
  const selected = await makeStore();
  const victim = await makeStore();
  const selectedDb = join(selected, "replica.db");
  const victimDb = join(victim, "replica.db");
  const before = await SqliteReplicaStore.inspect(victim);
  await rm(selectedDb);
  await symlink(victimDb, selectedDb);

  await expect(SqliteReplicaStore.open(selected, { create: false })).rejects.toMatchObject({ code: "REPLICA_NOT_FOUND" });
  expect((await SqliteReplicaStore.inspect(victim))?.status).toEqual(before?.status);
});

test("100 simultaneous create opens use the same database over four rounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-replica-open-race-"));
  dirs.push(root);
  const dir = join(root, "replica");
  for (let round = 0; round < 4; round++) {
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => SqliteReplicaStore.open(dir, { create: true })));
    try {
      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    } finally {
      await Promise.all(results.map((result) => result.status === "fulfilled" ? result.value.close() : undefined));
    }
  }
  expect((await stat(join(dir, "replica.db"))).isFile()).toBe(true);
});

test("concurrent prefixes do not confuse SQLite descriptor identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc-replica-prefix-opens-"));
  dirs.push(root);
  const paths = Array.from({ length: 4 }, (_, index) => join(root, `prefix-${index}`));
  const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) =>
    SqliteReplicaStore.open(paths[index % paths.length]!, { create: true })));
  try {
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    for (const path of paths) expect((await stat(join(path, "replica.db"))).isFile()).toBe(true);
  } finally {
    await Promise.all(results.map((result) => result.status === "fulfilled" ? result.value.close() : undefined));
  }
});

test("a regular replica.db swapped for another real database during open is rejected", async () => {
  const selected = await makeStore();
  const victim = await makeStore();
  const selectedDb = join(selected, "replica.db");
  const victimDb = join(victim, "replica.db");
  const before = await SqliteReplicaStore.inspect(victim);
  const opener = await loadSqlite();
  await expect(SqliteReplicaStore.open(selected, {
    create: false,
    sqlite: (path) => {
      renameSync(selectedDb, `${selectedDb}.original`);
      linkSync(victimDb, selectedDb);
      return opener(path);
    },
  })).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  expect((await SqliteReplicaStore.inspect(victim))?.status).toEqual(before?.status);
});

test("a replica.db replaced during the native opener is rejected before SQL executes", async () => {
  const selected = await makeStore();
  const victim = await makeStore();
  const selectedDb = join(selected, "replica.db");
  const victimDb = join(victim, "replica.db");
  const opener = await loadSqlite();
  let executed = false;
  await expect(SqliteReplicaStore.open(selected, {
    create: false,
    sqlite: (path) => {
      renameSync(selectedDb, `${selectedDb}.original`);
      symlinkSync(victimDb, selectedDb);
      const database = opener(path);
      return { ...database, exec: () => { executed = true; throw Error("SQL reached replaced database"); } };
    },
  })).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  expect(executed).toBe(false);
});
describe("SQLite status inspection lifecycle", () => {
  test("inspection of an existing database may create only SQLite sidecars", async () => {
    const dir = await makeStore();
    expect(await SqliteReplicaStore.inspect(dir)).not.toBeNull();
    const entries = await readdir(dir);
    expect(entries).toContain("blobs");
    expect(entries).toContain("replica.db");
    expect(entries.every((entry) => ["blobs", "replica.db", "replica.db-shm", "replica.db-wal"].includes(entry))).toBe(true);
  });

  test("a committed revocation in the WAL survives a missing shm sidecar after a crash", async () => {
    const dir = await makeStore();
    const storeUrl = new URL("./store.ts", import.meta.url).href;
    const script = `const { SqliteReplicaStore, FAULTS } = await import(${JSON.stringify(storeUrl)}); const store = await SqliteReplicaStore.open(process.argv[1], { create: false, [FAULTS]: { afterPurgeMark() { throw Error("simulated crash"); } } }); try { await store.markRevoked("delegation-revoked"); } catch {} process.exit(0);`;
    const child = Bun.spawn([process.execPath, "-e", script, dir], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect((await stat(join(dir, "replica.db-wal"))).size).toBeGreaterThan(0);
    await rm(join(dir, "replica.db-shm"), { force: true });

    const inspected = await SqliteReplicaStore.inspect(dir);
    expect(inspected?.status.authority.state).toBe("revoked");
    expect(inspected?.status.coverage).toBe("empty");
  });

  test("a committed reset in the WAL is visible without shm", async () => {
    const dir = await makeStore();
    const reset = JSON.stringify({ at: "2026-10-10T00:00:00.000Z", reason: "wal-reset" });
    const script = `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(join(dir, "replica.db"))}); db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE"); db.prepare("UPDATE replica SET last_reset = ?").run(${JSON.stringify(reset)}); db.exec("COMMIT"); process.exit(0);`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const exit = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exit, stderr).toBe(0);
    expect((await stat(join(dir, "replica.db-wal"))).size).toBeGreaterThan(0);
    await rm(join(dir, "replica.db-shm"), { force: true });

    expect((await SqliteReplicaStore.inspect(dir))?.status.lastReset?.reason).toBe("wal-reset");
  });

  test("a 0500 database directory reports unavailable instead of healthy", async () => {
    const dir = await makeStore();
    await chmod(dir, 0o500);
    try {
      await expect(SqliteReplicaStore.inspect(dir)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    } finally {
      await chmod(dir, 0o700);
    }
  });
  test("a writer revoking authority during inspection is observed or fails unavailable", async () => {
    const dir = await makeStore();
    const dbPath = join(dir, "replica.db");
    const script = `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(dbPath)}); db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE"); console.log("ready"); process.stdin.on("data", () => { db.exec("UPDATE replica SET revoked_detail = 'delegation-revoked', coverage = 'empty', purge_pending = 1 WHERE id = 1; COMMIT"); console.log("committed"); });`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const started = await reader.read();
    expect(new TextDecoder().decode(started.value)).toContain("ready");
    try {
      let inspectionSettled = false;
      const inspection = SqliteReplicaStore.inspect(dir).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ).finally(() => { inspectionSettled = true; });
      child.stdin.write("commit");
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("committed");
      const wasPendingAtCommit = !inspectionSettled;
      const result = await inspection;
      if ("value" in result && wasPendingAtCommit) expect(result.value?.status.authority.state).not.toBe("valid");
      else if ("error" in result) expect(result.error).toBeDefined();
    } finally {
      child.kill();
      await child.exited;
      reader.releaseLock();
    }
  });


  test("a live writer in another process does not block inspection", async () => {
    const dir = await makeStore();
    const dbPath = join(dir, "replica.db");
    const script = `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(dbPath)}); db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE"); console.log("ready"); process.stdin.on("data", () => { db.exec("UPDATE replica SET last_sync_at = '2026-10-10T00:00:00.000Z'; COMMIT"); console.log("committed"); });`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const started = await reader.read();
    expect(new TextDecoder().decode(started.value)).toContain("ready");
    try {
      const inspection = await Promise.race([
        SqliteReplicaStore.inspect(dir),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("inspection blocked by live writer")), 500)),
      ]);
      expect(inspection).not.toBeNull();
      child.stdin.write("commit");
      const committed = await reader.read();
      expect(new TextDecoder().decode(committed.value)).toContain("committed");
    } finally {
      child.kill();
      await child.exited;
      reader.releaseLock();
    }
    const check = await SqliteReplicaStore.inspect(dir);
    expect(check?.status.lastSyncAt).toBe("2026-10-10T00:00:00.000Z");
  });

  test("locked replicas fail inspection without blocking timers or sequential status", async () => {
    const dirsToLock = [await makeStore(), await makeStore()];
    const children = dirsToLock.map((dir) => {
      const dbPath = join(dir, "replica.db");
      const script = `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(dbPath)}); db.exec("PRAGMA journal_mode=WAL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE"); console.log("ready"); process.stdin.resume();`;
      return Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    });
    const readers = children.map((child) => child.stdout.getReader());
    try {
      for (const reader of readers) expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      const timerStarted = performance.now();
      let timerFiredAt: number | undefined;
      // This integration check measures event-loop responsiveness while real SQLite locks are held; fake timers cannot observe thread blocking.
      const timer = new Promise<void>((resolve) => setTimeout(() => {
        timerFiredAt = performance.now();
        resolve();
      }, 100));
      const statusStarted = performance.now();
      const results = await Promise.all(dirsToLock.map((dir) => SqliteReplicaStore.inspect(dir).then(
        (value) => ({ value }),
        (error) => ({ error }),
      )));
      const statusDuration = performance.now() - statusStarted;
      await timer;

      expect(statusDuration).toBeLessThan(3_000);
      expect(timerFiredAt! - timerStarted).toBeLessThan(250);
      expect(results.every((result) => "error" in result && result.error.code === "REPLICA_BUSY")).toBe(true);
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
      for (const reader of readers) reader.releaseLock();
    }
  });


  test("Bun releases database descriptors after inspection, cancellation, and repeated inspection", async () => {
    const dir = await makeStore();
    expect(await databaseDescriptors()).toEqual([]);
    const store = await SqliteReplicaStore.open(dir, { create: false });
    await store.status();
    await store.close();
    expect(await databaseDescriptors()).toEqual([]);

    expect(await SqliteReplicaStore.inspect(dir)).not.toBeNull();
    expect(await databaseDescriptors()).toEqual([]);

    const controller = new AbortController();
    const pending = SqliteReplicaStore.inspect(dir, { signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(await databaseDescriptors()).toEqual([]);

    for (let i = 0; i < 100; i++) expect(await SqliteReplicaStore.inspect(dir)).not.toBeNull();
    expect(await databaseDescriptors()).toEqual([]);
  });
});
