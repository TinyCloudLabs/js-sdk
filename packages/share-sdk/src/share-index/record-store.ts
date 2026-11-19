import type { SenderShareRecord, SenderShareRecordStorage } from "../history.js";
import type { AgentKeyMaterial } from "./agent-key.js";
import { AgentRecordError, MAX_AGENT_RECORD_BYTES, openAgentRecordAsAgent, parseStoredAgentRecord, sealAgentRecord } from "./agent-record.js";
import type { ShareIndexBackend } from "./backend.js";
import { DEFAULT_CAS_POLICY, runCas, ShareIndexCasError, type CasPolicy } from "./cas.js";
import { compactShareRecord, DeliveryMaterialError, expandShareRecord, type StoredShareRecord } from "./delivery.js";
import { agentIdFromDid, agentRecordKey, agentRecordPrefix, classifyRecordKey, isShareId, SHARE_RECORDS_VAULT_PREFIX } from "./ids.js";

/**
 * The space record store (design C §1, §3): canonical share records in the
 * owner's `applications` space. Two layouts behind the same
 * {@link SenderShareRecordStorage} interface:
 * - {@link WebShareRecordStore}: `records/<shareId>`, owner-network vault
 *   envelopes (web, owner-key CLI, Tier 2);
 * - {@link AgentShareRecordStore}: `records/agents/<agentId>/<shareId>`,
 *   double-wrapped agent records (Tier W). Lists use the explicit prefix with
 *   its trailing slash (V3-7).
 * `isShareId` is enforced on every put/get/update/delete. Updates are CAS
 * writes; every write of an agent record draws a fresh DEK and nonces.
 */

function assertShareId(shareId: string): void {
  if (!isShareId(shareId)) throw new TypeError("share id is invalid");
}

function isRecordShape(value: unknown): value is SenderShareRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "shareId" in value && isShareId(value.shareId);
}

export class WebShareRecordStore implements SenderShareRecordStorage {
  constructor(private readonly backend: ShareIndexBackend, private readonly cas: CasPolicy = DEFAULT_CAS_POLICY) {}

  async put(record: SenderShareRecord): Promise<void> {
    assertShareId(record.shareId);
    const result = await this.backend.writeVault(record.shareId, record);
    if (!result.ok) throw new ShareIndexCasError(result.code === "invalid_etag" ? "INVALID_ETAG" : "FAILED", `record write was refused (${result.code})`, record.shareId, 1);
  }

  async update(shareId: string, change: (record: SenderShareRecord) => SenderShareRecord | Promise<SenderShareRecord>): Promise<SenderShareRecord | undefined> {
    assertShareId(shareId);
    return runCas(shareId, this.cas, async () => {
      const read = await this.backend.readVault(shareId);
      if (read.status === "not_found") return { done: undefined };
      if (read.status !== "ok" || !isRecordShape(read.value)) throw new ShareIndexCasError("FAILED", "record read failed", shareId, 1);
      const next = await change(read.value);
      if (next.shareId !== shareId) throw new TypeError("a record update cannot change its share id");
      return { write: await this.backend.writeVault(shareId, next, { ifMatch: read.etag }), onSuccess: () => next };
    });
  }

  async get(shareId: string): Promise<SenderShareRecord | undefined> {
    assertShareId(shareId);
    const read = await this.backend.readVault(shareId);
    return read.status === "ok" && isRecordShape(read.value) && read.value.shareId === shareId ? read.value : undefined;
  }

  async list(): Promise<readonly SenderShareRecord[]> {
    const records: SenderShareRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.backend.listKeys("", cursor);
      if (page.status !== "ok") throw new Error("record list is unavailable");
      for (const key of page.keys) {
        const classified = classifyRecordKey(key);
        if (classified.kind !== "web") continue;
        const record = await this.get(classified.shareId);
        if (record !== undefined) records.push(record);
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return records;
  }

  async delete(shareId: string): Promise<void> {
    assertShareId(shareId);
    const result = await this.backend.deleteRecord(shareId);
    if (!result.ok) throw new ShareIndexCasError("FAILED", `record delete was refused (${result.code})`, shareId, 1);
  }
}

export interface AgentShareRecordStoreOptions {
  readonly backend: ShareIndexBackend;
  /** DID of the key that signs the agent's invocations and delegations. */
  readonly agentDid: string;
  /** KEK_a from the same key; absent for a remote-signer-only profile (records are then owner-readable only). */
  readonly agentKey?: AgentKeyMaterial;
  readonly cas?: CasPolicy;
}

export class AgentShareRecordStore implements SenderShareRecordStorage {
  readonly agentId: string;
  private readonly cas: CasPolicy;

  constructor(private readonly options: AgentShareRecordStoreOptions) {
    if (options.agentKey !== undefined && options.agentKey.agentDid !== options.agentDid) throw new TypeError("agent key does not belong to the agent DID");
    this.agentId = agentIdFromDid(options.agentDid);
    this.cas = options.cas ?? DEFAULT_CAS_POLICY;
  }

  /** Whether this profile can read its own records back (`kid` is set). */
  get canReadBack(): boolean {
    return this.options.agentKey !== undefined;
  }

