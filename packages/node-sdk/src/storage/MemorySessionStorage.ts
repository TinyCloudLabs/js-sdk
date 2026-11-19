import { ISessionStorage, PersistedSessionData, registerOwnedSessionStorage } from "@tinycloud/sdk-core";

/**
 * In-memory session storage for Node.js.
 *
 * Sessions are stored in memory and lost when the process exits.
 * Suitable for:
 * - Development and testing
 * - Stateless server deployments
 * - Short-lived processes
 *
 * @example
 * ```typescript
 * const storage = new MemorySessionStorage();
 * await storage.save("0x123...", sessionData);
 * const session = await storage.load("0x123...");
 * ```
 */
export class MemorySessionStorage implements ISessionStorage {
  private sessions: Map<string, PersistedSessionData> = new Map();
  private readonly retired = new Map<string, Set<string>>();

  constructor() {
    if (new.target !== MemorySessionStorage) return;
    registerOwnedSessionStorage(this, (address, signature) => {
      const key = address.toLowerCase();
      let retired = this.retired.get(key);
      if (!retired) this.retired.set(key, retired = new Set());
      retired.add(signature);
      if (this.sessions.get(key)?.signature === signature) this.sessions.delete(key);
    });
  }

  /**
   * Save a session for an address.
   */
  async save(address: string, session: PersistedSessionData): Promise<void> {
    const normalizedAddress = address.toLowerCase();
    if (this.retired.get(normalizedAddress)?.has(session.signature)) {
      throw new Error("Session was cancelled by sign-out.");
    }
    this.sessions.set(normalizedAddress, session);
  }

  /**
   * Load a session for an address.
   */
  async load(address: string): Promise<PersistedSessionData | null> {
    const normalizedAddress = address.toLowerCase();
    const session = this.sessions.get(normalizedAddress);

    if (!session) {
      return null;
    }

    // Check if session is expired
    const expiresAt = new Date(session.expiresAt);
    if (expiresAt < new Date()) {
      this.sessions.delete(normalizedAddress);
      return null;
    }

    return session;
  }

  /**
   * Clear a session for an address.
   */
  async clear(address: string): Promise<void> {
    const normalizedAddress = address.toLowerCase();
    this.sessions.delete(normalizedAddress);
  }

  /**
   * Check if a session exists for an address.
   */
  exists(address: string): boolean {
    const normalizedAddress = address.toLowerCase();
    const session = this.sessions.get(normalizedAddress);

    if (!session) {
      return false;
    }

    // Check if session is expired
    const expiresAt = new Date(session.expiresAt);
    if (expiresAt < new Date()) {
      this.sessions.delete(normalizedAddress);
      return false;
    }

    return true;
  }

  /**
   * Memory storage is always available.
   */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Clear all sessions.
   */
  clearAll(): void {
    this.sessions.clear();
  }

  /**
   * Get the number of stored sessions.
   */
  size(): number {
    return this.sessions.size;
  }
}
