import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, mkdir, open, readFile, readdir, rm, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { ReplicaError, ReplicaErrorCode, isReplicaError } from "../errors.js";
import { effectiveAuthority } from "../scope.js";
import type {
  Coverage,
  GrantRecord,
  LeaseToken,
  ListOpts,
  LocalEntry,
  LocalReadPolicy,
  ReplicaConfig,
  ReplicaLastError,
  ReplicaState,
  ReplicaStatus,
  ReplicaStore,
  VerifiedPage,
} from "../types.js";
import { loadSqlite, type SqliteDatabase, type SqliteOpener, type SqlValue } from "./driver.js";

const SCHEMA_VERSION = 1;
export const DURABILITY = "sqlite-wal-synchronous-full+fsynced-blobs";

const SCHEMA = `
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

type ReplicaRow = {
  name: string;
  replica_id: string;
  host: string;
  space: string;
  prefix: string;
  device_did: string;
  allow_secrets: number;
  local_read_policy: LocalReadPolicy;
  retention_grant_cid: string | null;
  grant_cid: string | null;
  grant_bytes: Uint8Array | null;
  grant_audience: string | null;
  grant_issuer: string | null;
  grant_nbf: number | null;
  grant_exp: number | null;
  pending_grant_cid: string | null;
  pending_grant_bytes: Uint8Array | null;
  pending_grant_audience: string | null;
  pending_grant_issuer: string | null;
  pending_grant_nbf: number | null;
  pending_grant_exp: number | null;
  node_did: string | null;
  attested: number;
  not_before: string | null;
  expires_at: string | null;
  retain_until: string | null;
  revoked_detail: string | null;
  cursor: string | null;
  coverage: Coverage;
  generation: number;
  created_at: string;
  last_sync_at: string | null;
  last_complete_at: string | null;
  last_error: string | null;
  last_reset: string | null;
  lease_token: number;
  lease_holder: string | null;
  lease_expires_at: number | null;
};

type EntryRow = {
  key: string;
  deleted: number;
  etag: string | null;
  hash: string | null;
  metadata: string;
  content: number;
};

function grantOf(
  cid: string | null,
  bytes: Uint8Array | null,
  audience: string | null,
  issuer: string | null,
  nbf: number | null,
  exp: number | null,
): GrantRecord | null {
  if (cid === null || bytes === null || audience === null || issuer === null) return null;
  return { cid, bytes: new Uint8Array(bytes), audience, issuer, notBefore: nbf, expiresAt: exp };
}

function entryOf(row: EntryRow): LocalEntry {
  if (row.deleted === 1) return { key: row.key, deleted: true };
  return {
    key: row.key,
    deleted: false,
    etag: row.etag!,
    hash: row.hash!,
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    content: row.content === 1,
  };
}

function storageError(error: unknown, action: string): ReplicaError {
  if (isReplicaError(error)) return error;
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOSPC" || code === "EDQUOT" || /SQLITE_FULL|database or disk is full/i.test(`${String(code)} ${message}`)) {
    return new ReplicaError(ReplicaErrorCode.STORAGE_FULL, `${action}: the local disk is full.`, undefined, { cause: error });
  }
  return new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, `${action}: ${message}`, undefined, { cause: error });
}

const isHash = (name: string) => /^[0-9a-f]{64}$/.test(name);

/**
 * The CLI replica store: SQLite (WAL, synchronous=FULL) for entries, cursor
 * and authority, committed in one transaction per page; content-addressed
 * blob files written with fsync + link before any row references them.
 */
export class SqliteReplicaStore implements ReplicaStore {
  readonly dir: string;
  readonly #db: SqliteDatabase;
  readonly #holder = `${process.pid}-${randomBytes(6).toString("hex")}`;
  readonly #now: () => number;

  private constructor(dir: string, db: SqliteDatabase, now: () => number) {
    this.dir = dir;
    this.#db = db;
    this.#now = now;
  }

  /**
   * Open the replica store in `dir`. With `create: false` a missing replica is
   * REPLICA_NOT_FOUND and nothing is written to disk.
   */
  static async open(
    dir: string,
    options: { create: boolean; sqlite?: SqliteOpener; now?: () => number },
  ): Promise<SqliteReplicaStore> {
    const dbPath = join(dir, "replica.db");
    if (!options.create) {
      const exists = await stat(dbPath).then(
        () => true,
        () => false,
      );
      if (!exists) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, `No replica at ${dir}.`);
    }
    const opener = options.sqlite ?? (await loadSqlite());
    try {
      await mkdir(join(dir, "blobs", ".tmp"), { recursive: true, mode: 0o700 });
      await Promise.all([chmod(dir, 0o700), chmod(join(dir, "blobs"), 0o700), chmod(join(dir, "blobs", ".tmp"), 0o700)]);
      // SQLite gives -wal and -shm the database file's mode.
      const handle = await open(dbPath, fsConstants.O_CREAT | fsConstants.O_RDWR, 0o600);
      await handle.close();
      await chmod(dbPath, 0o600);
      const db = opener(dbPath);
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA secure_delete = ON");
      db.exec("PRAGMA foreign_keys = ON");
      const version = db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
      if (version > SCHEMA_VERSION) {
        db.close();
        throw new ReplicaError(
          ReplicaErrorCode.STORAGE_ERROR,
          `The replica at ${dir} was written by a newer tc (schema ${version}); upgrade tc to read it.`,
        );
      }
      if (version < SCHEMA_VERSION) {
        db.exec("BEGIN IMMEDIATE");
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        db.exec("COMMIT");
      }
      return new SqliteReplicaStore(dir, db, options.now ?? Date.now);
    } catch (error) {
      throw storageError(error, `Opening the replica at ${dir}`);
    }
  }

  #row(): ReplicaRow | undefined {
    return this.#db.get<ReplicaRow>("SELECT * FROM replica WHERE id = 1");
  }

  /** Run `body` in a write transaction (BEGIN IMMEDIATE). */
  #write<T>(action: string, body: () => T): T {
    try {
      this.#db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw storageError(error, action);
    }
    try {
      const result = body();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // The transaction is already gone.
      }
      throw storageError(error, action);
    }
  }

  /** Inside a write transaction: the caller still holds the lease. */
  #checkLease(t: LeaseToken): void {
    const row = this.#db.get<{ lease_token: number; lease_holder: string | null }>(
      "SELECT lease_token, lease_holder FROM replica WHERE id = 1",
    );
    if (row === undefined || row.lease_token !== t.token || row.lease_holder !== t.holder) {
      throw new ReplicaError(ReplicaErrorCode.BUSY, "Another process took over this replica's sync lease.");
    }
  }

  async open(): Promise<ReplicaState | null> {
    let row: ReplicaRow | undefined;
    try {
      row = this.#row();
    } catch (error) {
      throw storageError(error, "Reading the replica");
    }
    if (row === undefined) return null;
    return {
      config: {
        name: row.name,
        replicaId: row.replica_id,
        host: row.host,
        space: row.space,
        prefix: row.prefix,
        deviceDid: row.device_did,
        allowSecrets: row.allow_secrets === 1,
        localReadPolicy: row.local_read_policy,
        retentionGrantCid: row.retention_grant_cid,
      },
      grant: grantOf(row.grant_cid, row.grant_bytes, row.grant_audience, row.grant_issuer, row.grant_nbf, row.grant_exp),
      pendingGrant: grantOf(
        row.pending_grant_cid,
        row.pending_grant_bytes,
        row.pending_grant_audience,
        row.pending_grant_issuer,
        row.pending_grant_nbf,
        row.pending_grant_exp,
      ),
      nodeDid: row.node_did,
      authority: row.attested === 1 ? { notBefore: row.not_before, expiresAt: row.expires_at, retainUntil: row.retain_until } : null,
      revoked: row.revoked_detail,
      cursor: row.cursor,
      coverage: row.coverage,
      generation: row.generation,
      createdAt: row.created_at,
      lastSyncAt: row.last_sync_at,
      lastCompleteAt: row.last_complete_at,
      lastError: row.last_error === null ? null : (JSON.parse(row.last_error) as ReplicaLastError),
      lastReset: row.last_reset === null ? null : (JSON.parse(row.last_reset) as { at: string; reason: string }),
    };
  }

  async init(c: ReplicaConfig): Promise<void> {
    this.#write("Creating the replica", () => {
      if (this.#row() !== undefined) {
        throw new ReplicaError(ReplicaErrorCode.CONFIG_MISMATCH, `Replica ${c.name} already exists.`);
      }
      this.#db.run(
        `INSERT INTO replica (id, name, replica_id, host, space, prefix, device_did, allow_secrets, local_read_policy,
           retention_grant_cid, coverage, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'empty', ?)`,
        c.name,
        c.replicaId,
        c.host,
        c.space,
        c.prefix,
        c.deviceDid,
        c.allowSecrets ? 1 : 0,
        c.localReadPolicy,
        c.retentionGrantCid,
        new Date().toISOString(),
      );
    });
  }

  /** Update the retention opt-in; it takes effect at the next sync. */
  async setRetentionGrant(cid: string | null): Promise<void> {
    this.#write("Updating the retention grant", () => {
      this.#db.run(
        "UPDATE replica SET retention_grant_cid = ?, local_read_policy = ? WHERE id = 1",
        cid,
        cid === null ? "whileGrantValid" : "retainAfterExpiry",
      );
    });
  }

  async installGrant(g: GrantRecord): Promise<void> {
    this.#write("Installing the grant", () => {
      const row = this.#row();
      if (row === undefined) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, "The replica has not been created.");
      if (row.grant_cid === g.cid || row.pending_grant_cid === g.cid) return;
      this.#db.run(
        `UPDATE replica SET pending_grant_cid = ?, pending_grant_bytes = ?, pending_grant_audience = ?,
           pending_grant_issuer = ?, pending_grant_nbf = ?, pending_grant_exp = ? WHERE id = 1`,
        g.cid,
        g.bytes,
        g.audience,
        g.issuer,
        g.notBefore,
        g.expiresAt,
      );
    });
  }

  async acquireSyncLease(ttlMs: number): Promise<LeaseToken | null> {
    return this.#write("Taking the sync lease", () => {
      const row = this.#row();
      if (row === undefined) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, "The replica has not been created.");
      const now = this.#now();
      if (row.lease_holder !== null && row.lease_expires_at !== null && row.lease_expires_at > now) return null;
      const token = row.lease_token + 1;
      this.#db.run(
        "UPDATE replica SET lease_token = ?, lease_holder = ?, lease_expires_at = ? WHERE id = 1",
        token,
        this.#holder,
        now + ttlMs,
      );
      return { token, holder: this.#holder };
    });
  }

  async renewLease(t: LeaseToken, ttlMs = 120_000): Promise<void> {
    this.#write("Renewing the sync lease", () => {
      this.#checkLease(t);
      this.#db.run("UPDATE replica SET lease_expires_at = ? WHERE id = 1", this.#now() + ttlMs);
    });
  }

  async releaseLease(t: LeaseToken): Promise<void> {
    this.#write("Releasing the sync lease", () => {
      this.#db.run(
        "UPDATE replica SET lease_holder = NULL, lease_expires_at = NULL WHERE id = 1 AND lease_token = ? AND lease_holder = ?",
        t.token,
        t.holder,
      );
    });
  }

  async hasContent(hashes: string[]): Promise<Set<string>> {
    const held = new Set<string>();
    for (let start = 0; start < hashes.length; start += 500) {
      const chunk = hashes.slice(start, start + 500);
      const rows = this.#db.all<{ hash: string }>(
        `SELECT DISTINCT hash FROM entry WHERE content = 1 AND hash IN (${chunk.map(() => "?").join(",")})`,
        ...chunk,
      );
      for (const row of rows) held.add(row.hash);
    }
    return held;
  }

  #blobPath(hash: string): string {
    return join(this.dir, "blobs", hash.slice(0, 2), hash);
  }

  /**
   * Make every blob durable before any row references it: write to a fresh
   * temp file (O_EXCL, 0600), fsync, link to its content address (an existing
   * blob wins), unlink the temp, then fsync each touched directory once.
   */
  async #writeBlobs(blobs: Map<string, Uint8Array>): Promise<void> {
    const dirs = new Set<string>();
    for (const [hash, bytes] of blobs) {
      const final = this.#blobPath(hash);
      const exists = await stat(final).then(
        () => true,
        () => false,
      );
      if (exists) continue;
      const shard = join(this.dir, "blobs", hash.slice(0, 2));
      await mkdir(shard, { recursive: true, mode: 0o700 });
      const temp = join(this.dir, "blobs", ".tmp", `${hash}.${randomBytes(6).toString("hex")}`);
      const handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temp, final);
      } catch (error) {
        if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      } finally {
        await unlink(temp);
      }
      dirs.add(shard);
      dirs.add(join(this.dir, "blobs"));
    }
    for (const dir of dirs) {
      const handle = await open(dir, fsConstants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }

  async applyPage(t: LeaseToken, p: VerifiedPage): Promise<void> {
    try {
      await this.#writeBlobs(p.blobs);
    } catch (error) {
      throw storageError(error, "Writing replica content");
    }
    this.#write("Committing a sync page", () => {
      this.#checkLease(t);
      for (const change of p.changes) {
        if (change.deleted) {
          this.#db.run(
            `INSERT INTO entry (key, deleted, etag, hash, metadata, content, size) VALUES (?, 1, NULL, NULL, '{}', 0, NULL)
             ON CONFLICT (key) DO UPDATE SET deleted = 1, etag = NULL, hash = NULL, metadata = '{}', content = 0, size = NULL`,
            change.key,
          );
          continue;
        }
        let size: number | null = null;
        if (change.content) {
          const bytes = p.blobs.get(change.hash);
          size =
            bytes?.length ??
            this.#db.get<{ size: number | null }>(
              "SELECT size FROM entry WHERE hash = ? AND content = 1 AND size IS NOT NULL LIMIT 1",
              change.hash,
            )?.size ??
            null;
          if (bytes === undefined && size === null) {
            throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, `No stored content backs ${JSON.stringify(change.key)}.`);
          }
        }
        this.#db.run(
          `INSERT INTO entry (key, deleted, etag, hash, metadata, content, size) VALUES (?, 0, ?, ?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET deleted = 0, etag = excluded.etag, hash = excluded.hash,
             metadata = excluded.metadata, content = excluded.content, size = excluded.size`,
          change.key,
          change.etag,
          change.hash,
          JSON.stringify(change.metadata),
          change.content ? 1 : 0,
          size,
        );
      }
      const sets: string[] = ["cursor = ?", "coverage = ?"];
      const params: SqlValue[] = [p.cursor, p.coverage];
      if (p.authority !== null) {
        sets.push("node_did = ?", "attested = 1", "not_before = ?", "expires_at = ?", "retain_until = ?", "last_sync_at = ?");
        params.push(p.source.nodeDid, p.authority.notBefore, p.authority.expiresAt, p.authority.retainUntil, p.at);
      }
      if (p.complete) {
        sets.push("last_complete_at = ?", "last_error = NULL");
        params.push(p.at);
      }
      if (p.promoteGrant) {
        sets.push(
          "grant_cid = pending_grant_cid",
          "grant_bytes = pending_grant_bytes",
          "grant_audience = pending_grant_audience",
          "grant_issuer = pending_grant_issuer",
          "grant_nbf = pending_grant_nbf",
          "grant_exp = pending_grant_exp",
          "pending_grant_cid = NULL",
          "pending_grant_bytes = NULL",
          "pending_grant_audience = NULL",
          "pending_grant_issuer = NULL",
          "pending_grant_nbf = NULL",
          "pending_grant_exp = NULL",
        );
      }
      this.#db.run(`UPDATE replica SET ${sets.join(", ")} WHERE id = 1`, ...params);
    });
  }

  async #unlinkBlobs(keep: Set<string>): Promise<number> {
    let removed = 0;
    const root = join(this.dir, "blobs");
    for (const shard of await readdir(root).catch(() => [] as string[])) {
      const shardPath = join(root, shard);
      if (shard === ".tmp") {
        for (const name of await readdir(shardPath).catch(() => [] as string[])) {
          await rm(join(shardPath, name), { force: true });
          removed += 1;
        }
        continue;
      }
      let kept = 0;
      for (const name of await readdir(shardPath).catch(() => [] as string[])) {
        if (isHash(name) && keep.has(name)) {
          kept += 1;
          continue;
        }
        await rm(join(shardPath, name), { force: true });
        removed += 1;
      }
      if (kept === 0) await rmdir(shardPath).catch(() => undefined);
    }
    return removed;
  }

  async collectGarbage(t: LeaseToken): Promise<number> {
    // The write lock is held across the unlinks, and the lease token is
    // checked under it: a paused former holder can never unlink a blob the
    // current holder just committed a reference to.
    try {
      this.#db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw storageError(error, "Collecting unused content");
    }
    try {
      this.#checkLease(t);
      const keep = new Set(
        this.#db.all<{ hash: string }>("SELECT DISTINCT hash FROM entry WHERE content = 1").map((row) => row.hash),
      );
      const removed = await this.#unlinkBlobs(keep);
      this.#db.exec("COMMIT");
      return removed;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw storageError(error, "Collecting unused content");
    }
  }

  async reset(t: LeaseToken, reason: string): Promise<void> {
    this.#write("Resetting the replica", () => {
      this.#checkLease(t);
      this.#db.run("DELETE FROM entry");
      this.#db.run(
        `UPDATE replica SET cursor = NULL, node_did = NULL, coverage = 'empty', last_sync_at = NULL,
           last_complete_at = NULL, last_error = NULL, last_reset = ?, generation = generation + 1 WHERE id = 1`,
        JSON.stringify({ at: new Date().toISOString(), reason }),
      );
    });
    await this.collectGarbage(t);
    this.#checkpoint();
  }

  /** Truncate the WAL so purged pages do not linger in it. */
  #checkpoint(): void {
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      throw storageError(error, "Checkpointing the replica");
    }
  }

  async markRevoked(detail: string): Promise<void> {
    this.#write("Recording the revocation", () => {
      this.#db.run("DELETE FROM entry");
      this.#db.run(
        `UPDATE replica SET revoked_detail = ?, cursor = NULL, coverage = 'empty', last_error = ? WHERE id = 1`,
        detail,
        JSON.stringify({ at: new Date().toISOString(), code: ReplicaErrorCode.GRANT_REVOKED, message: detail }),
      );
    });
    // Revocation blocks every later sync, so no writer can need these blobs.
    try {
      await this.#unlinkBlobs(new Set());
    } catch (error) {
      throw storageError(error, "Purging revoked content");
    }
    this.#checkpoint();
  }

  async recordError(e: ReplicaLastError): Promise<void> {
    this.#write("Recording the sync error", () => {
      this.#db.run("UPDATE replica SET last_error = ? WHERE id = 1", JSON.stringify(e));
    });
  }

  async get(key: string): Promise<LocalEntry | undefined> {
    try {
      const row = this.#db.get<EntryRow>("SELECT key, deleted, etag, hash, metadata, content FROM entry WHERE key = ?", key);
      return row === undefined ? undefined : entryOf(row);
    } catch (error) {
      throw storageError(error, "Reading the replica");
    }
  }

  async list(o: ListOpts): Promise<LocalEntry[]> {
    const where = ["deleted = 0"];
    const params: SqlValue[] = [];
    if (o.prefix !== undefined && o.prefix !== "") {
      where.push("key >= ?", "substr(key, 1, length(?)) = ?");
      params.push(o.prefix, o.prefix, o.prefix);
    }
    if (o.after !== undefined) {
      where.push("key > ?");
      params.push(o.after);
    }
    params.push(o.limit ?? -1);
    try {
      return this.#db
        .all<EntryRow>(
          `SELECT key, deleted, etag, hash, metadata, content FROM entry WHERE ${where.join(" AND ")} ORDER BY key LIMIT ?`,
          ...params,
        )
        .map(entryOf);
    } catch (error) {
      throw storageError(error, "Listing the replica");
    }
  }

  async pendingRepairs(limit: number): Promise<Array<Extract<LocalEntry, { deleted: false }>>> {
    return this.#db
      .all<EntryRow>(
        "SELECT key, deleted, etag, hash, metadata, content FROM entry WHERE deleted = 0 AND content = 0 ORDER BY key LIMIT ?",
        limit,
      )
      .map(entryOf) as Array<Extract<LocalEntry, { deleted: false }>>;
  }

  async readContent(hash: string): Promise<Uint8Array | undefined> {
    if (!isHash(hash)) return undefined;
    try {
      return new Uint8Array(await readFile(this.#blobPath(hash)));
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return undefined;
      throw storageError(error, "Reading replica content");
    }
  }

  async status(now = this.#now()): Promise<ReplicaStatus> {
    const state = await this.open();
    if (state === null) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, "The replica has not been created.");
    const row = this.#row()!;
    const counts = this.#db.get<{ keys: number; missing: number; tombstones: number; bytes: number }>(
      `SELECT
         COALESCE(SUM(deleted = 0), 0) AS keys,
         COALESCE(SUM(deleted = 0 AND content = 0), 0) AS missing,
         COALESCE(SUM(deleted = 1), 0) AS tombstones,
         COALESCE(SUM(CASE WHEN deleted = 0 AND content = 1 THEN size ELSE 0 END), 0) AS bytes
       FROM entry`,
    )!;
    const authority = effectiveAuthority({
      window: state.authority,
      grant: state.grant,
      revoked: state.revoked,
      policy: state.config.localReadPolicy,
      now,
    });
    return {
      name: state.config.name,
      replicaId: state.config.replicaId,
      source: { host: state.config.host, nodeDid: state.nodeDid, space: state.config.space, prefix: state.config.prefix },
      device: {
        did: state.config.deviceDid,
        delegationCid: state.grant?.cid ?? null,
        pendingDelegationCid: state.pendingGrant?.cid ?? null,
      },
      authority: {
        ...authority,
        localReadPolicy: state.config.localReadPolicy,
        retentionGrantCid: state.config.retentionGrantCid,
        revokedDetail: state.revoked,
      },
      consistency: "observed",
      coverage: state.coverage,
      lastSyncAt: state.lastSyncAt,
      lastCompleteAt: state.lastCompleteAt,
      counts: { keys: Number(counts.keys), contentMissing: Number(counts.missing), tombstones: Number(counts.tombstones) },
      bytes: Number(counts.bytes),
      durability: DURABILITY,
      syncing: row.lease_holder !== null && row.lease_expires_at !== null && row.lease_expires_at > now,
      lastError: state.lastError,
      lastReset: state.lastReset,
    };
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
