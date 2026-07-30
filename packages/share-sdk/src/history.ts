import type { DelegatedShareKey, OwnerShareAction, OwnerShareMatcher, OwnerSharePolicyRegistrationReceipt } from "./owner-policy";
import { restoreDelegatedShareKey } from "./owner-policy";
import type { PublishedShare } from "./publish.js";

export interface EncryptedShareHistoryStorage {
  put(value: Uint8Array): Promise<void>;
  list(): Promise<readonly Uint8Array[]>;
  clear(): Promise<void>;
}

export class MemoryEncryptedShareHistoryStorage implements EncryptedShareHistoryStorage {
  private readonly values: Uint8Array[] = [];
  async put(value: Uint8Array): Promise<void> { this.values.push(value.slice()); }
  async list(): Promise<readonly Uint8Array[]> { return this.values.map((value) => value.slice()); }
  async clear(): Promise<void> { this.values.length = 0; }
}

/**
 * The durable record a sender needs, after a reload, to display and manage
 * a share it created. Every identity/CID here comes verbatim from the
 * Node-verified {@link OwnerSharePolicyRegistrationReceipt}; nothing is
 * re-derived or guessed.
 */
export interface SenderShareRecord {
  readonly shareId: string;
  readonly registrationCid?: string;
  readonly policyCid?: string;
  readonly ownerDelegationCid?: string;
  readonly enforcementDelegationCid?: string;
  readonly shareKeyDid?: string;
  readonly ownerDid?: string;
  readonly enforcerDid?: string;
  readonly target: { readonly origin: string; readonly nodeAudience: string; readonly spaceId: string };
  readonly resource: { readonly kind: "exact" | "prefix"; readonly path: string };
  readonly actions: readonly OwnerShareAction[];
  readonly recipientMatcher: OwnerShareMatcher;
  /** The signed target discriminator, retained separately from the email matcher. */
  readonly targetKind?: "bearer" | "recipientDid" | "email" | "emailDomain";
  readonly registeredAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly envelopeCid?: string;
  readonly shareCid?: string;
  /** Complete bearer links are encrypted at rest and only revealed explicitly. */
  readonly link?: string;
  readonly filename?: string;
}

/** Create the durable encrypted-history shape from canonical publication receipts. */
export function historyRecordForPublishedShare(result: PublishedShare, now: Date = new Date()): SenderShareRecord {
  const target = result.metadata.target.kind;
  const supplied = result.metadata.recipientMatcher;
  let matcher: OwnerShareMatcher;
  if (supplied?.kind === "recipientDid" && typeof supplied.value === "string") matcher = { kind: "recipientDid", value: supplied.value };
  else if (supplied?.kind === "exactEmail" && typeof supplied.value === "string") matcher = { kind: "exactEmail", value: supplied.value };
  else if (supplied?.kind === "emailDomain" && typeof supplied.value === "string") matcher = { kind: "emailDomain", value: supplied.value };
  else if (target === "recipientDid") matcher = { kind: "recipientDid", value: "" };
  else if (target === "email") matcher = { kind: "exactEmail", value: "" };
  else if (target === "emailDomain") matcher = { kind: "emailDomain", value: "" };
  else matcher = { kind: "bearer" };
  return {
    shareId: result.metadata.shareId,
    target: result.metadata.target,
    resource: result.metadata.resource,
    actions: result.metadata.actions.map((action) =>
      action === "read" ? "tinycloud.kv/get"
        : action === "list" ? "tinycloud.kv/list"
          : action === "edit" ? "tinycloud.kv/put"
            : action,
    ) as OwnerShareAction[],
    recipientMatcher: matcher,
    targetKind: target,
    ...(result.metadata.registrationCid === undefined ? {} : { registrationCid: result.metadata.registrationCid }),
    ...(result.metadata.policyCid === undefined ? {} : { policyCid: result.metadata.policyCid }),
    ...(result.metadata.ownerDelegationCid === undefined ? {} : { ownerDelegationCid: result.metadata.ownerDelegationCid }),
    ...(result.metadata.enforcementDelegationCid === undefined ? {} : { enforcementDelegationCid: result.metadata.enforcementDelegationCid }),
    ...(result.metadata.ownerDid === undefined ? {} : { ownerDid: result.metadata.ownerDid }),
    ...(result.metadata.shareKeyDid === undefined ? {} : { shareKeyDid: result.metadata.shareKeyDid }),
    ...(result.metadata.enforcerDid === undefined ? {} : { enforcerDid: result.metadata.enforcerDid }),
    ...(result.metadata.envelopeCid === undefined ? {} : { envelopeCid: result.metadata.envelopeCid }),
    ...(result.metadata.shareCid === undefined ? {} : { shareCid: result.metadata.shareCid }),
    registeredAt: now.toISOString(),
    expiresAt: result.metadata.expiresAt,
    link: result.url,
    ...(result.metadata.display.filename === undefined ? {} : { filename: result.metadata.display.filename }),
  };
}

