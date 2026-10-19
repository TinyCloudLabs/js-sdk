import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { inspectSqliteReplicaLayout, LAYOUT_FAULTS, removeSqliteReplicaLayout } from "./layout.js";

// The original v1 DDL from the store (37123c30), before either v2 migration.
const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS replica (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  replica_id TEXT NOT NULL,
  host TEXT NOT NULL,
  space TEXT NOT NULL,
  prefix TEXT NOT NULL,
  device_did TEXT NOT NULL,
  allow_secrets INTEGER NOT NULL CHECK (allow_secrets IN (0, 1)),
  local_read_policy TEXT NOT NULL CHECK (local_read_policy IN ('whileGrantValid', 'retainAfterExpiry')),
  retention_grant_cid TEXT,
  grant_cid TEXT,
  grant_bytes BLOB,
  grant_audience TEXT,
  grant_issuer TEXT,
  grant_nbf INTEGER,
  grant_exp INTEGER,
  pending_grant_cid TEXT,
  pending_grant_bytes BLOB,
  pending_grant_audience TEXT,
  pending_grant_issuer TEXT,
  pending_grant_nbf INTEGER,
  pending_grant_exp INTEGER,
  node_did TEXT,
  attested INTEGER NOT NULL DEFAULT 0 CHECK (attested IN (0, 1)),
  not_before TEXT,
  expires_at TEXT,
  retain_until TEXT,
  revoked_detail TEXT,
  purge_pending INTEGER NOT NULL DEFAULT 0 CHECK (purge_pending IN (0, 1)),
  retention_revoked TEXT,
  pending_grant_error TEXT,
  cursor TEXT,
  coverage TEXT NOT NULL CHECK (coverage IN ('empty', 'bootstrapping', 'complete')),
  generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_complete_at TEXT,
  last_error TEXT,
  last_reset TEXT,
  lease_token INTEGER NOT NULL DEFAULT 0,
  lease_holder TEXT,
  lease_expires_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS entry (
  key TEXT PRIMARY KEY,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  etag TEXT,
  hash TEXT,
  metadata TEXT NOT NULL,
  content INTEGER NOT NULL CHECK (content IN (0, 1)),
  size INTEGER,
  CHECK (
    (deleted = 1 AND etag IS NULL AND hash IS NULL AND content = 0 AND size IS NULL) OR
    (deleted = 0 AND etag IS NOT NULL AND hash IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS entry_hash ON entry (hash) WHERE hash IS NOT NULL;
`;
const GRANT_INSTALL = `CREATE TABLE IF NOT EXISTS grant_install (
  cid TEXT PRIMARY KEY,
  installed_at INTEGER NOT NULL,
  effective_expires_at INTEGER NOT NULL,
  consent_deadline INTEGER NOT NULL,
  consent_anchor_at INTEGER NOT NULL,
  consent_anchor_source TEXT NOT NULL
) STRICT, WITHOUT ROWID;`;
const POLICY_COLUMNS = [
  "grant_installed_at", "grant_effective_expires_at", "grant_consent_deadline", "grant_consent_anchor_at", "grant_consent_anchor_source",
  "pending_grant_installed_at", "pending_grant_effective_expires_at", "pending_grant_consent_deadline", "pending_grant_consent_anchor_at", "pending_grant_consent_anchor_source",
];

const dirs: string[] = [];
async function historicalMirror(version: "v1" | "grant-v2" | "policy-v2"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tc-layout-historical-"));
  dirs.push(dir);
  await mkdir(join(dir, "blobs", ".tmp"), { recursive: true });
  const db = new Database(join(dir, "replica.db"));
  try {
    db.exec(V1_SCHEMA);
    if (version === "grant-v2") db.exec(GRANT_INSTALL);
    if (version === "policy-v2") {
      for (const column of POLICY_COLUMNS) {
        db.exec(`ALTER TABLE replica ADD COLUMN ${column} ${column.endsWith("_source") ? "TEXT" : "REAL"}`);
      }
    }
    db.exec(`PRAGMA user_version = ${version === "v1" ? 1 : 2}`);
  } finally {
    db.close();
  }
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

for (const version of ["v1", "grant-v2", "policy-v2"] as const) {
  test(`recognizes the source-created ${version} schema for unapproved-free cleanup`, async () => {
    const dir = await historicalMirror(version);
    const inventory = await inspectSqliteReplicaLayout(dir);
    expect(inventory.unknownPaths).toEqual([]);
    expect(inventory.knownEntries.map((entry) => entry.path)).toContain("replica.db");
    await removeSqliteReplicaLayout(dir, {
      expectedKnown: inventory.knownEntries, expectedRoot: inventory.rootIdentity,
    });
    expect(await stat(dir).then(() => "exists", () => "gone")).toBe("gone");
  });
}

for (const [name, change] of [
  ["extra table", "CREATE TABLE outbox (value TEXT)"],
  ["extra index", "CREATE INDEX unauthorized ON replica(name)"],
  ["extra trigger", "CREATE TRIGGER unauthorized AFTER INSERT ON entry BEGIN DELETE FROM entry; END"],
  ["altered column list", "ALTER TABLE replica ADD COLUMN private_state TEXT"],
] as const) {
  test(`does not classify a source-shaped v2 database with ${name} as known`, async () => {
    const dir = await historicalMirror("grant-v2");
    const db = new Database(join(dir, "replica.db"));
    try { db.exec(change); } finally { db.close(); }
    const inventory = await inspectSqliteReplicaLayout(dir);
    expect(inventory.unknownPaths).toContain("replica.db");
    expect(inventory.unknownEntries.find((entry) => entry.path === "replica.db")?.kind).toBe("file");
    await expect(removeSqliteReplicaLayout(dir, { expectedRoot: inventory.rootIdentity }))
      .rejects.toThrow(/approval/i);
    expect((await stat(join(dir, "replica.db"))).isFile()).toBe(true);
  });
}

test("detects an outbox committed only in a live WAL snapshot", async () => {
  const dir = await historicalMirror("grant-v2");
  const path = join(dir, "replica.db");
  const db = new Database(path);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE outbox (value TEXT)");
    expect((await stat(`${path}-wal`)).size).toBeGreaterThan(0);
    const inventory = await inspectSqliteReplicaLayout(dir);
    expect(inventory.unknownPaths).toContain("replica.db");
    expect((await stat(path)).isFile()).toBe(true);
  } finally {
    db.close();
  }
});

test("named-path inspection rejects an approved symlink before removing other children", async () => {
  const dir = await historicalMirror("v1");
  const outside = await mkdtemp(join(tmpdir(), "tc-layout-outside-"));
  dirs.push(outside);
  await writeFile(join(outside, "keep"), "outside");
  await writeFile(join(dir, "other"), "local");
  await symlink(outside, join(dir, "link"), "dir");
  const approvedUnknown = await Promise.all(["other", "link"].map(async (path) => {
    const details = await lstat(join(dir, path), { bigint: true });
    return { path, kind: path === "link" ? "symlink" as const : "file" as const,
      dev: details.dev.toString(), ino: details.ino.toString() };
  }));
  const platform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    await expect(inspectSqliteReplicaLayout(dir)).rejects.toThrow(/symlink/i);
    await expect(removeSqliteReplicaLayout(dir, { approvedUnknown })).rejects.toThrow(/symlink/i);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
  }
  expect(await readFile(join(dir, "other"), "utf8")).toBe("local");
  expect(await readFile(join(outside, "keep"), "utf8")).toBe("outside");
  expect((await stat(join(dir, "replica.db"))).isFile()).toBe(true);
});

for (const change of ["directory", "file"] as const) {
  test(`named-path cleanup stops on a ${change} swap after one enumerated unlink`, async () => {
    const dir = await historicalMirror("v1");
    const outside = await mkdtemp(join(tmpdir(), "tc-layout-victim-"));
    dirs.push(outside);
    await writeFile(join(outside, "keep"), "outside");
    const shard = join(dir, "blobs", "aa");
    await mkdir(shard);
    const first = `aa${"a".repeat(62)}`;
    const second = `aa${"b".repeat(62)}`;
    await writeFile(join(shard, first), "first");
    await writeFile(join(shard, second), "second");
    const inventory = await inspectSqliteReplicaLayout(dir);
    const platform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "darwin" });
      await expect(removeSqliteReplicaLayout(dir, {
        expectedKnown: inventory.knownEntries, expectedRoot: inventory.rootIdentity,
        [LAYOUT_FAULTS]: { beforeUnlink: async (path) => {
          if (path !== `blobs/aa/${second}`) return;
          if (change === "directory") {
            await rename(shard, join(dir, "blobs", "moved"));
            await symlink(outside, shard, "dir");
          } else {
            await rename(join(shard, second), join(dir, "swapped"));
            await writeFile(join(shard, second), "replacement");
          }
        } },
      })).rejects.toThrow(/changed|Symlink/i);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
    expect(await stat(join(dir, "replica.db")).then(() => true, () => false)).toBe(true);
    expect(await stat(join(shard, first)).then(() => true, () => false)).toBe(false);
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("outside");
    if (change === "file") expect(await readFile(join(shard, second), "utf8")).toBe("replacement");
  });
}
