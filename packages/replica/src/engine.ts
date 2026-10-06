import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";

import { ReplicaError, ReplicaErrorCode, isReplicaError } from "./errors.js";
import { assertReadable, effectiveAuthority, hashFromEtag, isInstant, kvPrefixCovers } from "./scope.js";
import type {
  AuthorityState,
  AuthorityWindow,
  Coverage,
  FetchedContent,
  GrantRecord,
  LeaseToken,
  ListOpts,
  LocalEntry,
  ReplicaLastError,
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
  /** One transport for whichever grant the replica syncs under (tests, single-grant hosts). */
  transport?: ReplicaTransport;
  /**
   * A transport that invokes with exactly `grant`. Lets the engine try a
   * pending grant and fall back to the active one if the node refuses it.
   */
  transportFor?: (grant: GrantRecord) => ReplicaTransport;
  now?: () => number;
  leaseTtlMs?: number;
};

const DEFAULT_PAGE_LIMIT = 500;
const DEFAULT_LEASE_TTL_MS = 120_000;
const FETCH_CHUNK = 100;
const REPAIR_BATCH = 100;
const RETENTION_REVOKED = new Set(["retention-grant-revoked", "retention-grant-ancestor-revoked"]);
/** Refusals of a pending grant that leave the active grant to serve. */
const PENDING_REFUSALS = new Set<string>([
  ReplicaErrorCode.GRANT_UNAUTHORIZED,
  ReplicaErrorCode.GRANT_EXPIRED,
  ReplicaErrorCode.GRANT_NOT_YET_VALID,
]);

/** `"blake3-" + hex(blake3(bytes))`, the strong ETag the node attests for content. */
export function contentHash(bytes: Uint8Array): string {
  return bytesToHex(blake3(bytes));
}

function sameEtag(a: string, b: string): boolean {
  return a.replace(/^"|"$/g, "") === b.replace(/^"|"$/g, "");
}

