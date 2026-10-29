import { canonicalize, shareEnvelopeV3Schema } from "@tinycloud/share-envelope";
import type { SenderShareRecord } from "../history.js";
import { parseArtifactVersionPath } from "../artifact-core.js";
import { verifyArtifactShare } from "../artifact-pin.js";
import { AgentRecordError, OwnerUnwrapUnavailableError, openAgentRecordAsOwner, parseStoredAgentRecord, SUPPORTED_AGENT_RECORD_V, MAX_AGENT_RECORD_BYTES } from "./agent-record.js";
import type { ShareIndexBackend } from "./backend.js";
import { DEFAULT_CAS_POLICY, runCas, type CasPolicy } from "./cas.js";
import { agentIdFromDid, agentRecordPrefix, classifyRecordKey, INDEX_MAIN_KEY, rejectedKeyEntry, SHARE_RECORDS_VAULT_PREFIX } from "./ids.js";
import { assertLinkBoundToMaterial, openDeliveryEnvelope, restoreShareRecordLink, type StoredShareRecord } from "./delivery.js";
import { validateShareLink } from "./link.js";
import { claimRank, decideClaim } from "./precedence.js";
import {
  ShareRecordSchemaError, checkAgentRecordSchema, emptyIndexDocument, parseArchiveDocument, parseIndexDocument, project, registeredAtFits,
  type ShareIndexAgentEntry, type ShareIndexDocument, type ShareIndexRow,
} from "./schema.js";
import { verifyAgentRecordChain, type ShareRegistrationKey } from "./verify/chain.js";
import type { SiweCacaoParser } from "./verify/session.js";

/**
 * `SenderShareIndex`: the encrypted, display-only share index at
 * `records/_index/main` (design C §2, §4, §5, §7). Records stay canonical;
 * the index is a projection that is only ever written with compare-and-swap.
 */

