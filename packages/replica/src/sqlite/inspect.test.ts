import { closeSync, constants as fsConstants, linkSync, openSync, renameSync, symlinkSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Replica } from "../engine.js";

import { FAULTS, SqliteReplicaStore, type StoreFaults } from "./store.js";
import { loadSqlite } from "./driver.js";
import { config, deviceGrant, FakeNode } from "../../test/fixtures.js";

type FaultOptions = Parameters<typeof SqliteReplicaStore.open>[1] & { [FAULTS]?: StoreFaults };

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
async function makeV1Store(): Promise<string> {
  const dir = await makeStore();
  const db = new Database(join(dir, "replica.db"));
  try { db.exec("DROP TABLE grant_install; PRAGMA user_version = 1"); }
  finally { db.close(); }
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
function schemaVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try { return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version; }
  finally { db.close(); }
}

describe("SQLite gated read transaction", () => {
  test("reads the partition generation and data in one readonly transaction", async () => {
    const dir = await makeStore();
    const store = await SqliteReplicaStore.open(dir, { create: false });
    let checks = 0;
    try {
      const generation = await store.readTransaction(0, async () => { checks++; }, async (snapshot) =>
        (await snapshot.open())?.generation);
      expect(generation).toBe(0);
      expect(checks).toBe(2);
    } finally {
      await store.close();
    }
  });

  test("refuses a changed partition generation before reading", async () => {
    const dir = await makeStore();
    const store = await SqliteReplicaStore.open(dir, { create: false });
    try {
      const writer = new Database(join(dir, "replica.db"));
      writer.exec("UPDATE replica SET generation = generation + 1 WHERE id = 1");
      writer.close();
      let read = false;
      await expect(store.readTransaction(0, async () => {}, async () => { read = true; }))
        .rejects.toMatchObject({ code: "RESET_REQUIRED" });
      expect(read).toBe(false);
    } finally {
      await store.close();
    }
  });

  test("a gate denial during the snapshot refuses delivery", async () => {
    const dir = await makeStore();
    const store = await SqliteReplicaStore.open(dir, { create: false });
    let allowed = true;
    try {
      await expect(store.readTransaction(0, async () => {
        if (!allowed) throw Object.assign(new Error("Denied"), { code: "REPLICA_GATED", gate: "stamp_stale" });
      }, async (snapshot) => {
        const state = await snapshot.open();
        allowed = false;
        return state;
      })).rejects.toMatchObject({ code: "REPLICA_GATED" });
    } finally {
      await store.close();
    }
  });

  test("typed section and gate failures retain their original error and code", async () => {
    const dir = await makeStore();
    const store = await SqliteReplicaStore.open(dir, { create: false });
    const expired = Object.assign(new Error("Grant expired"), { code: "GRANT_EXPIRED" });
    const refused = Object.assign(new Error("Authority caveated"), { code: "CAVEATED_AUTHORITY" });
    try {
      await expect(store.readTransaction(0, async () => {}, async () => { throw expired; }))
        .rejects.toBe(expired);
      let checks = 0;
      await expect(store.readTransaction(0, async () => {
        if (++checks === 2) throw refused;
      }, async (snapshot) => snapshot.open())).rejects.toBe(refused);
      expect(checks).toBe(2);
    } finally {
      await store.close();
    }
  });

  test("a closed store reports CLOSED before opening a read snapshot", async () => {
    const dir = await makeStore();
    const store = await SqliteReplicaStore.open(dir, { create: false });
    await store.close();
    let called = false;
    await expect(store.readTransaction(0, async () => { called = true; }, async () => { called = true; }))
      .rejects.toMatchObject({ code: "REPLICA_CLOSED" });
    expect(called).toBe(false);
  });

  test("awaited captured-parent mutation fails immediately while its gated read section remains usable", async () => {
    const dir = await makeStore();
    const store = await SqliteReplicaStore.open(dir, { create: false });
    let mutation: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const generation = await store.readTransaction(0, async () => {}, async (snapshot) => {
        mutation = store.setRetentionGrant("must-not-write");
        const outcome = await Promise.race([
          mutation.then(() => "resolved", (error: unknown) => error),
          new Promise<string>((resolve) => { timer = setTimeout(() => resolve("timed_out"), 250); }),
        ]);
        clearTimeout(timer);
        expect(outcome).not.toBe("timed_out");
        expect(outcome).toMatchObject({
          code: "STORAGE_ERROR",
          message: "mutation attempted on the same controller while its readTransaction section is active; this would deadlock",
        });
        return (await snapshot.open())?.generation;
      });
      expect(generation).toBe(0);
      expect((await store.open())?.config.retentionGrantCid).toBeNull();
    } finally {
      clearTimeout(timer);
      if (mutation) await Promise.allSettled([mutation]);
      await store.close();
    }
  });

  test("sibling writes and an actual sync started outside a held read queue rather than receiving its deadlock error", async () => {
    const dir = await makeStore();
    const parent = await SqliteReplicaStore.open(dir, { create: false });
    const sibling = await SqliteReplicaStore.open(dir, { create: false });
    const node = new FakeNode();
    node.put("notes/a", "new");
    let entered!: () => void;
    let release!: () => void;
    const inSection = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let siblingWrite: Promise<void> | undefined;
    let syncing: ReturnType<Replica["sync"]> | undefined;
    const reading = parent.readTransaction(0, async () => {}, async (snapshot) => {
      siblingWrite = sibling.setRetentionGrant(null);
      void siblingWrite.catch(() => undefined);
      entered();
      await held;
      return (await snapshot.list({ prefix: "notes/" })).map((entry) => entry.key);
    });
    void reading.catch(() => undefined);
    try {
      await inSection;
      syncing = new Replica({ store: parent, transport: node }).sync({ limit: 2 });
      void syncing.catch(() => undefined);
      let syncSettled = false;
      void syncing.then(() => { syncSettled = true; }, () => { syncSettled = true; });
      await Promise.resolve();
      expect(syncSettled).toBe(false);
      release();
      expect(await reading).toEqual([]);
      await siblingWrite;
      expect(await syncing).toMatchObject({ changes: 1, coverage: "complete" });
      expect((await parent.list({ prefix: "notes/" })).map((entry) => entry.key)).toEqual(["notes/a"]);
    } finally {
      release();
      await Promise.allSettled([reading, siblingWrite ?? Promise.resolve(), syncing ?? Promise.resolve()]);
      await sibling.close();
      await parent.close();
    }
  });

  test("100 concurrent gated snapshots use the checked descriptor queue over four rounds", async () => {
    const dir = await makeStore();
    const store = await SqliteReplicaStore.open(dir, { create: false });
    try {
      for (let round = 0; round < 4; round++) {
        const results = await Promise.allSettled(Array.from({ length: 100 }, () =>
          store.readTransaction(0, async () => {}, async (snapshot) => (await snapshot.open())?.generation)));
        expect(results.filter((result) => result.status === "rejected")).toEqual([]);
        expect(results.every((result) => result.status === "fulfilled" && result.value === 0)).toBe(true);
      }
    } finally {
      await store.close();
    }
  }, 30_000);

  test.skipIf(process.platform !== "linux")("a gated snapshot keeps the original blob directory pinned after parent close and refuses later denial", async () => {
    const dir = await makeStore();
    const victim = await makeStore();
    const hash = "a".repeat(64);
    const original = new Uint8Array([1, 2, 3]);
    const foreign = new Uint8Array([9, 8, 7]);
    await mkdir(join(dir, "blobs", "aa"));
    await mkdir(join(victim, "blobs", "aa"));
    await writeFile(join(dir, "blobs", "aa", hash), original);
    await writeFile(join(victim, "blobs", "aa", hash), foreign);
    const store = await SqliteReplicaStore.open(dir, { create: false });
    let checks = 0;
    let moved = false;
    try {
      await expect(store.readTransaction(0, async () => {
        if (++checks === 2) throw Object.assign(new Error("Denied"), { code: "REPLICA_GATED", gate: "stamp_stale" });
      }, async (snapshot) => {
        await store.close();
        renameSync(dir, `${dir}.moved`);
        moved = true;
        await symlink(victim, dir);
        expect(await snapshot.readContent(hash)).toEqual(original);
      })).rejects.toMatchObject({ code: "REPLICA_GATED" });
      expect(checks).toBe(2);
      expect(new Uint8Array(await readFile(join(victim, "blobs", "aa", hash)))).toEqual(foreign);
    } finally {
      await store.close().catch(() => undefined);
      if (moved) {
        await unlink(dir).catch(() => undefined);
        await rm(`${dir}.moved`, { recursive: true, force: true });
      }
    }
  });

  test.skipIf(process.platform !== "linux")("a replaced replica directory cannot deliver an otherwise allowed snapshot", async () => {
    const dir = await makeStore();
    const victim = await makeStore();
    const store = await SqliteReplicaStore.open(dir, { create: false });
    let moved = false;
    try {
      await expect(store.readTransaction(0, async () => {}, async (snapshot) => {
        const state = await snapshot.open();
        renameSync(dir, `${dir}.moved`);
        moved = true;
        await symlink(victim, dir);
        return state;
      })).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    } finally {
      await store.close();
      if (moved) {
        await unlink(dir).catch(() => undefined);
        await rm(`${dir}.moved`, { recursive: true, force: true });
      }
    }
  });
});