function lastErrorOf(error: unknown, at: number): ReplicaLastError {
  return {
    at: new Date(at).toISOString(),
    code: isReplicaError(error) ? error.code : "ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** One sync attempt under one grant. */
type Attempt = {
  lease: LeaseToken;
  grant: GrantRecord;
  transport: ReplicaTransport;
  /** The pending grant until the first page under it commits (and promotes it). */
  promote: GrantRecord | null;
  signal: AbortSignal | undefined;
};

/**
 * A durable, read-only local replica of one KV prefix. Reads never touch the
 * network; `sync` pulls `tinycloud.kv/sync` pages, verifies every byte
 * against the node-attested ETag, and commits each page with its cursor.
 */
export class Replica {
  readonly #store: ReplicaStore;
  readonly #transportFor: ((grant: GrantRecord) => ReplicaTransport) | undefined;
  readonly #now: () => number;
  readonly #leaseTtlMs: number;

  constructor(options: ReplicaOptions) {
    this.#store = options.store;
    const transport = options.transport;
    this.#transportFor = options.transportFor ?? (transport === undefined ? undefined : () => transport);
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
        retentionRevoked: state.retentionRevoked,
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
    // Readers take no lock: a sync may replace this entry and collect its old
    // blob between the two reads below. One re-read sees the new entry.
    for (let attempt = 0; ; attempt += 1) {
      const entry = await this.#store.get(key);
      if (entry === undefined) {
        return { status: state.coverage === "complete" ? "absent" : "coverage_incomplete", key, meta };
      }
      if (entry.deleted) return { status: "deleted", key, meta };
      if (!entry.content) {
        return { status: "content_missing", key, etag: entry.etag, metadata: entry.metadata, meta };
      }
      const value = await this.#store.readContent(entry.hash);
      const intact = value !== undefined && (options.verify === false || contentHash(value) === entry.hash);
      if (intact) return { status: "present", key, value, etag: entry.etag, metadata: entry.metadata, meta };
      if (attempt === 0) continue;
      throw new ReplicaError(
        ReplicaErrorCode.INTEGRITY_ERROR,
        value === undefined
          ? `The stored content for ${JSON.stringify(key)} is missing.`
          : `The stored content for ${JSON.stringify(key)} does not match its hash.`,
        { key },
      );
    }
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

  /**
   * Sync under the pending grant if there is one, else the active grant. If
   * the node refuses a pending grant before anything committed under it, the
   * active grant serves: a revoked pending grant is discarded, any other
   * refusal is recorded on it. A revocation of the grant serving the replica,
   * learned anywhere in the sync, purges the replica before this returns.
   */
  async sync(options: { limit?: number; signal?: AbortSignal } = {}): Promise<SyncReport> {
    const transportFor = this.#transportFor;
    if (transportFor === undefined) throw new Error("Replica.sync needs a transport");
    const initial = await this.#state();
    if (initial.revoked !== null) {
      throw new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, `The replica's grant was revoked: ${initial.revoked}`);
    }
    const candidates = [initial.pendingGrant, initial.grant].filter((grant): grant is GrantRecord => grant !== null);
    if (candidates.length === 0) throw new ReplicaError(ReplicaErrorCode.GRANT_MISSING, "No grant is installed for this replica.");

    const lease = await this.#store.acquireSyncLease(this.#leaseTtlMs);
    if (lease === null) throw new ReplicaError(ReplicaErrorCode.BUSY, "Another process is syncing this replica.");
    try {
      for (const [index, grant] of candidates.entries()) {
        const pending = grant.cid === initial.pendingGrant?.cid;
        const attempt: Attempt = {
          lease,
          grant,
          transport: transportFor(grant),
          promote: pending ? grant : null,
          signal: options.signal,
        };
        try {
          return await this.#syncUnder(attempt, options.limit ?? DEFAULT_PAGE_LIMIT);
        } catch (error) {
          const canFallBack = pending && attempt.promote !== null && index < candidates.length - 1;
          if (canFallBack && isReplicaError(error, ReplicaErrorCode.GRANT_REVOKED)) {
            await this.#store.discardPendingGrant(grant.cid, error.message);
            continue;
          }
          if (canFallBack && isReplicaError(error) && PENDING_REFUSALS.has(error.code)) {
            await this.#store.recordPendingGrantError(grant.cid, lastErrorOf(error, this.#now()));
            continue;
          }
          throw error;
        }
      }
      throw new Error("unreachable: the last candidate either returns or throws");
    } catch (error) {
      await this.#learn(error);
      throw error;
    } finally {
      await this.#store.releaseLease(lease).catch(() => undefined);
    }
  }

  /** Persist what a failed sync taught us before the error reaches the caller. */
  async #learn(error: unknown): Promise<void> {
    if (isReplicaError(error, ReplicaErrorCode.GRANT_REVOKED)) {
      // Already revoked (the store refused a commit): nothing more to learn.
      if ((await this.#store.open())?.revoked != null) return;
      // Persisted before the error returns: later reads raise GRANT_REVOKED, also after restart.
      await this.#store.markRevoked(error.message);
      return;
    }
    if (isReplicaError(error, ReplicaErrorCode.RETENTION_GRANT_REFUSED)) {
      const cid = error.detail?.retentionGrantCid;
      const reason = error.detail?.reason;
      if (typeof cid === "string" && typeof reason === "string" && RETENTION_REVOKED.has(reason)) {
        // Bound to the grant the refused request presented: a replacement installed meanwhile stays.
        await this.#store.markRetentionRevoked(cid, error.message);
        return;
      }
    }
    await this.#store.recordError(lastErrorOf(error, this.#now())).catch(() => undefined);
  }

  /** The effective window for `grant` under `window`; throws unless it holds now (no retention for syncing). */
  #syncWindow(window: AuthorityWindow | null, grant: GrantRecord): { notBefore: string | null; expiresAt: string | null } {
    const now = this.#now();
    const authority = effectiveAuthority({ window, grant, revoked: null, policy: "whileGrantValid", now });
    if (authority.state !== "valid") assertReadable({ ...authority, retainUntil: null }, now);
    return { notBefore: authority.notBefore, expiresAt: authority.expiresAt };
  }

  async #syncUnder(attempt: Attempt, limit: number): Promise<SyncReport> {
    const state = await this.#state();
    const { config } = state;
    // A replacement grant is judged on its own leaf window until the node attests it.
    this.#syncWindow(attempt.promote === null ? state.authority : null, attempt.grant);
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
    // The source pin survives an automatic reset; only an explicit reset clears it.
    let pinned = state.nodeDid;
    let coverage = state.coverage;

    for (;;) {
      let page: SyncPage;
      const retentionGrant = config.retentionGrantCid;
      try {
        page = await attempt.transport.syncPage({
          prefix: config.prefix,
          ...(cursor === null ? {} : { cursor }),
          limit,
          ...(retentionGrant === null ? {} : { retentionGrant }),
          ...(attempt.signal === undefined ? {} : { signal: attempt.signal }),
        });
      } catch (error) {
        if (isReplicaError(error, ReplicaErrorCode.RESET_REQUIRED) && report.resets === 0) {
          const reason = typeof error.detail?.reason === "string" ? error.detail.reason : "reset-required";
          await this.#store.reset(attempt.lease, `node: ${reason}`, { keepSource: true });
          report.resets += 1;
          cursor = null;
          coverage = "empty";
          continue;
        }
        if (isReplicaError(error, ReplicaErrorCode.RETENTION_GRANT_REFUSED) && retentionGrant !== null) {
          throw new ReplicaError(error.code, error.message, { ...error.detail, retentionGrantCid: retentionGrant }, { cause: error });
        }
        throw error;
      }

      this.#checkPage(page, config.space, config.prefix, pinned);
      // Fetch only while the attested window holds; the store re-checks it at commit.
      const window = this.#syncWindow(page.authority, attempt.grant);
      const verified = await this.#verify(page, attempt);
      coverage = page.more ? (coverage === "complete" ? "complete" : "bootstrapping") : "complete";
      const at = new Date(this.#now()).toISOString();
      // The store checks `window` against its clock inside the commit transaction.
      await this.#store.applyPage(attempt.lease, {
        changes: verified.changes,
        blobs: verified.blobs,
        cursor: page.cursor,
        source: page.source,
        authority: page.authority,
        coverage,
        at,
        window,
        complete: !page.more,
        promoteGrant: attempt.promote,
      });
      if (attempt.promote !== null) {
        report.promotedGrant = true;
        attempt.promote = null;
      }
      report.pages += 1;
      report.changes += page.changes.length;
      report.deleted += page.changes.filter((change) => change.deleted).length;
      report.fetched += verified.fetched;
      if (page.cursor !== cursor) report.cursorAdvanced = true;
      cursor = page.cursor;
      pinned = page.source.nodeDid;
      await this.#store.renewLease(attempt.lease, this.#leaseTtlMs);
      if (!page.more) break;
    }

    report.repaired = await this.#repair(attempt, cursor, pinned, coverage);
    report.blobsCollected = await this.#store.collectGarbage(attempt.lease);
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
    // A bound that does not parse would widen the window (NaN compares false): fail closed.
    for (const [name, value] of Object.entries(page.authority)) {
      if (value !== null && (typeof value !== "string" || !isInstant(value))) {
        throw new ReplicaError(
          ReplicaErrorCode.PROTOCOL_ERROR,
          `The node attested authority.${name} = ${JSON.stringify(value)}, which is not a timestamp; nothing was committed.`,
        );
      }
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
    attempt: Attempt,
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
      const contents = await attempt.transport.fetchContent(
        chunk.map((candidate) => candidate.key),
        attempt.signal === undefined ? undefined : { signal: attempt.signal },
      );
      for (const candidate of chunk) {
        const ok = acceptContent(candidate, contents.get(candidate.key));
        if (ok === undefined) continue; // stale or gone: commit with content=0, repaired later
        blobs.set(candidate.hash, ok);
        (changes[candidate.index] as Extract<VerifiedChange, { deleted: false }>).content = true;
        fetched += 1;
      }
      await this.#store.renewLease(attempt.lease, this.#leaseTtlMs);
    }
    return { changes, blobs, fetched };
  }

  async #repair(attempt: Attempt, cursor: string | null, nodeDid: string | null, coverage: Coverage): Promise<number> {
    const pending = await this.#store.pendingRepairs(Number.MAX_SAFE_INTEGER);
    let repaired = 0;
    for (let start = 0; start < pending.length; start += REPAIR_BATCH) {
      const chunk = pending.slice(start, start + REPAIR_BATCH);
      const contents = await attempt.transport.fetchContent(
        chunk.map((entry) => entry.key),
        attempt.signal === undefined ? undefined : { signal: attempt.signal },
      );
      const blobs = new Map<string, Uint8Array>();
      const changes: VerifiedChange[] = [];
      for (const entry of chunk) {
        const bytes = acceptContent(entry, contents.get(entry.key));
        if (bytes === undefined) continue;
        blobs.set(entry.hash, bytes);
        changes.push({ ...entry, content: true });
      }
      await this.#store.renewLease(attempt.lease, this.#leaseTtlMs);
      if (changes.length === 0) continue;
      const state = await this.#state();
      await this.#store.applyPage(attempt.lease, {
        changes,
        blobs,
        cursor,
        source: { nodeDid: nodeDid ?? "", space: state.config.space, prefix: state.config.prefix },
        authority: null,
        coverage,
        at: new Date(this.#now()).toISOString(),
        window: this.#syncWindow(state.authority, attempt.grant),
        complete: false,
        promoteGrant: null,
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