export interface ShareIndexLimits {
  readonly listPagesPerPass: number;
  readonly fetchesPerPass: number;
  readonly newRowsPerAgentPerPass: number;
  readonly liveRowsPerAgent: number;
  readonly rejectionsBeforePause: number;
  /** Agent rows together may use at most this share of `mainRowBytes`. */
  readonly agentRowShare: number;
  readonly mainRowBytes: number;
  readonly headerBytes: number;
  readonly maxAgentRecordBytes: number;
  readonly tombstoneTtlMs: number;
  readonly archiveAgeMs: number;
  readonly statusChecksPerSync: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_SHARE_INDEX_LIMITS: ShareIndexLimits = {
  listPagesPerPass: 10,
  fetchesPerPass: 200,
  newRowsPerAgentPerPass: 50,
  liveRowsPerAgent: 500,
  rejectionsBeforePause: 100,
  agentRowShare: 0.5,
  mainRowBytes: 1024 * 1024,
  headerBytes: 64 * 1024,
  maxAgentRecordBytes: MAX_AGENT_RECORD_BYTES,
  tombstoneTtlMs: 30 * DAY_MS,
  archiveAgeMs: 90 * DAY_MS,
  statusChecksPerSync: 200,
};

/** Outbox ops carry rows and CIDs, never records. */
export type ShareIndexOp =
  | { readonly id: string; readonly type: "upsert"; readonly key: string; readonly row: ShareIndexRow }
  | { readonly id: string; readonly type: "revoke"; readonly key: string; readonly at: string; readonly confirmed: boolean }
  /** Only for revoked, expired or unreadable rows: tombstone first, then the caller deletes the record. */
  | { readonly id: string; readonly type: "delete"; readonly key: string }
  /** Owner agent controls: `resume` clears a pause; `recheck` also clears the agent's rejected lists. */
  | { readonly id: string; readonly type: "agent"; readonly agentId: string; readonly action: "resume" | "recheck" };

/** Durable op queue: IndexedDB on the web, the profile cache for Tier 2. */
export interface ShareIndexOutbox {
  list(): Promise<readonly ShareIndexOp[]>;
  put(op: ShareIndexOp): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
}

export class MemoryShareIndexOutbox implements ShareIndexOutbox {
  private readonly ops = new Map<string, ShareIndexOp>();
  async list(): Promise<readonly ShareIndexOp[]> { return [...this.ops.values()]; }
  async put(op: ShareIndexOp): Promise<void> { this.ops.set(op.id, op); }
  async remove(ids: readonly string[]): Promise<void> { for (const id of ids) this.ops.delete(id); }
}

/** Node-side status of a row's share, for status sync. `unknown` (e.g. agent-issued CIDs, TC-1419) changes nothing. */
export interface ShareStatusPort {
  status(key: string, row: ShareIndexRow): Promise<"revoked" | "active" | "unknown">;
}

export interface SenderShareIndexOptions {
  readonly backend: ShareIndexBackend;
  readonly outbox: ShareIndexOutbox;
  /** The account owner (`did:pkh:…`). */
  readonly ownerDid: string;
  /** `updatedBy` label of this writer. */
  readonly writer: string;
  /** Configured share origins, for the link check. */
  readonly shareOrigins: readonly string[];
  /** sdk-core `parseSignedSiweCacao`. */
  readonly parseSiweCacao: SiweCacaoParser;
  /** Node registration keys by `nodeAudience`, from the share public config. */
  readonly registrationKey?: (nodeAudience: string) => ShareRegistrationKey | undefined;
  readonly limits?: Partial<ShareIndexLimits>;
  readonly cas?: Partial<CasPolicy>;
  readonly now?: () => Date;
}

export type ShareIndexLoad =
  | { readonly status: "ok"; readonly doc: ShareIndexDocument }
  /** A higher schema version: render read-only (option A path), never write. */
  | { readonly status: "read_only"; readonly v: number }
  | { readonly status: "not_found" }
  /** Deterministic corruption: the next write rebuilds. */
  | { readonly status: "corrupt" }
  /** Outage: never a reason to rebuild. */
  | { readonly status: "unavailable" };

export type ShareIndexWriteStatus = "written" | "unchanged" | "read_only" | "unavailable";

export interface ShareIndexWriteOutcome {
  readonly status: ShareIndexWriteStatus;
  /** The document as written, or as found when the change was already present. */
  readonly doc?: ShareIndexDocument;
}

export interface ShareIndexFlushResult {
  readonly status: ShareIndexWriteStatus | "empty";
  /** Op ids that can never apply (tombstoned upsert, delete of a live row, unknown row). They are dropped. */
  readonly refused: readonly string[];
}

/**
 * §5 rejection reasons; every check-4 failure (unwrap, DEK length, commit, GCM) is `decrypt`.
 * `provenance`: an agent-subtree record claiming `migrated`, which only owner imports may carry.
 */
export type AgentRejectReason = "size" | "shape" | "header" | "decrypt" | "schema" | "provenance" | "link" | "proof";

export interface ShareIndexReconcileReport {
  readonly status: ShareIndexWriteStatus;
  readonly pages: number;
  readonly fetches: number;
  readonly admitted: number;
  readonly rejected: Readonly<Record<string, number>>;
  readonly deferred: number;
  /** True when this pass reached the end of the key listing. */
  readonly cycleComplete: boolean;
  /** The header reached its cap: new agent header state (entries, rejections) was not added. Show an alert; no row was evicted. */
  readonly headerFull: boolean;
}

type Finding =
  | { readonly kind: "web"; readonly key: string; readonly row: ShareIndexRow }
  | { readonly kind: "agent"; readonly key: string; readonly agentId: string; readonly did: string; readonly row: ShareIndexRow }
  | { readonly kind: "reject"; readonly agentId: string; readonly suffix: string; readonly reason: AgentRejectReason }
  | { readonly kind: "newer"; readonly agentId: string; readonly suffix: string; readonly recordV: number }
  | { readonly kind: "gc"; readonly agentId: string }
  | { readonly kind: "clear-newer"; readonly agentId: string };

type Examined =
  | { readonly kind: "admit"; readonly did: string; readonly row: ShareIndexRow }
  | { readonly kind: "reject"; readonly reason: AgentRejectReason }
  | { readonly kind: "newer"; readonly recordV: number }
  | { readonly kind: "skip" };

/** Mutable working copies used inside one CAS mutation. */
interface WorkingAgent {
  did: string | null;
  rows: number;
  rejected: Record<string, number>;
  rejectedKeys: string[];
  newerKeys?: string[];
  newerV?: number;
  paused: false | { reason: "rejections" | "row-cap" | "newer"; at: string };
  firstSeen: string;
  [unknown: string]: unknown;
}
interface WorkingDoc {
  v: number;
  ownerDid: string;
  spaceId: string;
  updatedAt: string;
  updatedBy: string;
  archives: { name: string; ids: string[] }[];
  tombstones: { key: string; at: string }[];
  reconcile: { cursor?: string };
  agents: Record<string, WorkingAgent>;
  rows: Record<string, ShareIndexRow>;
  [unknown: string]: unknown;
}

function bytesOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Encoded size of everything except the rows. */
export function headerBytes(doc: ShareIndexDocument): number {
  const { rows: _rows, ...header } = doc;
  return bytesOf(header);
}

function sameContent(left: ShareIndexDocument, right: ShareIndexDocument): boolean {
  const strip = ({ updatedAt: _a, updatedBy: _b, ...rest }: ShareIndexDocument) => rest;
  return canonicalize(strip(left)) === canonicalize(strip(right));
}

function basename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

function agentOf(row: ShareIndexRow): string | undefined {
  return row.src.startsWith("agent:") ? row.src.slice("agent:".length) : undefined;
}

function isObject(item: unknown): item is Record<string, unknown> {
  return item !== null && typeof item === "object" && !Array.isArray(item);
}

/** Enough of a web record to project a row; anything less is shown as unreadable. */
function isWebRecord(value: unknown): value is SenderShareRecord {
  if (!isObject(value)) return false;
  const { shareId, target, resource, actions, recipientMatcher, registeredAt, expiresAt } = value;
  return typeof shareId === "string" && isObject(target) && typeof target.spaceId === "string"
    && isObject(resource) && typeof resource.path === "string" && Array.isArray(actions) && actions.every((item) => typeof item === "string")
    && isObject(recipientMatcher) && typeof recipientMatcher.kind === "string"
    && typeof registeredAt === "string" && typeof expiresAt === "string";
}

function unreadableRow(now: Date): ShareIndexRow {
  const at = now.toISOString();
  return { n: "Unreadable share", k: "file", ak: "bearer", al: "", a: [], c: at, x: at, rk: "none", src: "web", na: true };
}

export class SenderShareIndex {
  private readonly backend: ShareIndexBackend;
  private readonly limits: ShareIndexLimits;
  private readonly cas: CasPolicy;
  private readonly now: () => Date;