test("a checked v1 store migrates once to v2 while inspection remains read-only", async () => {
  const dir = await makeV1Store();
  const dbPath = join(dir, "replica.db");
  expect(schemaVersion(dbPath)).toBe(1);
  expect((await SqliteReplicaStore.inspect(dir))?.state.config.name).toBe(config().name);
  expect(schemaVersion(dbPath)).toBe(1);
  const store = await SqliteReplicaStore.open(dir, { create: false });
  try {
    expect(schemaVersion(dbPath)).toBe(2);
    expect((await store.open())?.config.name).toBe(config().name);
    expect((await store.readTransaction(0, async () => {}, async (snapshot) => snapshot.open()))?.generation).toBe(0);
  } finally {
    await store.close();
  }
  const reopened = await SqliteReplicaStore.open(dir, { create: false });
  try { expect(schemaVersion(dbPath)).toBe(2); }
  finally { await reopened.close(); }
});

test("swapped and symlinked v1 databases cannot receive a schema upgrade or any bytes", async () => {
  const selected = await makeV1Store();
  const victim = await makeV1Store();
  const selectedDb = join(selected, "replica.db");
  const victimDb = join(victim, "replica.db");
  expect([schemaVersion(selectedDb), schemaVersion(victimDb)]).toEqual([1, 1]);
  const beforeSelected = await readFile(selectedDb);
  const beforeVictim = await readFile(victimDb);
  const backup = `${selectedDb}.original`;
  renameSync(selectedDb, backup);
  await symlink(victimDb, selectedDb);
  await expect(SqliteReplicaStore.open(selected, { create: false })).rejects.toMatchObject({ code: "REPLICA_NOT_FOUND" });
  await rm(selectedDb);
  renameSync(backup, selectedDb);
  const opener = await loadSqlite();
  await expect(SqliteReplicaStore.open(selected, {
    create: false,
    sqlite: (path) => {
      renameSync(selectedDb, backup);
      linkSync(victimDb, selectedDb);
      return opener(path);
    },
  })).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  expect([schemaVersion(backup), schemaVersion(victimDb)]).toEqual([1, 1]);
  expect(await readFile(backup)).toEqual(beforeSelected);
  expect(await readFile(victimDb)).toEqual(beforeVictim);
});

