import {
  ISessionStorage,
  PersistedSessionData,
  validatePersistedSessionData,
} from "@tinycloud/sdk-core";

const STORAGE_PREFIX = "tinycloud:session:";

export type BrowserSessionLoadStatus =
  | "loaded"
  | "missing"
  | "expired"
  | "corrupt"
  | "storage-unavailable";

export type BrowserSessionLoadResult =
  | { status: "loaded"; data: PersistedSessionData }
  | { status: Exclude<BrowserSessionLoadStatus, "loaded">; data: null };

export type BrowserSessionSelectionResult =
  | { status: "loaded"; address: string; data: PersistedSessionData }
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
    this.storage.setItem(this.key(address), JSON.stringify(data));
    return Promise.resolve();
  }

  load(address: string): Promise<PersistedSessionData | null> {
    return this.loadWithStatus(address).then((result) =>
      result.status === "loaded" ? result.data : null,
    );
  }

  async loadWithStatus(address: string): Promise<BrowserSessionLoadResult> {
    if (!this.storage) return { status: "storage-unavailable", data: null };

    const key = this.key(address);
    const raw = this.storage.getItem(key);
    if (!raw) return { status: "missing", data: null };

    try {
      const parsed = JSON.parse(raw);
      const result = validatePersistedSessionData(parsed);
      if (!result.ok) {
        this.storage.removeItem(key);
        return { status: "corrupt", data: null };
      }

      if (!result.data.tinycloudSession?.spaceId) {
        this.storage.removeItem(key);
        return { status: "corrupt", data: null };
      }

      try {
        const jwk = JSON.parse(result.data.sessionKey);
        if (jwk === null || typeof jwk !== "object") {
          throw new Error("not an object");
        }
      } catch {
        this.storage.removeItem(key);
        return { status: "corrupt", data: null };
      }

      const expiresAt = new Date(result.data.expiresAt);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        this.storage.removeItem(key);
        return { status: "expired", data: null };
      }

      return { status: "loaded", data: result.data };
    } catch {
      this.storage.removeItem(key);
      return { status: "corrupt", data: null };
    }
  }

  /**
   * Load the only valid account session in this app's storage namespace.
   *
   * This deliberately does not consult a wallet provider. If more than one
   * account session is present, there is no unambiguous signed-in identity and
   * callers must keep using the accountless path until the app activates one.
   */
  async loadUnambiguousWithStatus(): Promise<BrowserSessionSelectionResult> {
    if (!this.storage) return { status: "storage-unavailable", data: null };
    const addresses: string[] = [];
    try {
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index);
        if (key === null || !key.startsWith(this.keyPrefix)) continue;
        const address = key.slice(this.keyPrefix.length);
        if (/^0x[a-f0-9]{40}$/.test(address)) addresses.push(address);
      }
    } catch {
      return { status: "storage-unavailable", data: null };
    }

    const loaded: { address: string; data: PersistedSessionData }[] = [];
    for (const address of addresses) {
      const result = await this.loadWithStatus(address);
      if (result.status === "loaded" && result.data.address.toLowerCase() === address) {
        loaded.push({ address: result.data.address, data: result.data });
      }
    }
    return loaded.length === 1
      ? { status: "loaded", ...loaded[0]! }
      : { status: "missing", data: null };
  }

  clear(address: string): Promise<void> {
    this.storage?.removeItem(this.key(address));
    return Promise.resolve();
  }

  exists(address: string): boolean {
    if (!this.storage) return false;
    const raw = this.storage.getItem(this.key(address));
    if (!raw) return false;

    try {
      const parsed = JSON.parse(raw);
      const result = validatePersistedSessionData(parsed);
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