  constructor(private readonly options: SenderShareIndexOptions) {
    this.backend = options.backend;
    this.limits = { ...DEFAULT_SHARE_INDEX_LIMITS, ...options.limits };
    this.cas = { ...DEFAULT_CAS_POLICY, ...options.cas };
    this.now = options.now ?? (() => new Date());
  }

  /** Library open: one GET + one decrypt. */
  async load(): Promise<ShareIndexLoad> {
    const read = await this.backend.readVault(INDEX_MAIN_KEY);
    if (read.status === "not_found" || read.status === "unavailable") return { status: read.status };
    if (read.status === "corrupt") return { status: "corrupt" };
    const parsed = parseIndexDocument(read.value);
    if (parsed.status === "newer") return { status: "read_only", v: parsed.v };
    return parsed.status === "ok" ? { status: "ok", doc: parsed.doc } : { status: "corrupt" };
  }

  async enqueue(op: ShareIndexOp): Promise<void> {
    await this.options.outbox.put(op);
  }

  // -------------------------------------------------------------------------
  // CAS

  /** Rebuild base after deterministic corruption: an empty document plus the archives found under `_index/`. */
  private async rebuildBase(): Promise<WorkingDoc> {
    const doc = this.emptyDoc();
    const page = await this.backend.listKeys("_index/");
    if (page.status !== "ok") return doc;
    for (const key of page.keys) {
      const classified = classifyRecordKey(key);
      if (classified.kind !== "index" || classified.name === "main") continue;
      const read = await this.backend.readVault(key);
      const archive = read.status === "ok" ? parseArchiveDocument(read.value) : undefined;
      if (archive !== undefined) doc.archives.push({ name: classified.name, ids: Object.keys(archive.rows) });
    }
    return doc;
  }

  private emptyDoc(): WorkingDoc {
    return emptyIndexDocument({ ownerDid: this.options.ownerDid, spaceId: this.backend.spaceId, writer: this.options.writer, now: this.now() }) as unknown as WorkingDoc;
  }

  /**
   * Read → mutate → If-Match write, per {@link runCas}. A no-op change is never
   * written. The header cap is enforced by the reconciler on agent-derived
   * state only (see {@link reconcile}); the owner's own writes are never blocked by it.
   */
  private async update(mutate: (doc: WorkingDoc) => void | Promise<void>): Promise<ShareIndexWriteOutcome> {
    return runCas<ShareIndexWriteOutcome>(INDEX_MAIN_KEY, this.cas, async () => {
      const read = await this.backend.readVault(INDEX_MAIN_KEY);
      let base: WorkingDoc;
      let condition: { ifMatch: string } | { ifNoneMatch: "*" };
      let existed = true;
      if (read.status === "unavailable") return { done: { status: "unavailable" as const } };
      if (read.status === "not_found") {
        base = this.emptyDoc();
        condition = { ifNoneMatch: "*" };
        existed = false;
      } else if (read.status === "corrupt") {
        if (read.etag === undefined) return { done: { status: "unavailable" as const } };
        base = await this.rebuildBase();
        condition = { ifMatch: read.etag };
        existed = false;
      } else {
        const parsed = parseIndexDocument(read.value);
        if (parsed.status === "newer") return { done: { status: "read_only" as const } };
        base = parsed.status === "ok" ? structuredClone(parsed.doc) as unknown as WorkingDoc : await this.rebuildBase();
        existed = parsed.status === "ok";
        condition = { ifMatch: read.etag };
      }
      const before = structuredClone(base) as unknown as ShareIndexDocument;
      await mutate(base);
      const next = base as unknown as ShareIndexDocument;
      if (existed && sameContent(before, next)) return { done: { status: "unchanged" as const, doc: before } };
      base.updatedAt = this.now().toISOString();
      base.updatedBy = this.options.writer;
      return { write: await this.backend.writeVault(INDEX_MAIN_KEY, next, condition), onSuccess: () => ({ status: "written" as const, doc: next }) };
    });
  }

  // -------------------------------------------------------------------------
  // Shared mutation helpers

  /** When false (header at its cap), no new agent header state is added: no new entries, rejections or newer keys. */
  private growHeader = true;

  private ensureAgent(doc: WorkingDoc, agentId: string): WorkingAgent | undefined {
    const existing = doc.agents[agentId];
    if (existing !== undefined || !this.growHeader) return existing;
    const created: WorkingAgent = { did: null, rows: 0, rejected: {}, rejectedKeys: [], paused: false, firstSeen: this.now().toISOString() };
    doc.agents[agentId] = created;
    return created;
  }

  /** Count a rejection once per key: a key already in `rejectedKeys` changes nothing. */
  private recordRejection(doc: WorkingDoc, agentId: string, suffix: string, reason: string): void {
    const entry = this.ensureAgent(doc, agentId);
    const entryKey = rejectedKeyEntry(suffix);
    if (entry === undefined || !this.growHeader || entry.rejectedKeys.includes(entryKey)) return;
    entry.rejected[reason] = (entry.rejected[reason] ?? 0) + 1;
    if (entry.rejectedKeys.length < this.limits.rejectionsBeforePause) entry.rejectedKeys.push(entryKey);
    const total = Object.values(entry.rejected).reduce((sum, count) => sum + count, 0);
    if (entry.paused === false && total >= this.limits.rejectionsBeforePause) entry.paused = { reason: "rejections", at: this.now().toISOString() };
  }

