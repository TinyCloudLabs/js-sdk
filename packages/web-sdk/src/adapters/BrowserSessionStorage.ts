import {
  ISessionStorage,
  PersistedSessionData,
  validatePersistedSessionData,
} from "@tinycloud/sdk-core";
import type { PortableDelegation } from "@tinycloud/node-sdk/core";

const STORAGE_PREFIX = "tinycloud:session:";
const ACTIVE_ADDRESS_SUFFIX = "active-address";
const GRANTS_SEGMENT = "runtime-grants:";

/** A stored entry as a PortableDelegation, or undefined when it lacks the fields a restore needs. */
function toRuntimeGrant(entry: unknown): PortableDelegation | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  const header = record.delegationHeader as { Authorization?: unknown } | null | undefined;
  const expiry = typeof record.expiry === "string" ? new Date(record.expiry) : undefined;
  if (
    typeof record.cid !== "string" ||
    typeof record.delegateDID !== "string" ||
    typeof header?.Authorization !== "string" ||
    expiry === undefined ||
    !Number.isFinite(expiry.getTime())
  ) {
    return undefined;
  }
  return { ...record, expiry } as unknown as PortableDelegation;
}

export type BrowserSessionLoadStatus =
  | "loaded"
  | "missing"
  | "expired"
  | "corrupt"
  | "storage-unavailable";

export type BrowserSessionLoadResult =
  | { status: "loaded"; data: PersistedSessionData }
  | { status: Exclude<BrowserSessionLoadStatus, "loaded">; data: null };

export interface BrowserSessionStorageOptions {
  /** Storage backend. Defaults to globalThis.localStorage when available. */
  storage?: Storage;
  /** Prefix used to isolate sessions by app/origin/environment. */
  keyPrefix?: string;
}

export class BrowserSessionStorage implements ISessionStorage {
  private readonly storage?: Storage;
  private readonly keyPrefix: string;

  constructor(options: BrowserSessionStorageOptions = {}) {
    this.storage = options.storage ?? this.defaultStorage();
    this.keyPrefix = options.keyPrefix ?? STORAGE_PREFIX;
  }

  private defaultStorage(): Storage | undefined {
    return typeof globalThis.localStorage !== "undefined"
      ? globalThis.localStorage
      : undefined;
  }

  private key(address: string): string {
    return this.keyPrefix + address.toLowerCase();
  }

  private activeAddressKey(): string {
    return this.keyPrefix + ACTIVE_ADDRESS_SUFFIX;
  }

  private clearActiveAddress(address: string): void {
    if (this.storage?.getItem(this.activeAddressKey()) === address.toLowerCase()) {
      this.storage.removeItem(this.activeAddressKey());
    }
  }

  private assertPersistable(data: PersistedSessionData): void {
    const result = validatePersistedSessionData(data);
    if (!result.ok) {
      throw new Error("Invalid session data.");
    }
    if (!result.data.tinycloudSession?.spaceId) {
      throw new Error("Session data is missing TinyCloud delegation data.");
    }
    try {
      const jwk = JSON.parse(result.data.sessionKey);
      if (jwk === null || typeof jwk !== "object") {
        throw new Error("not an object");
      }
    } catch {
      throw new Error("Session data has an invalid session key.");
    }
    if (new Date(result.data.expiresAt).getTime() <= Date.now()) {
      throw new Error("Session data is expired.");
    }
  }

  save(address: string, data: PersistedSessionData): Promise<void> {
    if (!this.storage) return Promise.resolve();
    this.assertPersistable(data);
    const normalizedAddress = address.toLowerCase();
    this.storage.setItem(this.key(normalizedAddress), JSON.stringify(data));
    // A new session record has a new key; grants made to the previous key do not carry over.
    this.storage.removeItem(this.grantsKey(normalizedAddress));
    this.storage.setItem(this.activeAddressKey(), normalizedAddress);
    return Promise.resolve();
  }

  /** Most recently saved, still-valid session address for provider-free reloads. */
  activeAddress(): string | undefined {
    if (!this.storage) return undefined;
    const address = this.storage.getItem(this.activeAddressKey());
    if (address === null || !this.exists(address)) {
      this.storage.removeItem(this.activeAddressKey());
      return undefined;
    }
    return address;
  }

  load(address: string): Promise<PersistedSessionData | null> {
    return this.loadWithStatus(address).then((result) =>
      result.status === "loaded" ? result.data : null,
    );
  }

  private validateForNetworkRestore(parsed: unknown) {
    const result = validatePersistedSessionData(parsed);
    if (result.ok || parsed === null || typeof parsed !== "object" ||
      Array.isArray(parsed) || !Object.prototype.hasOwnProperty.call(parsed, "replicaStamp")) {
      return result;
    }
    // An invalid replica stamp cannot authorize local reads, but must not erase
    // an otherwise valid network session. Leave the stored bytes untouched.
    const { replicaStamp: _stamp, ...networkData } = parsed as Record<string, unknown>;
    return validatePersistedSessionData(networkData);
  }

