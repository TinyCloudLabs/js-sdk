import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";

import { ReplicaError, ReplicaErrorCode, isReplicaError } from "./errors.js";
import { assertReadable, effectiveAuthority, hashFromEtag, kvPrefixCovers } from "./scope.js";
import type {
  AuthorityState,
  Coverage,
  FetchedContent,
  LeaseToken,
  ListOpts,
  LocalEntry,
  ReplicaState,
  ReplicaStatus,
  ReplicaStore,
  ReplicaTransport,
  SyncPage,
  VerifiedChange,
} from "./types.js";

/** Metadata every local read carries: the replica reports observed state, never finality. */
export type ReadMeta = {
  consistency: "observed";
  source: { host: string; nodeDid: string | null; space: string; prefix: string };
  asOf: string | null;
  coverage: Coverage;
  /** `expired` while reads continue under a node-attested retention. */
  authority: AuthorityState;
};

export type ReplicaReadResult =
  | { status: "present"; key: string; value: Uint8Array; etag: string; metadata: Record<string, string>; meta: ReadMeta }
  | { status: "content_missing"; key: string; etag: string; metadata: Record<string, string>; meta: ReadMeta }
  | { status: "deleted" | "absent"; key: string; meta: ReadMeta }
  | { status: "coverage_incomplete" | "not_covered"; key: string; meta: ReadMeta };

export type ReplicaListEntry = { key: string; etag: string; metadata: Record<string, string>; content: boolean };

export type ReplicaListResult = { entries: ReplicaListEntry[]; meta: ReadMeta };

export type SyncReport = {
  pages: number;
  changes: number;
  deleted: number;
  fetched: number;
  contentMissing: number;
  repaired: number;
  resets: number;
  coverage: Coverage;
  cursorAdvanced: boolean;
  promotedGrant: boolean;
  blobsCollected: number;
};

export type ReplicaOptions = {
  store: ReplicaStore;
  transport?: ReplicaTransport;
  now?: () => number;
  leaseTtlMs?: number;
};

const DEFAULT_PAGE_LIMIT = 500;
const DEFAULT_LEASE_TTL_MS = 120_000;
const FETCH_CHUNK = 100;
const REPAIR_BATCH = 100;

/** `"blake3-" + hex(blake3(bytes))`, the strong ETag the node attests for content. */
export function contentHash(bytes: Uint8Array): string {
  return bytesToHex(blake3(bytes));
}

function sameEtag(a: string, b: string): boolean {
  return a.replace(/^"|"$/g, "") === b.replace(/^"|"$/g, "");
}

/**
 * A durable, read-only local replica of one KV prefix. Reads never touch the
 * network; `sync` pulls `tinycloud.kv/sync` pages, verifies every byte
 * against the node-attested ETag, and commits each page with its cursor.
 */
export class Replica {
  readonly #store: ReplicaStore;
  readonly #transport: ReplicaTransport | undefined;
  readonly #now: () => number;
  readonly #leaseTtlMs: number;