  /** Remove a displaced row; a displaced agent claim counts as `proof` and is not refetched. */
  private displace(doc: WorkingDoc, key: string): void {
    const row = doc.rows[key];
    if (row === undefined) return;
    delete doc.rows[key];
    const agentId = agentOf(row);
    if (agentId === undefined) return;
    const entry = this.ensureAgent(doc, agentId);
    if (entry !== undefined) entry.rows = Math.max(0, entry.rows - 1);
    this.recordRejection(doc, agentId, basename(key), "proof");
  }

  private isRetired(doc: WorkingDoc, key: string): boolean {
    return doc.tombstones.some((tombstone) => tombstone.key === key) || doc.archives.some((archive) => archive.ids.includes(key));
  }

  // -------------------------------------------------------------------------
  // Ops

  private applyOp(doc: WorkingDoc, op: ShareIndexOp): "applied" | "refused" {
    const now = this.now();
    if (op.type === "agent") {
      const entry = doc.agents[op.agentId];
      if (entry === undefined) return "refused";
      entry.paused = false;
      if (op.action === "recheck") {
        entry.rejected = {};
        entry.rejectedKeys = [];
        delete entry.newerKeys;
        delete entry.newerV;
      }
      return "applied";
    }
    const existing = doc.rows[op.key];
    if (op.type === "upsert") {
      if (this.isRetired(doc, op.key)) return "refused";
      if (existing !== undefined) return "applied"; // display fields are immutable
      const decision = decideClaim(doc.rows, op.key, op.row);
      if (!decision.admit) return "refused";
      for (const key of decision.displaced) this.displace(doc, key);
      doc.rows[op.key] = op.row;
      return "applied";
    }
    if (op.type === "revoke") {
      if (existing === undefined) return this.isRetired(doc, op.key) ? "applied" : "refused";
      const at = existing.r === undefined || Date.parse(op.at) < Date.parse(existing.r.at) ? op.at : existing.r.at;
      doc.rows[op.key] = { ...existing, r: { at, confirmed: existing.r?.confirmed === true || op.confirmed } };
      return "applied";
    }
    if (existing === undefined) return doc.tombstones.some((tombstone) => tombstone.key === op.key) ? "applied" : "refused";
    if (existing.r === undefined && Date.parse(existing.x) > now.getTime() && existing.na !== true) return "refused";
    this.displaceForDelete(doc, op.key, existing);
    doc.tombstones.push({ key: op.key, at: now.toISOString() });
    return "applied";
  }

  private displaceForDelete(doc: WorkingDoc, key: string, row: ShareIndexRow): void {
    delete doc.rows[key];
    const agentId = agentOf(row);
    const entry = agentId === undefined ? undefined : doc.agents[agentId];
    if (entry !== undefined) entry.rows = Math.max(0, entry.rows - 1);
  }

  /**
   * Apply every pending outbox op in one CAS. Ops leave the outbox only after
   * the write is confirmed (or the change was already present). Any CAS error,
   * including `INVALID_ETAG`, propagates with the ops still pending.
   */
  async flush(): Promise<ShareIndexFlushResult> {
    const ops = await this.options.outbox.list();
    if (ops.length === 0) return { status: "empty", refused: [] };
    let refused: string[] = [];
    const result = await this.update((doc) => {
      refused = [];
      for (const op of ops) if (this.applyOp(doc, op) === "refused") refused.push(op.id);
    });
    if (result.status === "written" || result.status === "unchanged") await this.options.outbox.remove(ops.map((op) => op.id));
    return { status: result.status, refused };
  }

  // -------------------------------------------------------------------------
  // Reconciler (§4, §5)