for (const replacement of ["symlink", "regular"] as const) {
  test(`inspection refuses a ${replacement} replica.db swap before returning victim status`, async () => {
    const selected = await makeV1Store();
    const victim = await makeV1Store();
    const selectedDb = join(selected, "replica.db");
    const victimDb = join(victim, "replica.db");
    const original = filesystem.lstat;
    const before = await readFile(victimDb);
    let swapped = false;
    const intercepted = spyOn(filesystem, "lstat").mockImplementation((async (...args: Parameters<typeof filesystem.lstat>) => {
      const result = await original(...args);
      if (!swapped && args[0] === selectedDb) {
        swapped = true;
        renameSync(selectedDb, `${selectedDb}.original`);
        if (replacement === "symlink") symlinkSync(victimDb, selectedDb);
        else linkSync(victimDb, selectedDb);
      }
      return result;
    }) as typeof filesystem.lstat);
    try {
      await expect(SqliteReplicaStore.inspect(selected)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    } finally {
      intercepted.mockRestore();
    }
    expect(swapped).toBe(true);
    expect(await readFile(victimDb)).toEqual(before);
    expect(schemaVersion(victimDb)).toBe(1);
  });
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

test("a gated read borrows the verified handle without opening another native SQLite connection", async () => {
  const dir = await makeStore();
  const opener = await loadSqlite();
  let opens = 0;
  let checks = 0;
  const store = await SqliteReplicaStore.open(dir, {
    create: false,
    sqlite: (path, options) => {
      opens++;
      return opener(path, options);
    },
  });
  try {
    expect(opens).toBe(1);
    expect(await store.readTransaction(0, async () => { checks++; }, async (snapshot) =>
      (await snapshot.open())?.generation)).toBe(0);
    expect(opens).toBe(1);
    expect(checks).toBe(2);
    await expect(store.readTransaction(0, async () => {}, async (snapshot) =>
      snapshot.setRetentionGrant("must-not-write"))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect((await store.open())?.config.retentionGrantCid).toBeNull();
  } finally {
    await store.close();
  }
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

test("concurrent controllers can open one writable replica while another remains live", async () => {
  const dir = await makeStore();
  const first = await SqliteReplicaStore.open(dir, { create: false });
  expect(await first.open()).not.toBeNull();
  let firstClosed = false;
  const results = await Promise.allSettled(Array.from({ length: 4 }, () =>
    SqliteReplicaStore.open(dir, { create: true })));
  try {
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    const stores = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(await stores[0]!.open()).not.toBeNull();
    await first.close();
    firstClosed = true;
    await expect(first.open()).rejects.toMatchObject({ code: "REPLICA_CLOSED" });
    expect((await stores[1]!.status()).coverage).toBe("empty");
    const lease = await stores[0]!.acquireSyncLease(30_000);
    expect(lease).not.toBeNull();
    expect(await stores[1]!.acquireSyncLease(30_000)).toBeNull();
    await stores[0]!.releaseLease(lease!);
  } finally {
    if (!firstClosed) await first.close();
    await Promise.all(results.map((result) => result.status === "fulfilled" ? result.value.close() : undefined));
  }
  const reopened = await SqliteReplicaStore.open(dir, { create: false });
  try {
    expect(await reopened.open()).not.toBeNull();
  } finally {
    await reopened.close();
  }
  if (process.platform === "linux") expect(await databaseDescriptors()).toEqual([]);
});

test("a queued gated read survives its controller closing but cannot enter an unfinished sibling write", async () => {
  const dir = await makeStore();
  let started!: () => void;
  let resume!: () => void;
  const inTransaction = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const writerOptions: FaultOptions = {
    create: false,
    [FAULTS]: { afterGarbageCollectionBegin: async () => { started(); await held; } },
  };
  const writer = await SqliteReplicaStore.open(dir, writerOptions);
  const reader = await SqliteReplicaStore.open(dir, { create: false });
  const lease = await writer.acquireSyncLease(30_000);
  expect(lease).not.toBeNull();
  const collecting = writer.collectGarbage(lease!);
  void collecting.catch(() => undefined);
  let reading: Promise<number | undefined> | undefined;
  try {
    await inTransaction;
    let entered = false;
    let checks = 0;
    reading = reader.readTransaction(0, async () => { checks++; }, async (snapshot) => {
      entered = true;
      return (await snapshot.open())?.generation;
    });
    void reading.catch(() => undefined);
    await reader.close();
    expect(entered).toBe(false);
    expect(checks).toBe(0);
    resume();
    expect(await collecting).toBe(0);
    expect(await reading).toBe(0);
    expect(checks).toBe(2);
    await writer.releaseLease(lease!);
  } finally {
    resume();
    await Promise.allSettled([collecting, reading ?? Promise.resolve()]);
    await reader.close();
    await writer.close();
  }
});

for (const fails of [false, true]) {
  test(`closing a controller during garbage collection ${fails ? "rolls back a failure" : "commits"} before a sibling writes`, async () => {
    const dir = await makeStore();
    let started!: () => void;
    let resume!: () => void;
    const inTransaction = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { resume = resolve; });
    const firstOptions: FaultOptions = {
      create: false,
      [FAULTS]: {
        afterGarbageCollectionBegin: async () => {
          started();
          await held;
          if (fails) throw new Error("Injected garbage collection failure");
        },
      },
    };
    const first = await SqliteReplicaStore.open(dir, firstOptions);
    const second = await SqliteReplicaStore.open(dir, { create: false });
    const lease = await first.acquireSyncLease(30_000);
    expect(lease).not.toBeNull();
    const collecting = first.collectGarbage(lease!);
    void collecting.catch(() => undefined);
    let closing: Promise<void> | undefined;
    try {
      await inTransaction;
      closing = first.close();
      let closed = false;
      void closing.then(() => { closed = true; });
      await Promise.resolve();
      const closedBeforeResume = closed;
      await expect(first.get("notes/a")).rejects.toMatchObject({ code: "REPLICA_CLOSED" });
      await expect(first.renewLease(lease!, 30_000)).rejects.toMatchObject({ code: "REPLICA_CLOSED" });
      resume();
      await second.renewLease(lease!, 30_000);
      if (fails) await expect(collecting).rejects.toMatchObject({ code: "STORAGE_ERROR" });
      else expect(await collecting).toBe(0);
      await closing;
      expect(closedBeforeResume).toBe(false);
      await second.releaseLease(lease!);
    } finally {
      resume();
      await Promise.allSettled([collecting, closing ?? Promise.resolve()]);
      await first.close();
      await second.close();
    }
  });
}

test.skipIf(process.platform !== "linux")("a sibling pinned path retains the same replica after its first controller closes", async () => {
  const dir = await makeStore();
  const first = await SqliteReplicaStore.open(dir, { create: false });
  const parentFd = openSync(dirname(dir), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  let firstClosed = false;
  let sibling: SqliteReplicaStore | undefined;
  try {
    sibling = await SqliteReplicaStore.open(`/proc/self/fd/${parentFd}/${basename(dir)}`, { create: false });
    await first.close();
    firstClosed = true;
    expect((await sibling.open())?.config.name).toBe("notes");
  } finally {
    await sibling?.close();
    if (!firstClosed) await first.close();
    closeSync(parentFd);
  }
});

test("a live writable controller cannot authorize a replaced database", async () => {
  const selected = await makeStore();
  const victim = await makeStore();
  const selectedDb = join(selected, "replica.db");
  const victimDb = join(victim, "replica.db");
  const victimBefore = await readFile(victimDb);
  const first = await SqliteReplicaStore.open(selected, { create: false });
  try {
    renameSync(selectedDb, `${selectedDb}.original`);
    linkSync(victimDb, selectedDb);
    await expect(SqliteReplicaStore.open(selected, { create: false }).then(async (store) => {
      await store.close();
    })).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(await readFile(victimDb)).toEqual(victimBefore);
  } finally {
    await first.close();
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