  private location(shareId: string): { readonly key: string; readonly spaceId: string; readonly vaultKey: string } {
    const key = agentRecordKey(this.agentId, shareId);
    return { key, spaceId: this.options.backend.spaceId, vaultKey: `${SHARE_RECORDS_VAULT_PREFIX}${key}` };
  }

  private async seal(record: SenderShareRecord, location: { readonly spaceId: string; readonly vaultKey: string }): Promise<Readonly<Record<string, unknown>>> {
    // Each blob once: a v3 record drops its envelope and inline link (checked to be rebuildable) before sealing.
    let stored: StoredShareRecord;
    try { stored = await compactShareRecord(record); } catch (error) { throw error instanceof DeliveryMaterialError ? new AgentRecordError("shape") : error; }
    const sealed = await sealAgentRecord({
      plaintext: new TextEncoder().encode(JSON.stringify(stored)),
      spaceId: location.spaceId,
      vaultKey: location.vaultKey,
      agentDid: this.options.agentDid,
      ownerNetworkId: this.options.backend.ownerNetworkId,
      ownerWrap: this.options.backend.ownerWrap,
      ...(this.options.agentKey === undefined ? {} : { agentKey: this.options.agentKey }),
    });
    // The owner's reconciler refuses anything over the cap; refuse it here, before it is written.
    if (new TextEncoder().encode(JSON.stringify(sealed)).byteLength > MAX_AGENT_RECORD_BYTES) throw new AgentRecordError("size");
    return sealed as unknown as Readonly<Record<string, unknown>>;
  }

  private async open(bytes: Uint8Array, location: { readonly spaceId: string; readonly vaultKey: string }, shareId: string): Promise<SenderShareRecord> {
    const agentKey = this.options.agentKey;
    if (agentKey === undefined) throw new Error("this profile cannot read its share records back");
    const stored = parseStoredAgentRecord(bytes, { agentDid: this.options.agentDid, ownerNetworkId: this.options.backend.ownerNetworkId });
    const plaintext = await openAgentRecordAsAgent(stored, location, agentKey);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)); } catch { throw new AgentRecordError("shape"); }
    if (!isRecordShape(value) || value.shareId !== shareId) throw new AgentRecordError("shape");
    // The stored form back to the full record: the envelope reopened from the sealed material.
    try { return await expandShareRecord(value as StoredShareRecord); } catch { throw new AgentRecordError("shape"); }
  }

  /** Create or replace; each write is a fresh seal under CAS (If-None-Match `*` for a new key). */
  async put(record: SenderShareRecord): Promise<void> {
    assertShareId(record.shareId);
    const location = this.location(record.shareId);
    await runCas(location.key, this.cas, async () => {
      const read = await this.options.backend.readRaw(location.key);
      if (read.status === "unavailable") throw new ShareIndexCasError("FAILED", "record read failed", location.key, 1);
      const condition = read.status === "ok" ? { ifMatch: read.etag } : { ifNoneMatch: "*" as const };
      return { write: await this.options.backend.writeRaw(location.key, await this.seal(record, location), condition), onSuccess: () => undefined };
    });
  }

  /** CAS update with the etag from the agent's own read (for example its own `revokedAt`). */
  async update(shareId: string, change: (record: SenderShareRecord) => SenderShareRecord | Promise<SenderShareRecord>): Promise<SenderShareRecord | undefined> {
    assertShareId(shareId);
    const location = this.location(shareId);
    return runCas(location.key, this.cas, async () => {
      const read = await this.options.backend.readRaw(location.key);
      if (read.status === "not_found") return { done: undefined };
      if (read.status !== "ok") throw new ShareIndexCasError("FAILED", "record read failed", location.key, 1);
      const next = await change(await this.open(read.bytes, location, shareId));
      if (next.shareId !== shareId) throw new TypeError("a record update cannot change its share id");
      return { write: await this.options.backend.writeRaw(location.key, await this.seal(next, location), { ifMatch: read.etag }), onSuccess: () => next };
    });
  }

  async get(shareId: string): Promise<SenderShareRecord | undefined> {
    assertShareId(shareId);
    const location = this.location(shareId);
    const read = await this.options.backend.readRaw(location.key);
    if (read.status === "not_found") return undefined;
    if (read.status !== "ok") throw new Error("record read failed");
    return this.open(read.bytes, location, shareId);
  }

  /** Lists the explicit `agents/<agentId>/` prefix (trailing slash: `list({})` would be refused). */
  async list(): Promise<readonly SenderShareRecord[]> {
    const prefix = agentRecordPrefix(this.agentId);
    const records: SenderShareRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.options.backend.listKeys(prefix, cursor);
      if (page.status !== "ok") throw new Error("record list is unavailable");
      for (const key of page.keys) {
        const classified = classifyRecordKey(key);
        if (classified.kind !== "agent" || classified.agentId !== this.agentId) continue;
        try {
          const record = await this.get(classified.shareId);
          if (record !== undefined) records.push(record);
        } catch (error) {
          if (!(error instanceof AgentRecordError)) throw error;
        }
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return records;
  }

  /** Tier W has no delete grant on its prefix; the owner deletes agent records. */
  async delete(_shareId: string): Promise<void> {
    throw new Error("agent share records are deleted by the owner, not the agent");
  }
}