  constructor(options: ReplicaOptions) {
    this.#store = options.store;
    this.#transport = options.transport;
    this.#now = options.now ?? Date.now;
    this.#leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  async #state(): Promise<ReplicaState> {
    const state = await this.#store.open();
    if (state === null) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, "The replica has not been created.");
    return state;
  }

  /** Throws unless local reads are allowed now; returns the meta every read reports. */
  #readMeta(state: ReplicaState): ReadMeta {
    const now = this.#now();
    const authority = assertReadable(
      effectiveAuthority({
        window: state.authority,
        grant: state.grant,
        revoked: state.revoked,
        policy: state.config.localReadPolicy,
        now,
      }),
      now,
    );
    return {
      consistency: "observed",
      source: { host: state.config.host, nodeDid: state.nodeDid, space: state.config.space, prefix: state.config.prefix },
      asOf: state.lastSyncAt,
      coverage: state.coverage,
      authority,
    };
  }

  async get(key: string, options: { verify?: boolean } = {}): Promise<ReplicaReadResult> {
    const state = await this.#state();
    const meta = this.#readMeta(state);
    if (!kvPrefixCovers(state.config.prefix, key)) return { status: "not_covered", key, meta };
    const entry = await this.#store.get(key);
    if (entry === undefined) {
      return { status: state.coverage === "complete" ? "absent" : "coverage_incomplete", key, meta };
    }
    if (entry.deleted) return { status: "deleted", key, meta };
    if (!entry.content) {
      return { status: "content_missing", key, etag: entry.etag, metadata: entry.metadata, meta };
    }
    const value = await this.#store.readContent(entry.hash);
    if (value === undefined) {
      throw new ReplicaError(ReplicaErrorCode.INTEGRITY_ERROR, `The stored content for ${JSON.stringify(key)} is missing.`, { key });
    }
    if (options.verify !== false && contentHash(value) !== entry.hash) {
      throw new ReplicaError(ReplicaErrorCode.INTEGRITY_ERROR, `The stored content for ${JSON.stringify(key)} does not match its hash.`, { key });
    }
    return { status: "present", key, value, etag: entry.etag, metadata: entry.metadata, meta };
  }

  /** Live keys under `prefix` (a plain string prefix within the replica's scope). */
  async list(options: ListOpts = {}): Promise<ReplicaListResult> {
    const state = await this.#state();
    const meta = this.#readMeta(state);
    const scope = state.config.prefix;
    const prefix = options.prefix ?? "";
    if (prefix !== "" && !scope.startsWith(prefix) && !kvPrefixCovers(scope, prefix)) {
      throw new ReplicaError(
        ReplicaErrorCode.NOT_COVERED,
        `${JSON.stringify(prefix)} is outside the replica's prefix ${JSON.stringify(scope)}.`,
      );
    }
    const rows = await this.#store.list(options);
    const entries: ReplicaListEntry[] = [];
    for (const row of rows) {
      if (row.deleted) continue;
      entries.push({ key: row.key, etag: row.etag, metadata: row.metadata, content: row.content });
    }
    return { entries, meta };
  }

  async status(): Promise<ReplicaStatus> {
    await this.#state();
    return this.#store.status(this.#now());
  }

  /** Clear entries, blobs, cursor and the source pin; keep the configuration and grant. */
  async reset(reason: string): Promise<void> {
    await this.#state();
    const lease = await this.#store.acquireSyncLease(this.#leaseTtlMs);
    if (lease === null) throw new ReplicaError(ReplicaErrorCode.BUSY, "Another process is syncing this replica.");
    try {
      await this.#store.reset(lease, reason);
    } finally {
      await this.#store.releaseLease(lease);
    }
  }

  async sync(options: { limit?: number; signal?: AbortSignal } = {}): Promise<SyncReport> {
    const transport = this.#transport;
    if (transport === undefined) throw new Error("Replica.sync needs a transport");
    const state = await this.#state();
    if (state.revoked !== null) {
      throw new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, `The replica's grant was revoked: ${state.revoked}`);
    }
    const grant = state.pendingGrant ?? state.grant;
    if (grant === null) throw new ReplicaError(ReplicaErrorCode.GRANT_MISSING, "No grant is installed for this replica.");
    // A replacement grant is judged on its own leaf window until the node attests it.
    this.#assertSyncWindow(state.pendingGrant === null ? state.authority : null, grant, state);

    const lease = await this.#store.acquireSyncLease(this.#leaseTtlMs);
    if (lease === null) throw new ReplicaError(ReplicaErrorCode.BUSY, "Another process is syncing this replica.");
    try {
      const report = await this.#syncUnderLease(lease, state, grant, transport, options);
      return report;
    } catch (error) {
      if (!isReplicaError(error, ReplicaErrorCode.GRANT_REVOKED)) {
        await this.#store
          .recordError({
            at: new Date(this.#now()).toISOString(),
            code: isReplicaError(error) ? error.code : "ERROR",
            message: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      await this.#store.releaseLease(lease).catch(() => undefined);
    }
  }

  #assertSyncWindow(window: ReplicaState["authority"], grant: ReplicaState["grant"], state: ReplicaState): void {
    const authority = effectiveAuthority({
      window,
      grant,
      revoked: null,
      policy: "whileGrantValid",
      now: this.#now(),
    });
    if (authority.state === "valid") return;
    // No new sync happens after expiry, even under retention.
    assertReadable({ ...authority, retainUntil: null }, this.#now());
    void state;
  }

  async #syncUnderLease(
    lease: LeaseToken,
    state: ReplicaState,
    grant: NonNullable<ReplicaState["grant"]>,
    transport: ReplicaTransport,
    options: { limit?: number; signal?: AbortSignal },
  ): Promise<SyncReport> {
    const { config } = state;
    const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
    const report: SyncReport = {
      pages: 0,
      changes: 0,
      deleted: 0,
      fetched: 0,
      contentMissing: 0,
      repaired: 0,
      resets: 0,
      coverage: state.coverage,
      cursorAdvanced: false,
      promotedGrant: false,
      blobsCollected: 0,
    };
    let cursor = state.cursor;
    let nodeDid = state.nodeDid;
    let coverage = state.coverage;
    let promote = state.pendingGrant !== null;

    for (;;) {
      let page: SyncPage;
      try {
        page = await transport.syncPage({
          prefix: config.prefix,
          ...(cursor === null ? {} : { cursor }),
          limit,
          ...(config.retentionGrantCid === null ? {} : { retentionGrant: config.retentionGrantCid }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        if (isReplicaError(error, ReplicaErrorCode.RESET_REQUIRED) && report.resets === 0) {
          const reason = typeof error.detail?.reason === "string" ? error.detail.reason : "reset-required";
          await this.#store.reset(lease, `node: ${reason}`);
          report.resets += 1;
          cursor = null;
          nodeDid = null;
          coverage = "empty";
          continue;
        }
        if (isReplicaError(error, ReplicaErrorCode.GRANT_REVOKED)) {
          // Persisted before the error returns: later reads raise GRANT_REVOKED, also after restart.
          await this.#store.markRevoked(error.message);
        }
        throw error;
      }

      this.#checkPage(page, config.space, config.prefix, nodeDid);
      // Every page commit checks the window the node just attested.
      this.#assertSyncWindow(page.authority, grant, state);

      const verified = await this.#verify(page, transport, options.signal);
      coverage = page.more ? (coverage === "complete" ? "complete" : "bootstrapping") : "complete";
      await this.#store.applyPage(lease, {
        changes: verified.changes,
        blobs: verified.blobs,
        cursor: page.cursor,
        source: page.source,
        authority: page.authority,
        coverage,
        at: new Date(this.#now()).toISOString(),
        complete: !page.more,
        promoteGrant: promote,
      });
      report.promotedGrant ||= promote;
      promote = false;
      report.pages += 1;
      report.changes += page.changes.length;
      report.deleted += page.changes.filter((change) => change.deleted).length;
      report.fetched += verified.fetched;
      if (page.cursor !== cursor) report.cursorAdvanced = true;
      cursor = page.cursor;
      nodeDid = page.source.nodeDid;
      await this.#store.renewLease(lease);
      if (!page.more) break;
    }

    report.repaired = await this.#repair(lease, transport, cursor, nodeDid, coverage, state, options.signal);
    report.blobsCollected = await this.#store.collectGarbage(lease);
    report.coverage = coverage;
    report.contentMissing = (await this.#store.pendingRepairs(Number.MAX_SAFE_INTEGER)).length;
    return report;
  }

  #checkPage(page: SyncPage, space: string, prefix: string, pinnedNodeDid: string | null): void {
    if (page.source.space !== space || page.source.prefix !== prefix) {
      throw new ReplicaError(
        ReplicaErrorCode.PROTOCOL_ERROR,
        `The node answered for ${page.source.space}/${page.source.prefix}, not ${space}/${prefix}.`,
      );
    }
    if (pinnedNodeDid !== null && page.source.nodeDid !== pinnedNodeDid) {
      throw new ReplicaError(
        ReplicaErrorCode.SOURCE_CHANGED,
        `The feed now comes from ${page.source.nodeDid}, not the pinned source ${pinnedNodeDid}. Reset the replica to follow a new source.`,
        { pinned: pinnedNodeDid, received: page.source.nodeDid },
      );
    }
    for (const change of page.changes) {
      if (!kvPrefixCovers(prefix, change.key)) {
        throw new ReplicaError(
          ReplicaErrorCode.SCOPE_VIOLATION,
          `The feed delivered ${JSON.stringify(change.key)}, outside the prefix ${JSON.stringify(prefix)}.`,
          { key: change.key },
        );
      }
    }
  }

  async #verify(
    page: SyncPage,
    transport: ReplicaTransport,
    signal: AbortSignal | undefined,
  ): Promise<{ changes: VerifiedChange[]; blobs: Map<string, Uint8Array>; fetched: number }> {
    const blobs = new Map<string, Uint8Array>();
    const changes: VerifiedChange[] = [];
    const candidates: Array<{ index: number; key: string; etag: string; hash: string }> = [];

    for (const change of page.changes) {
      if (change.deleted) {
        changes.push({ key: change.key, deleted: true });
        continue;
      }
      const hash = hashFromEtag(change.etag);
      if (hash === undefined) {
        throw new ReplicaError(ReplicaErrorCode.PROTOCOL_ERROR, `The feed sent an ETag that is not blake3: ${change.etag}`, {
          key: change.key,
        });
      }
      const previous = await this.#store.get(change.key);
      // A metadata-only change moves position without changing the ETag.
      const unchanged = previous !== undefined && !previous.deleted && previous.etag === change.etag && previous.content;
      changes.push({ key: change.key, deleted: false, etag: change.etag, hash, metadata: change.metadata, content: unchanged });
      if (!unchanged) candidates.push({ index: changes.length - 1, key: change.key, etag: change.etag, hash });
    }

    const held = await this.#store.hasContent([...new Set(candidates.map((candidate) => candidate.hash))]);
    const needed = candidates.filter((candidate) => {
      if (!held.has(candidate.hash)) return true;
      (changes[candidate.index] as Extract<VerifiedChange, { deleted: false }>).content = true;
      return false;
    });

    let fetched = 0;
    for (let start = 0; start < needed.length; start += FETCH_CHUNK) {
      const chunk = needed.slice(start, start + FETCH_CHUNK);
      const contents = await transport.fetchContent(
        chunk.map((candidate) => candidate.key),
        signal === undefined ? undefined : { signal },
      );
      for (const candidate of chunk) {
        const ok = acceptContent(candidate, contents.get(candidate.key));
        if (ok === undefined) continue; // stale or gone: commit with content=0, repaired later
        blobs.set(candidate.hash, ok);
        (changes[candidate.index] as Extract<VerifiedChange, { deleted: false }>).content = true;
        fetched += 1;
      }
    }
    return { changes, blobs, fetched };
  }

  async #repair(
    lease: LeaseToken,
    transport: ReplicaTransport,
    cursor: string | null,
    nodeDid: string | null,
    coverage: Coverage,
    state: ReplicaState,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    const pending = await this.#store.pendingRepairs(Number.MAX_SAFE_INTEGER);
    let repaired = 0;
    for (let start = 0; start < pending.length; start += REPAIR_BATCH) {
      const chunk = pending.slice(start, start + REPAIR_BATCH);
      const contents = await transport.fetchContent(
        chunk.map((entry) => entry.key),
        signal === undefined ? undefined : { signal },
      );
      const blobs = new Map<string, Uint8Array>();
      const changes: VerifiedChange[] = [];
      for (const entry of chunk) {
        const bytes = acceptContent(entry, contents.get(entry.key));
        if (bytes === undefined) continue;
        blobs.set(entry.hash, bytes);
        changes.push({ ...entry, content: true });
      }
      if (changes.length === 0) continue;
      await this.#store.applyPage(lease, {
        changes,
        blobs,
        cursor,
        source: { nodeDid: nodeDid ?? "", space: state.config.space, prefix: state.config.prefix },
        authority: null,
        coverage,
        at: new Date(this.#now()).toISOString(),
        complete: false,
        promoteGrant: false,
      });
      repaired += changes.length;
    }
    return repaired;
  }
}

/**
 * Accept bytes only if they hash to the change row's ETag. A fetch that saw a
 * newer ETag (or none) is stale, not an attack: the next feed page carries
 * the newer state. Bytes that claim the attested ETag but hash differently are.
 */
function acceptContent(
  expected: { key: string; etag: string; hash: string },
  fetched: FetchedContent | undefined,
): Uint8Array | undefined {
  if (fetched === undefined || "missing" in fetched) return undefined;
  if (contentHash(fetched.bytes) === expected.hash) return fetched.bytes;
  if (sameEtag(fetched.etag, expected.etag)) {
    throw new ReplicaError(
      ReplicaErrorCode.CONTENT_MISMATCH,
      `The content of ${JSON.stringify(expected.key)} does not hash to its ETag ${expected.etag}.`,
      { key: expected.key },
    );
  }
  return undefined;
}

export type { LocalEntry };