  private async examineAgentRecord(key: string, agentId: string, shareId: string, archived: () => Promise<ReadonlyMap<string, number>>): Promise<Examined> {
    const unwrap = this.backend.ownerUnwrap;
    if (unwrap === undefined) return { kind: "skip" };
    // 2. size: refused before the body is fetched when the adapter can learn it first, and from the body length otherwise.
    const raw = await this.backend.readRaw(key, this.limits.maxAgentRecordBytes);
    if (raw.status === "too_large") return { kind: "reject", reason: "size" };
    if (raw.status !== "ok") return { kind: "skip" };
    if (raw.bytes.byteLength > this.limits.maxAgentRecordBytes) return { kind: "reject", reason: "size" };
    // 3. header bound to the path.
    let stored;
    try {
      stored = parseStoredAgentRecord(raw.bytes, { ownerNetworkId: this.backend.ownerNetworkId });
    } catch (error) {
      if (error instanceof AgentRecordError && error.reason === "newer") return { kind: "newer", recordV: this.peekRecordV(raw.bytes) };
      return { kind: "reject", reason: error instanceof AgentRecordError && error.reason === "header" ? "header" : "shape" };
    }
    let derived: string;
    try { derived = agentIdFromDid(stored.hdr.agentDid); } catch { return { kind: "reject", reason: "header" }; }
    if (derived !== agentId) return { kind: "reject", reason: "header" };
    // 4. unwrap, commit, open.
    let plaintext: Uint8Array;
    try {
      plaintext = await openAgentRecordAsOwner(stored, { spaceId: this.backend.spaceId, vaultKey: `${SHARE_RECORDS_VAULT_PREFIX}${key}` }, unwrap);
    } catch (error) {
      if (error instanceof OwnerUnwrapUnavailableError) return { kind: "skip" };
      return { kind: "reject", reason: "decrypt" };
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)); } catch { return { kind: "reject", reason: "schema" }; }
    const checked = await this.checkRecord(value, { key, shareId, src: `agent:${agentId}`, source: "agent", agentDid: stored.hdr.agentDid, recordV: stored.hdr.recordV }, archived);
    return checked.kind === "admit" ? { kind: "admit", did: stored.hdr.agentDid, row: checked.row } : checked;
  }

  /** §5 checks 5–7 for a decrypted record, shared by agent records and one-time owner imports. */
  private async checkRecord(
    value: unknown,
    input: { readonly key: string; readonly shareId: string; readonly src: string; readonly source: "agent" | "migrated"; readonly agentDid: string; readonly recordV: number },
    archived: () => Promise<ReadonlyMap<string, number>>,
  ): Promise<{ readonly kind: "admit"; readonly row: ShareIndexRow } | { readonly kind: "reject"; readonly reason: AgentRejectReason }> {
    // 5. schema, versioned.
    let record: StoredShareRecord;
    try {
      record = checkAgentRecordSchema(value, {
        recordV: input.recordV, shareId: input.shareId, accountOwnerDid: this.options.ownerDid, agentDid: input.agentDid, source: input.source,
      });
    } catch (error) {
      return { kind: "reject", reason: error instanceof ShareRecordSchemaError && error.reason === "provenance" ? "provenance" : "schema" };
    }
    // Reconstruct and verify original wrapper metadata before link and chain admission. Details: TC-1739
    let link: string | undefined;
    try { link = await restoreShareRecordLink(record, this.options.shareOrigins); } catch { return { kind: "reject", reason: "link" }; }
    if (link !== undefined && !validateShareLink(link, this.options.shareOrigins).ok) return { kind: "reject", reason: "link" };
    if (link !== undefined && record.deliveryMaterial !== undefined) {
      try { assertLinkBoundToMaterial(link, record.deliveryMaterial); } catch { return { kind: "reject", reason: "link" }; }
    }
    // 7. CID ownership by proof. A migrated record has no agent binding, so it is never `proven`.
    const verdict = await verifyAgentRecordChain(record, {
      accountOwnerDid: this.options.ownerDid, agentDid: input.agentDid, now: this.now(), parseSiweCacao: this.options.parseSiweCacao,
      ...(this.options.registrationKey === undefined ? {} : { registrationKey: this.options.registrationKey }),
    });
    if (!verdict.ok) return { kind: "reject", reason: "proof" };
    if (parseArtifactVersionPath(record.resource.path) !== undefined) {
      if (record.proofs?.ownerPolicy !== undefined) return { kind: "reject", reason: "proof" };
      if (record.deliveryMaterial !== undefined) {
        try {
          const envelope = shareEnvelopeV3Schema.parse(await openDeliveryEnvelope(record.deliveryMaterial));
          verifyArtifactShare(envelope, { expectedOwnerDid: envelope.policy.ownerDid });
        } catch { return { kind: "reject", reason: "proof" }; }
      } else if (record.proofs?.link === undefined) return { kind: "reject", reason: "proof" };
    }
    // registeredAt against signed times in the chain, never against when the owner happens to look. A one-time
    // owner import keeps the ruled exemption from the ±1-day anchor; it still may not postdate the chain or the clock.
    const window = input.source === "migrated" ? { ...(verdict.issued.latest === undefined ? {} : { latest: verdict.issued.latest }) } : verdict.issued;
    if (!registeredAtFits(record.registeredAt, window, this.now())) return { kind: "reject", reason: "schema" };
    const row = project(record, { key: input.key, src: input.src, claims: verdict.claims, proof: { state: verdict.state, expired: verdict.expired } });
    if (verdict.state !== "proven") {
      const archivedClaims = await archived();
      if (verdict.claims.some((cid) => (archivedClaims.get(cid) ?? -1) >= claimRank(row))) return { kind: "reject", reason: "proof" };
    }
    return { kind: "admit", row };
  }

  private peekRecordV(bytes: Uint8Array): number {
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const recordV = isObject(value) && isObject(value.hdr) ? value.hdr.recordV : undefined;
      return typeof recordV === "number" && Number.isSafeInteger(recordV) ? recordV : SUPPORTED_AGENT_RECORD_V + 1;
    } catch {
      return SUPPORTED_AGENT_RECORD_V + 1;
    }
  }

  private async archivedClaims(doc: ShareIndexDocument): Promise<Map<string, number>> {
    const claims = new Map<string, number>();
    for (const archive of doc.archives) {
      const read = await this.backend.readVault(`_index/${archive.name}`);
      const parsed = read.status === "ok" ? parseArchiveDocument(read.value) : undefined;
      for (const row of Object.values(parsed?.rows ?? {})) for (const cid of row.cc ?? []) claims.set(cid, Math.max(claims.get(cid) ?? -1, claimRank(row)));
    }
    return claims;
  }

  /**
   * One budgeted pass: list keys from `reconcile.cursor`, fetch and check what
   * the index does not know, then apply the findings in one CAS. Never
   * deletes rows; tombstoned, archived and rejected keys are never refetched.
   */
  async reconcile(): Promise<ShareIndexReconcileReport> {
    const loaded = await this.load();
    if (loaded.status === "read_only" || loaded.status === "unavailable") return { status: loaded.status, pages: 0, fetches: 0, admitted: 0, rejected: {}, deferred: 0, cycleComplete: false, headerFull: false };
    const doc = loaded.status === "ok" ? loaded.doc : (this.emptyDoc() as unknown as ShareIndexDocument);
    const known = new Set<string>([...Object.keys(doc.rows), ...doc.tombstones.map((tombstone) => tombstone.key), ...doc.archives.flatMap((archive) => archive.ids)]);
    const findings: Finding[] = [];
    const agentStates = new Map<string, { known: Set<string>; attempted: number; rejections: number; paused: boolean; rows: number }>();
    const agentState = (agentId: string): { known: Set<string>; attempted: number; rejections: number; paused: boolean; rows: number } => {
      const entry: ShareIndexAgentEntry | undefined = doc.agents[agentId];
      let state = agentStates.get(agentId);
      if (state === undefined) {
        state = {
          known: new Set([...(entry?.rejectedKeys ?? []), ...(entry?.newerKeys ?? [])]),
          attempted: 0,
          rejections: Object.values(entry?.rejected ?? {}).reduce((sum, count) => sum + count, 0),
          paused: entry !== undefined && entry.paused !== false,
          rows: entry?.rows ?? 0,
        };
        agentStates.set(agentId, state);
      }
      return state;
    };
    let archived: Promise<Map<string, number>> | undefined;
    const archivedOnce = () => (archived ??= this.archivedClaims(doc));
    let pages = 0;
    let fetches = 0;
    let deferred = 0;
    const rejectedCounts: Record<string, number> = {};
    const reject = (agentId: string, suffix: string, reason: AgentRejectReason): void => {
      const state = agentState(agentId);
      state.known.add(rejectedKeyEntry(suffix));
      state.rejections++;
      if (state.rejections >= this.limits.rejectionsBeforePause) state.paused = true;
      rejectedCounts[reason] = (rejectedCounts[reason] ?? 0) + 1;
      findings.push({ kind: "reject", agentId, suffix, reason });
    };

    let cursor = doc.reconcile.cursor;
    let cycleComplete = false;
    let budgetHit = false;
    pageLoop: while (pages < this.limits.listPagesPerPass) {
      let page = await this.backend.listKeys("", cursor);
      pages++;
      // A stored cursor can go stale (it is bound to the listing session): restart from the top once.
      if (page.status !== "ok" && cursor !== undefined && pages === 1) {
        cursor = undefined;
        page = await this.backend.listKeys("");
        pages++;
      }
      if (page.status !== "ok") break;
      for (const key of page.keys) {
        const classified = classifyRecordKey(key);
        if (classified.kind === "index") continue;
        if (classified.kind === "rejected") {
          if (classified.agentId === undefined || classified.suffix === undefined) continue; // owner-written: skip uncounted
          const state = agentState(classified.agentId);
          if (state.paused || state.known.has(rejectedKeyEntry(classified.suffix))) continue;
          reject(classified.agentId, classified.suffix, "shape");
          continue;
        }
        if (known.has(key)) continue;
        if (fetches >= this.limits.fetchesPerPass) { budgetHit = true; break pageLoop; }
        if (classified.kind === "web") {
          fetches++;
          const read = await this.backend.readVault(key);
          if (read.status === "ok" && isObject(read.value) && read.value.provenance === "migrated") {
            // One-time owner import: verified like an agent record; a failure needs attention.
            const checked = await this.checkRecord(read.value, { key, shareId: classified.shareId, src: "web", source: "migrated", agentDid: "", recordV: SUPPORTED_AGENT_RECORD_V }, archivedOnce);
            findings.push({ kind: "web", key, row: checked.kind === "admit" ? checked.row : { ...unreadableRow(this.now()), pv: "migrated" } });
          } else if (read.status === "ok") {
            let row: ShareIndexRow;
            try { row = isWebRecord(read.value) ? project(read.value, { key, src: "web" }) : unreadableRow(this.now()); } catch { row = unreadableRow(this.now()); }
            findings.push({ kind: "web", key, row });
          } else if (read.status === "corrupt") {
            findings.push({ kind: "web", key, row: unreadableRow(this.now()) });
          }
          continue;
        }
        // Agent record.
        const state = agentState(classified.agentId);
        if (state.paused || state.known.has(rejectedKeyEntry(classified.shareId))) continue;
        // Every fetch, whatever its verdict, spends the agent's per-pass allowance (≤50 GETs and decrypts per agent per pass).
        if (state.attempted >= this.limits.newRowsPerAgentPerPass || state.rows + state.attempted >= this.limits.liveRowsPerAgent) { deferred++; continue; }
        fetches++;
        state.attempted++;
        const examined = await this.examineAgentRecord(key, classified.agentId, classified.shareId, archivedOnce);
        if (examined.kind === "admit") {
          findings.push({ kind: "agent", key, agentId: classified.agentId, did: examined.did, row: examined.row });
        } else if (examined.kind === "reject") {
          reject(classified.agentId, classified.shareId, examined.reason);
        } else if (examined.kind === "newer") {
          state.known.add(rejectedKeyEntry(classified.shareId));
          findings.push({ kind: "newer", agentId: classified.agentId, suffix: classified.shareId, recordV: examined.recordV });
        }
      }
      cursor = page.cursor;
      if (cursor === undefined) { cycleComplete = true; break; }
    }
    const nextCursor = budgetHit ? doc.reconcile.cursor : cursor;

    // Header GC (V3-8) and newer re-check.
    for (const [agentId, entry] of Object.entries(doc.agents)) {
      if (entry.newerKeys !== undefined && entry.newerV !== undefined && entry.newerV <= SUPPORTED_AGENT_RECORD_V) findings.push({ kind: "clear-newer", agentId });
      if (entry.rows !== 0 || agentStates.get(agentId)?.attempted || pages >= this.limits.listPagesPerPass) continue;
      const prefixPage = await this.backend.listKeys(agentRecordPrefix(agentId));
      pages++;
      if (prefixPage.status === "ok" && prefixPage.keys.length === 0) findings.push({ kind: "gc", agentId });
    }

    let admitted = 0;
    let headerFull = false;
    const result = await this.update((working) => {
      // Header cap (§5, never evicts rows): if the findings would grow the header past its cap, apply them
      // again without new agent header state. Rows still land; the caller shows `headerFull` as an alert.
      const trial = structuredClone(working);
      this.applyFindings(trial, findings, () => {});
      headerFull = headerBytes(trial as unknown as ShareIndexDocument) > this.limits.headerBytes && headerBytes(trial as unknown as ShareIndexDocument) > headerBytes(working as unknown as ShareIndexDocument);
      admitted = 0;
      this.growHeader = !headerFull;
      try {
        this.applyFindings(working, findings, () => { admitted++; });
      } finally {
        this.growHeader = true;
      }
      if (nextCursor === undefined) delete working.reconcile.cursor;
      else working.reconcile.cursor = nextCursor;
    });
    return { status: result.status, pages, fetches, admitted, rejected: rejectedCounts, deferred, cycleComplete, headerFull };
  }

  private applyFindings(doc: WorkingDoc, findings: readonly Finding[], onAdmit: () => void): void {
    const agentBudget = this.limits.mainRowBytes * this.limits.agentRowShare;
    let agentBytes = Object.values(doc.rows).filter((row) => agentOf(row) !== undefined).reduce((sum, row) => sum + bytesOf(row), 0);
    for (const finding of findings) {
      if (finding.kind === "reject") { this.recordRejection(doc, finding.agentId, finding.suffix, finding.reason); continue; }
      if (finding.kind === "gc") {
        const entry = doc.agents[finding.agentId];
        if (entry !== undefined && entry.rows === 0) delete doc.agents[finding.agentId];
        continue;
      }
      if (finding.kind === "clear-newer") {
        const entry = doc.agents[finding.agentId];
        if (entry !== undefined) { delete entry.newerKeys; delete entry.newerV; if (entry.paused !== false && entry.paused.reason === "newer") entry.paused = false; }
        continue;
      }
      if (finding.kind === "newer") {
        const entry = this.ensureAgent(doc, finding.agentId);
        if (entry === undefined || !this.growHeader) continue;
        const keys = entry.newerKeys ?? (entry.newerKeys = []);
        const suffix = rejectedKeyEntry(finding.suffix);
        if (keys.includes(suffix)) continue;
        if (keys.length >= this.limits.rejectionsBeforePause) { if (entry.paused === false) entry.paused = { reason: "newer", at: this.now().toISOString() }; continue; }
        keys.push(suffix);
        entry.newerV = Math.max(entry.newerV ?? 0, finding.recordV);
        continue;
      }
      if (doc.rows[finding.key] !== undefined || this.isRetired(doc, finding.key)) continue;
      if (finding.kind === "agent") {
        const entry = this.ensureAgent(doc, finding.agentId);
        if (entry === undefined || entry.paused !== false || entry.rejectedKeys.includes(rejectedKeyEntry(basename(finding.key)))) continue;
        if (entry.rows >= this.limits.liveRowsPerAgent) { entry.paused = { reason: "row-cap", at: this.now().toISOString() }; continue; }
        const size = bytesOf(finding.row);
        if (agentBytes + size > agentBudget) continue; // deferred: agent rows may not crowd out web rows
        const decision = decideClaim(doc.rows, finding.key, finding.row);
        if (!decision.admit) { this.recordRejection(doc, finding.agentId, basename(finding.key), "proof"); continue; }
        for (const key of decision.displaced) { agentBytes -= bytesOf(doc.rows[key]); this.displace(doc, key); }
        doc.rows[finding.key] = finding.row;
        entry.rows++;
        entry.did ??= finding.did;
        agentBytes += size;
        if (entry.rows >= this.limits.liveRowsPerAgent && entry.paused === false) entry.paused = { reason: "row-cap", at: this.now().toISOString() };
        onAdmit();
        continue;
      }
      const decision = decideClaim(doc.rows, finding.key, finding.row);
      if (!decision.admit) {
        // A migrated import that loses precedence stays visible as needs-attention with no claim, so it is not refetched.
        if (finding.row.pv === "migrated") {
          const { cid: _cid, cc: _cc, ...claimless } = finding.row;
          doc.rows[finding.key] = { ...claimless, na: true };
        }
        continue;
      }
      for (const key of decision.displaced) { agentBytes -= bytesOf(doc.rows[key]); this.displace(doc, key); }
      doc.rows[finding.key] = finding.row;
      onAdmit();
    }
  }

  // -------------------------------------------------------------------------
  // Status sync (§4): only node-confirmed revocation is sticky.

  async syncStatus(port: ShareStatusPort): Promise<{ readonly status: ShareIndexWriteStatus; readonly checked: number }> {
    const loaded = await this.load();
    if (loaded.status !== "ok") return { status: loaded.status === "read_only" ? "read_only" : "unavailable", checked: 0 };
    const results = new Map<string, "revoked" | "active">();
    let checked = 0;
    for (const [key, row] of Object.entries(loaded.doc.rows)) {
      if (checked >= this.limits.statusChecksPerSync) break;
      if (row.rk === "none" || row.r?.confirmed === true) continue;
      checked++;
      const status = await port.status(key, row);
      if (status !== "unknown") results.set(key, status);
    }
    const result = await this.update((doc) => {
      for (const [key, status] of results) {
        const row = doc.rows[key];
        if (row === undefined || row.r?.confirmed === true) continue;
        if (status === "revoked") doc.rows[key] = { ...row, r: { at: row.r?.at ?? this.now().toISOString(), confirmed: true } };
        else if (row.r !== undefined) { const { r: _r, ...rest } = row; doc.rows[key] = rest as ShareIndexRow; }
      }
    });
    return { status: result.status, checked };
  }

  // -------------------------------------------------------------------------
  // Compaction (§7): rows over their byte budget move to archives; the header never evicts rows.

  async compact(): Promise<{ readonly status: ShareIndexWriteStatus; readonly archived: number }> {
    const loaded = await this.load();
    if (loaded.status !== "ok") return { status: loaded.status === "read_only" ? "read_only" : "unavailable", archived: 0 };
    const doc = loaded.doc;
    const now = this.now().getTime();
    const sizes = new Map(Object.entries(doc.rows).map(([key, row]) => [key, bytesOf(row)] as const));
    let total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
    let agentTotal = Object.entries(doc.rows).filter(([, row]) => agentOf(row) !== undefined).reduce((sum, [key]) => sum + sizes.get(key)!, 0);
    const byAge = Object.entries(doc.rows).sort(([, left], [, right]) => Date.parse(left.c) - Date.parse(right.c));
    const chosen = new Set<string>();
    const take = (key: string): void => {
      if (chosen.has(key)) return;
      chosen.add(key);
      total -= sizes.get(key)!;
      if (agentOf(doc.rows[key]!) !== undefined) agentTotal -= sizes.get(key)!;
    };
    if (total > this.limits.mainRowBytes) {
      for (const [key, row] of byAge) {
        if (total <= this.limits.mainRowBytes) break;
        const done = row.r !== undefined || Date.parse(row.x) <= now;
        if (done && now - Date.parse(row.c) > this.limits.archiveAgeMs) take(key);
      }
      for (const [key, row] of byAge) {
        if (total <= this.limits.mainRowBytes || agentTotal <= this.limits.mainRowBytes * this.limits.agentRowShare) break;
        if (agentOf(row) !== undefined) take(key);
      }
      for (const [key] of byAge) {
        if (total <= this.limits.mainRowBytes) break;
        take(key);
      }
    }
    // Archive documents first, so a crash leaves rows in both places, never in neither.
    const groups = new Map<string, Record<string, ShareIndexRow>>();
    for (const key of chosen) {
      const row = doc.rows[key]!;
      const name = `archive-${new Date(Date.parse(row.c) || now).getUTCFullYear()}`;
      const group = groups.get(name) ?? {};
      group[key] = row;
      groups.set(name, group);
    }
    for (const [name, rows] of groups) {
      await runCas(`_index/${name}`, this.cas, async () => {
        const read = await this.backend.readVault(`_index/${name}`);
        if (read.status === "unavailable" || (read.status === "corrupt" && read.etag === undefined)) throw new Error("archive document is unavailable");
        const existing = read.status === "ok" ? parseArchiveDocument(read.value) : undefined;
        const merged = { ...(existing ?? { v: 1 }), rows: { ...(existing?.rows ?? {}), ...rows } };
        const condition = read.status === "ok" || read.status === "corrupt" ? { ifMatch: read.etag! } : { ifNoneMatch: "*" as const };
        return { write: await this.backend.writeVault(`_index/${name}`, merged, condition), onSuccess: () => undefined };
      });
    }
    // Tombstones past their TTL are dropped once the record is gone.
    const expiredTombstones: string[] = [];
    for (const tombstone of doc.tombstones) {
      if (now - Date.parse(tombstone.at) <= this.limits.tombstoneTtlMs) continue;
      const classified = classifyRecordKey(tombstone.key);
      const gone = classified.kind === "agent" ? (await this.backend.readRaw(tombstone.key)).status === "not_found" : (await this.backend.readVault(tombstone.key)).status === "not_found";
      if (gone) expiredTombstones.push(tombstone.key);
    }
    const result = await this.update((working) => {
      for (const [name, rows] of groups) {
        let archive = working.archives.find((item) => item.name === name);
        if (archive === undefined) working.archives.push(archive = { name, ids: [] });
        for (const key of Object.keys(rows)) {
          const row = working.rows[key];
          if (row !== undefined) this.displaceForDelete(working, key, row);
          if (!archive.ids.includes(key)) archive.ids.push(key);
        }
      }
      working.tombstones = working.tombstones.filter((tombstone) => !expiredTombstones.includes(tombstone.key));
    });
    return { status: result.status, archived: chosen.size };
  }
}
