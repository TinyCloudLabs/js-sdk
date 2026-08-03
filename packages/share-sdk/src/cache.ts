import { sha256 } from "@noble/hashes/sha256";

export interface ShareCacheKey {
  readonly cid: string;
  readonly expiresAt: string;
}

export interface ShareCacheMetadata {
  readonly contentType: string;
  readonly size: number;
  readonly encrypted: boolean;
}

export interface ShareCacheEntry {
  readonly key: ShareCacheKey;
  readonly bytes: Uint8Array;
  readonly digest: Uint8Array;
  readonly metadata: ShareCacheMetadata;
}

export interface ShareCache {
  get(key: ShareCacheKey, now?: Date): Promise<Uint8Array | undefined>;
  /** Retrieve a valid entry without a process-local expiry index. */
  getByCid?(cid: string, now?: Date): Promise<ShareCacheEntry | undefined>;
  set(key: ShareCacheKey, bytes: Uint8Array, metadata: ShareCacheMetadata): Promise<void>;
  delete(key: ShareCacheKey): Promise<void>;
  clear(): Promise<void>;
}

function cacheKey(key: ShareCacheKey): string {
  if (!key.cid || !key.expiresAt) throw new Error("share cache keys require CID and expiry");
  return `${key.cid}\0${key.expiresAt}`;
}

function digest(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

/**
 * A deliberately memory-only cache. It stores verified artifact bytes and
 * non-secret metadata only; fragment keys, presentations, sessions, and
 * decrypted content never cross this boundary.
 */
export class MemoryShareCache implements ShareCache {
  private readonly entries = new Map<string, ShareCacheEntry>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async get(key: ShareCacheKey, now = new Date()): Promise<Uint8Array | undefined> {
    const mapKey = cacheKey(key);
    const entry = this.entries.get(mapKey);
    if (entry === undefined) return undefined;
    if (Date.parse(entry.key.expiresAt) <= now.getTime() || !equalBytes(entry.digest, digest(entry.bytes))) {
      this.entries.delete(mapKey);
      return undefined;
    }
    return entry.bytes.slice();
  }

  async getByCid(cid: string, now = new Date()): Promise<ShareCacheEntry | undefined> {
    const entries = [...this.entries.values()].filter((entry) => entry.key.cid === cid);
    for (const entry of entries) {
      if (Date.parse(entry.key.expiresAt) <= now.getTime() || !equalBytes(entry.digest, digest(entry.bytes))) {
        this.entries.delete(cacheKey(entry.key));
        continue;
      }
      return {
        key: { ...entry.key },
        bytes: entry.bytes.slice(),
        digest: entry.digest.slice(),
        metadata: { ...entry.metadata },
      };
    }
    return undefined;
  }

  async set(key: ShareCacheKey, bytes: Uint8Array, metadata: ShareCacheMetadata): Promise<void> {
    if (Date.parse(key.expiresAt) <= this.now().getTime()) return;
    this.entries.set(cacheKey(key), {
      key: { cid: key.cid, expiresAt: key.expiresAt },
      bytes: bytes.slice(),
      digest: digest(bytes),
      metadata: { ...metadata },
    });
  }

  async delete(key: ShareCacheKey): Promise<void> {
    this.entries.delete(cacheKey(key));
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}