/**
 * "direct" revokes only this share's enforcement delegation. "ancestor"
 * revokes the owner delegation the share descends from, which transitively
 * denies every share built on it (see `revocation_in_ancestry` in
 * `tinycloud-node-server/src/share_v2.rs`). Both are existing CIDs that a
 * caller passes to the node's generic `tinycloud.delegation/revoke`
 * invocation (`DelegationManager.revoke` / `TinyCloudNode.revokeDelegation`)
 * -- there is no share-v2-specific revoke route.
 */
export type SenderShareRevocationScope = "direct" | "ancestor";

export interface SenderShareRecordStorage {
  put(record: SenderShareRecord): Promise<void>;
  list(): Promise<readonly SenderShareRecord[]>;
  get(shareId: string): Promise<SenderShareRecord | undefined>;
  delete(shareId: string): Promise<void>;
}

export interface StoredSenderShareKey {
  readonly cryptoKey: CryptoKey;
  readonly publicKey: Uint8Array;
  readonly extractable: boolean;
}

export interface SenderShareKeyStorage {
  put(shareId: string, key: StoredSenderShareKey): Promise<void>;
  get(shareId: string): Promise<StoredSenderShareKey | undefined>;
  delete(shareId: string): Promise<void>;
}

/** In-memory reference implementation. Real deployments back these with IndexedDB so the non-extractable `CryptoKey` survives a reload via structured clone. */
export class MemorySenderShareRecordStorage implements SenderShareRecordStorage {
  private readonly records = new Map<string, SenderShareRecord>();

  async put(record: SenderShareRecord): Promise<void> {
    this.records.set(record.shareId, record);
  }

  async list(): Promise<readonly SenderShareRecord[]> {
    return [...this.records.values()];
  }

  async get(shareId: string): Promise<SenderShareRecord | undefined> {
    return this.records.get(shareId);
  }

  async delete(shareId: string): Promise<void> {
    this.records.delete(shareId);
  }
}

export class MemorySenderShareKeyStorage implements SenderShareKeyStorage {
  private readonly keys = new Map<string, StoredSenderShareKey>();

  async put(shareId: string, key: StoredSenderShareKey): Promise<void> {
    this.keys.set(shareId, key);
  }

  async get(shareId: string): Promise<StoredSenderShareKey | undefined> {
    return this.keys.get(shareId);
  }

  async delete(shareId: string): Promise<void> {
    this.keys.delete(shareId);
  }
}

export interface SenderShareStoreOptions {
  readonly records: SenderShareRecordStorage;
  readonly keys: SenderShareKeyStorage;
  readonly now?: () => Date;
}

/**
 * Reload-safe sender-side management for shares created through
 * {@link canonicalOwnerSharePolicy} / `registerOwnerSharePolicy`. Persists
 * the registration receipt's canonical identity tuple plus the ephemeral
 * share key's non-extractable `CryptoKey` handle, so a sender can list,
 * inspect, and revoke shares it created in an earlier session -- without
 * ever re-exporting private key material.
 */
export class SenderShareStore {
  private readonly records: SenderShareRecordStorage;
  private readonly keys: SenderShareKeyStorage;
  private readonly now: () => Date;

  constructor(options: SenderShareStoreOptions) {
    this.records = options.records;
    this.keys = options.keys;
    this.now = options.now ?? (() => new Date());
  }