  async loadWithStatus(address: string): Promise<BrowserSessionLoadResult> {
    if (!this.storage) return { status: "storage-unavailable", data: null };

    const key = this.key(address);
    const raw = this.storage.getItem(key);
    if (!raw) return { status: "missing", data: null };

    try {
      const parsed = JSON.parse(raw);
      const result = this.validateForNetworkRestore(parsed);
      if (!result.ok) {
        this.storage.removeItem(key);
        this.clearActiveAddress(address);
        return { status: "corrupt", data: null };
      }

      if (!result.data.tinycloudSession?.spaceId) {
        this.storage.removeItem(key);
        this.clearActiveAddress(address);
        return { status: "corrupt", data: null };
      }

      try {
        const jwk = JSON.parse(result.data.sessionKey);
        if (jwk === null || typeof jwk !== "object") {
          throw new Error("not an object");
        }
      } catch {
        this.storage.removeItem(key);
        this.clearActiveAddress(address);
        return { status: "corrupt", data: null };
      }

      const expiresAt = new Date(result.data.expiresAt);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        this.storage.removeItem(key);
        this.clearActiveAddress(address);
        return { status: "expired", data: null };
      }

      return { status: "loaded", data: result.data };
    } catch {
      this.storage.removeItem(key);
      this.clearActiveAddress(address);
      return { status: "corrupt", data: null };
    }
  }

  clear(address: string): Promise<void> {
    this.storage?.removeItem(this.key(address));
    this.storage?.removeItem(this.grantsKey(address));
    this.clearActiveAddress(address);
    return Promise.resolve();
  }

  private grantsKey(address: string): string {
    return `${this.keyPrefix}${GRANTS_SEGMENT}${address.toLowerCase()}`;
  }

  /**
   * Stores `grants` (runtime delegations to the stored session's key) beside the session record, in the same storage.
   * They are bearer proofs for that key, so they live and die with the session record: `save` of a new session,
   * `clear` and sign-out remove them, and `loadRuntimeGrants` returns none once the session is missing or expired.
   * An empty list removes the entry. A storage that refuses the write (quota, blocked) leaves the grants unsaved:
   * the grant then lasts until the page reloads. Never rejects.
   */
  saveRuntimeGrants(address: string, grants: readonly PortableDelegation[]): Promise<void> {
    try {
      this.writeRuntimeGrants(address, grants);
    } catch {
      // Grants that cannot be stored are lost on reload; the session is unaffected.
    }
    return Promise.resolve();
  }

  private writeRuntimeGrants(address: string, grants: readonly PortableDelegation[]): void {
    if (!this.storage) return;
    if (grants.length === 0) {
      this.storage.removeItem(this.grantsKey(address));
      return;
    }
    const stored = grants.map((grant) => ({ ...grant, expiry: grant.expiry.toISOString() }));
    this.storage.setItem(this.grantsKey(address), JSON.stringify(stored));
  }

  /**
   * The unexpired, well-formed grants saved for `address` while its session record is valid. Expired or malformed ones
   * are removed. Never rejects: an unreadable storage answers none.
   */
  loadRuntimeGrants(address: string): Promise<PortableDelegation[]> {
    try {
      return Promise.resolve(this.readRuntimeGrants(address));
    } catch {
      return Promise.resolve([]);
    }
  }

  private readRuntimeGrants(address: string): PortableDelegation[] {
    if (!this.storage) return [];
    const key = this.grantsKey(address);
    const raw = this.storage.getItem(key);
    if (raw === null) return [];
    if (!this.exists(address)) {
      this.storage.removeItem(key);
      return [];
    }
    const kept: PortableDelegation[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const entries = Array.isArray(parsed) ? parsed : [];
    for (const entry of entries) {
      const grant = toRuntimeGrant(entry);
      if (grant !== undefined && grant.expiry.getTime() > Date.now()) kept.push(grant);
    }
    if (kept.length !== entries.length || !Array.isArray(parsed)) {
      void this.saveRuntimeGrants(address, kept);
    }
    return kept;
  }

  exists(address: string): boolean {
    if (!this.storage) return false;
    const raw = this.storage.getItem(this.key(address));
    if (!raw) return false;

    try {
      const parsed = JSON.parse(raw);
      const result = this.validateForNetworkRestore(parsed);
      if (!result.ok) return false;
      return new Date(result.data.expiresAt).getTime() > Date.now();
    } catch {
      return false;
    }
  }

  isAvailable(): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem('__tc_test', '1');
      this.storage.removeItem('__tc_test');
      return true;
    } catch {
      return false;
    }
  }
}
