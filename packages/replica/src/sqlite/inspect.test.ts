import { chmod, mkdtemp, readdir, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { FAULTS, SqliteReplicaStore } from "./store.js";
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