  /** Persist a Node-verified registration receipt and its share key handle. */
  async save(receipt: OwnerSharePolicyRegistrationReceipt, key: DelegatedShareKey): Promise<SenderShareRecord> {
    const registration = receipt.registration;
    if (registration.shareKeyDid !== key.did) throw new Error("share key does not match the registered receipt");
    const record: SenderShareRecord = {
      shareId: registration.shareId,
      registrationCid: registration.registrationCid,
      policyCid: registration.policyCid,
      ownerDelegationCid: registration.ownerDelegationCid,
      enforcementDelegationCid: registration.enforcementDelegationCid,
      shareKeyDid: registration.shareKeyDid,
      ownerDid: registration.ownerDid,
      enforcerDid: registration.enforcerDid,
      target: registration.target,
      resource: registration.resource,
      actions: registration.actions,
      recipientMatcher: registration.recipientMatcher,
      targetKind: registration.recipientMatcher.kind === "recipientDid" ? "recipientDid" : registration.recipientMatcher.kind === "exactEmail" ? "email" : registration.recipientMatcher.kind === "emailDomain" ? "emailDomain" : "bearer",
      registeredAt: registration.registeredAt,
      expiresAt: registration.expiresAt,
    };
    await this.records.put(record);
    await this.keys.put(record.shareId, { cryptoKey: key.cryptoKey, publicKey: key.publicKey, extractable: key.extractable });
    return record;
  }

  /** List shares created in any session, most recent first. */
  async list(options?: { readonly includeRevoked?: boolean; readonly includeExpired?: boolean }): Promise<readonly SenderShareRecord[]> {
    const now = this.now().getTime();
    const records = await this.records.list();
    return records
      .filter((record) => (options?.includeRevoked ?? false) || record.revokedAt === undefined)
      .filter((record) => (options?.includeExpired ?? false) || Date.parse(record.expiresAt) > now)
      .sort((left, right) => Date.parse(right.registeredAt) - Date.parse(left.registeredAt));
  }

  async get(shareId: string): Promise<SenderShareRecord | undefined> {
    return this.records.get(shareId);
  }

  /** Recover a signer for the persisted share key after a reload. */
  async loadKey(shareId: string): Promise<DelegatedShareKey | undefined> {
    const stored = await this.keys.get(shareId);
    if (stored === undefined) return undefined;
    return restoreDelegatedShareKey({
      privateKey: stored.cryptoKey,
      publicKey: stored.publicKey,
      extractable: stored.extractable,
    });
  }

  /**
   * The delegation CID to pass to the node's existing generic
   * `tinycloud.delegation/revoke` invocation to revoke this share at the
   * requested scope. Does not itself call the node -- callers invoke
   * their own `revokeDelegation`/`DelegationManager.revoke` with the
   * returned CID, then call {@link markRevoked} once that succeeds.
   */
  async revocationTarget(shareId: string, scope: SenderShareRevocationScope): Promise<string> {
    const record = await this.records.get(shareId);
    if (record === undefined) throw new Error(`Unknown share: ${shareId}`);
    const delegationCid = scope === "direct" ? record.enforcementDelegationCid : record.ownerDelegationCid;
    if (delegationCid === undefined) throw new Error("share has no node-enforced delegation");
    return delegationCid;
  }

  /** Mark a share revoked locally after the caller's node-side revoke call succeeds. */
  async markRevoked(shareId: string, revokedAt: string = this.now().toISOString()): Promise<SenderShareRecord> {
    const record = await this.records.get(shareId);
    if (record === undefined) throw new Error(`Unknown share: ${shareId}`);
    const revoked: SenderShareRecord = { ...record, revokedAt };
    await this.records.put(revoked);
    return revoked;
  }

  /** Forget a share and clear its persisted key handle. */
  async remove(shareId: string): Promise<void> {
    await this.records.delete(shareId);
    await this.keys.delete(shareId);
  }
}

/** WebCrypto-backed persistence adapter; links and private material are absent. */
export class EncryptedSenderShareHistory {
  constructor(
    private readonly storage: EncryptedShareHistoryStorage,
    private readonly key: CryptoKey,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async put(record: SenderShareRecord): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const payload = new TextEncoder().encode(JSON.stringify(record));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, payload));
    const encoded = new Uint8Array(iv.length + ciphertext.length);
    encoded.set(iv); encoded.set(ciphertext, iv.length);
    await this.storage.put(encoded);
  }

  async list(): Promise<readonly SenderShareRecord[]> {
    const records: SenderShareRecord[] = [];
    for (const encoded of await this.storage.list()) {
      if (encoded.length <= 12) continue;
      try {
        const value = await crypto.subtle.decrypt({ name: "AES-GCM", iv: encoded.slice(0, 12) }, this.key, encoded.slice(12));
        const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)) as SenderShareRecord;
        if (typeof parsed.shareId === "string" && typeof parsed.expiresAt === "string") records.push(parsed);
      } catch {
        // Ignore corrupt/foreign records rather than returning unauthenticated data.
      }
    }
    return records;
  }

  async clear(): Promise<void> { await this.storage.clear(); }
}
