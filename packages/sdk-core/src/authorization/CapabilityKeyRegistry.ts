/**
 * CapabilityKeyRegistry - Tracks keys and their capabilities for automatic key selection.
 *
 * The registry maintains mappings between:
 * - Keys and their associated delegations
 * - Capabilities (resource/action pairs) and the keys that can exercise them
 *
 * This enables automatic key selection when performing operations, choosing
 * the most appropriate key based on priority and validity.
 *
 * @packageDocumentation
 */

import type { Result, ServiceError } from "@tinycloud/sdk-services";
import { ok, err, serviceError } from "@tinycloud/sdk-services";
import type {
  KeyInfo,
  CapabilityEntry,
  Delegation,
  IngestOptions,
} from "../delegations/types";
import { actionContains } from "../capabilities";

// =============================================================================
// Service Name
// =============================================================================

const SERVICE_NAME = "capability-key-registry";

// =============================================================================
// Error Codes
// =============================================================================

/**
 * Error codes specific to CapabilityKeyRegistry operations.
 */
export const CapabilityKeyRegistryErrorCodes = {
  /** Key not found in registry */
  KEY_NOT_FOUND: "KEY_NOT_FOUND",
  /** No key available for the requested capability */
  NO_CAPABLE_KEY: "NO_CAPABLE_KEY",
  /** Delegation has expired */
  DELEGATION_EXPIRED: "DELEGATION_EXPIRED",
  /** Delegation has been revoked */
  DELEGATION_REVOKED: "DELEGATION_REVOKED",
  /** Invalid delegation data */
  INVALID_DELEGATION: "INVALID_DELEGATION",
  /** Key already registered */
  KEY_EXISTS: "KEY_EXISTS",
} as const;

export type CapabilityKeyRegistryErrorCode =
  (typeof CapabilityKeyRegistryErrorCodes)[keyof typeof CapabilityKeyRegistryErrorCodes];

// =============================================================================
// Storage Types
// =============================================================================

/**
 * Stored delegation with chain information.
 */
export interface StoredDelegationChain {
  /** The delegation itself */
  delegation: Delegation;
  /** Parent delegation CID if this is a sub-delegation */
  parentCid?: string;
  /** Key ID used to sign/exercise this delegation */
  keyId: string;
  /** When this was stored */
  storedAt: Date;
}

/**
 * Internal delegation store structure.
 */
interface DelegationStore {
  /** Delegations indexed by key ID */
  byKey: Map<string, Delegation[]>;
  /** Delegations indexed by CID. A single signed ReCap can carry many scopes. */
  byCid: Map<string, StoredDelegationChain[]>;
  /** Capability entries indexed by "resource|action" key */
  byCapability: Map<string, CapabilityEntry[]>;
}

// =============================================================================
// Interface
// =============================================================================

/**
 * Interface for the CapabilityKeyRegistry.
 *
 * Tracks keys and their capabilities for automatic key selection.
 */
export interface ICapabilityKeyRegistry {
  /**
   * Register a key with its associated delegations.
   *
   * @param key - Key information
   * @param delegations - Delegations granted to this key
   */
  registerKey(key: KeyInfo, delegations: Delegation[]): void;

  /**
   * Remove a key and all its associated delegations.
   *
   * @param keyId - The key ID to remove
   */
  removeKey(keyId: string): void;

  /**
   * Get a key that can exercise the specified capability.
   *
   * Uses the key selection algorithm:
   * 1. Filter keys that have the required capability
   * 2. Check delegation validity (not expired, not revoked)
   * 3. Sort by priority (session=0, main=1, ingested=2)
   * 4. Return highest priority valid key
   *
   * @param resource - Resource URI (e.g., "tinycloud://space-id/kv/my-data")
   * @param action - Action to perform (e.g., "tinycloud.kv/get")
   * @returns The best matching key, or null if none available
   */
  getKeyForCapability(resource: string, action: string): KeyInfo | null;

  /**
   * Get all registered capabilities.
   *
   * @returns All capability entries in the registry
   */
  getAllCapabilities(): CapabilityEntry[];

  /**
   * Get all delegations for a specific key.
   *
   * @param keyId - The key ID
   * @returns Array of delegations for this key
   */
  getDelegationsForKey(keyId: string): Delegation[];

  /**
   * Ingest a key and delegation from an external source (e.g., sharing link).
   *
   * @param key - Key information to ingest
   * @param delegation - Delegation to associate with the key
   * @param options - Ingestion options
   */
  ingestKey(
    key: KeyInfo,
    delegation: Delegation,
    options?: IngestOptions
  ): void;

  /**
   * Check if a delegation is currently valid.
   *
   * @param delegation - The delegation to check
   * @returns true if valid, false if expired or revoked
   */
  isDelegationValid(delegation: Delegation): boolean;

  /**
   * Get a key by its ID.
   *
   * @param keyId - The key ID
   * @returns The key info, or undefined if not found
   */
  getKey(keyId: string): KeyInfo | undefined;

  /**
   * Get all registered keys.
   *
   * @returns Array of all registered keys
   */
  getAllKeys(): KeyInfo[];

  /**
   * Clear all registered keys and delegations.
   */
  clear(): void;

  /**
   * Revoke a delegation by CID.
   *
   * @param cid - The delegation CID to revoke
   * @returns Result indicating success or failure
   */
  revokeDelegation(cid: string): Result<void, ServiceError>;

  /**
   * Find capabilities that match a resource path pattern.
   *
   * @param resourcePattern - Resource pattern (supports wildcards)
   * @param action - Optional action filter
   * @returns Matching capability entries
   */
  findCapabilities(
    resourcePattern: string,
    action?: string
  ): CapabilityEntry[];
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * CapabilityKeyRegistry - Tracks keys and their capabilities for automatic key selection.
 *
 * @example
 * ```typescript
 * const registry = new CapabilityKeyRegistry();
 *
 * // Register a session key with its delegations
 * registry.registerKey(sessionKey, [rootDelegation]);
 *
 * // Get the best key for an operation
 * const key = registry.getKeyForCapability(
 *   "tinycloud://my-space/kv/data",
 *   "tinycloud.kv/get"
 * );
 *
 * if (key) {
 *   // Use this key for the operation
 *   console.log("Using key:", key.id);
 * }
 * ```
 */
export class CapabilityKeyRegistry implements ICapabilityKeyRegistry {
  /**
   * Registry of all keys indexed by ID.
   */
  private keys: Map<string, KeyInfo> = new Map();

  /**
   * Delegation storage.
   */
  private store: DelegationStore = {
    byKey: new Map(),
    byCid: new Map(),
    byCapability: new Map(),
  };

  // ===========================================================================
  // Key Management
  // ===========================================================================

  /**
   * Register a key with its associated delegations.
   *
   * @param key - Key information
   * @param delegations - Delegations granted to this key
   */
  registerKey(key: KeyInfo, delegations: Delegation[]): void {
    // Store the key
    this.keys.set(key.id, key);

    // Initialize delegation storage for this key
    if (!this.store.byKey.has(key.id)) {
      this.store.byKey.set(key.id, []);
    }

    // Process each delegation
    for (const delegation of delegations) {
      this.addDelegation(key, delegation);
    }
  }

  /**
   * Remove a key and all its associated delegations.
   *
   * @param keyId - The key ID to remove
   */
  removeKey(keyId: string): void {
    // Get delegations for this key
    const delegations = this.store.byKey.get(keyId) || [];

    // Remove this key's entries without dropping other scopes from the same
    // signed ReCap.
    for (const delegation of delegations) {
      const chains = this.store.byCid.get(delegation.cid);
      if (!chains) continue;
      const remaining = chains.filter((chain) => chain.keyId !== keyId);
      if (remaining.length === 0) {
        this.store.byCid.delete(delegation.cid);
      } else {
        this.store.byCid.set(delegation.cid, remaining);
      }
    }

    // Remove from byCapability
    for (const [capKey, entries] of this.store.byCapability) {
      const filtered = entries.filter(
        (entry) => !entry.keys.some((k: KeyInfo) => k.id === keyId)
      );
      if (filtered.length === 0) {
        this.store.byCapability.delete(capKey);
      } else {
        // Remove this key from entries that have multiple keys
        for (const entry of filtered) {
          entry.keys = entry.keys.filter((k: KeyInfo) => k.id !== keyId);
        }
        this.store.byCapability.set(capKey, filtered.filter((e) => e.keys.length > 0));
      }
    }

    // Remove from byKey
    this.store.byKey.delete(keyId);

    // Remove the key itself
    this.keys.delete(keyId);
  }

  // ===========================================================================
  // Capability Lookup
  // ===========================================================================

  /**
   * Get a key that can exercise the specified capability.
   *
   * Key selection algorithm:
   * 1. Filter keys that have the required capability
   * 2. Check delegation validity (not expired, not revoked)
   * 3. Sort by priority (session=0, main=1, ingested=2)
   * 4. Return highest priority valid key
   *
   * @param resource - Resource URI
   * @param action - Action to perform
   * @returns The best matching key, or null if none available
   */
  getKeyForCapability(resource: string, action: string): KeyInfo | null {
    // Find matching capabilities
    const matchingEntries = this.findMatchingEntries(resource, action);

    if (matchingEntries.length === 0) {
      return null;
    }

    // Collect all valid keys from matching entries
    const validKeys: KeyInfo[] = [];

    for (const entry of matchingEntries) {
      // Check if the delegation is valid
      if (!this.isDelegationValid(entry.delegation)) {
        continue;
      }

      // Add keys from this entry
      for (const key of entry.keys) {
        if (!validKeys.some((k: KeyInfo) => k.id === key.id)) {
          validKeys.push(key);
        }
      }
    }

    if (validKeys.length === 0) {
      return null;
    }

    // Sort by priority (lower is better)
    validKeys.sort((a: KeyInfo, b: KeyInfo) => a.priority - b.priority);

    return validKeys[0];
  }

  /**
   * Get all registered capabilities.
   *
   * @returns All capability entries in the registry
   */
  getAllCapabilities(): CapabilityEntry[] {
    const all: CapabilityEntry[] = [];
    for (const entries of this.store.byCapability.values()) {
      all.push(...entries);
    }
    return all;
  }

  // ===========================================================================
  // Delegation Tracking
  // ===========================================================================

  /**
   * Get all delegations for a specific key.
   *
   * @param keyId - The key ID
   * @returns Array of delegations for this key
   */
  getDelegationsForKey(keyId: string): Delegation[] {
    return this.store.byKey.get(keyId) || [];
  }

  // ===========================================================================
  // Ingestion
  // ===========================================================================

  /**
   * Ingest a key and delegation from an external source.
   *
   * @param key - Key information to ingest
   * @param delegation - Delegation to associate with the key
   * @param options - Ingestion options
   */
  ingestKey(
    key: KeyInfo,
    delegation: Delegation,
    options?: IngestOptions
  ): void {
    // Apply priority override if specified
    const keyToStore: KeyInfo = options?.priority !== undefined
      ? { ...key, priority: options.priority }
      : key;

    // Store the key
    this.keys.set(keyToStore.id, keyToStore);

    // Initialize delegation storage
    if (!this.store.byKey.has(keyToStore.id)) {
      this.store.byKey.set(keyToStore.id, []);
    }

    // Add the delegation
    this.addDelegation(keyToStore, delegation);
  }

  // ===========================================================================
  // Validation
  // ===========================================================================

  /**
   * Check if a delegation is currently valid.
   *
   * @param delegation - The delegation to check
   * @returns true if valid, false if expired or revoked
   */
  isDelegationValid(delegation: Delegation): boolean {
    // Check if revoked
    if (delegation.isRevoked) {
      return false;
    }

    // Check expiry
    const now = new Date();
    if (delegation.expiry && delegation.expiry < now) {
      return false;
    }

    return true;
  }

  // ===========================================================================
  // Key Access
  // ===========================================================================

  /**
   * Get a key by its ID.
   *
   * @param keyId - The key ID
   * @returns The key info, or undefined if not found
   */
  getKey(keyId: string): KeyInfo | undefined {
    return this.keys.get(keyId);
  }

  /**
   * Get all registered keys.
   *
   * @returns Array of all registered keys
   */
  getAllKeys(): KeyInfo[] {
    return Array.from(this.keys.values());
  }

  // ===========================================================================
  // Clear
  // ===========================================================================

  /**
   * Clear all registered keys and delegations.
   */
  clear(): void {
    this.keys.clear();
    this.store.byKey.clear();
    this.store.byCid.clear();
    this.store.byCapability.clear();
  }

  // ===========================================================================
  // Revocation
  // ===========================================================================

  /**
   * Revoke a delegation by CID.
   *
   * @param cid - The delegation CID to revoke
   * @returns Result indicating success or failure
   */
  revokeDelegation(cid: string): Result<void, ServiceError> {
    const stored = this.store.byCid.get(cid);

    if (!stored || stored.length === 0) {
      return err(
        serviceError(
          CapabilityKeyRegistryErrorCodes.KEY_NOT_FOUND,
          `Delegation not found: ${cid}`,
          SERVICE_NAME
        )
      );
    }

    // A CID identifies the signed delegation as a whole, including every
    // scope reconstructed from its ReCap.
    for (const chain of stored) chain.delegation.isRevoked = true;
    for (const keyDelegations of this.store.byKey.values()) {
      for (const delegation of keyDelegations) {
        if (delegation.cid === cid) delegation.isRevoked = true;
      }
    }

    // Update in byCapability
    for (const entries of this.store.byCapability.values()) {
      for (const entry of entries) {
        if (entry.delegation.cid === cid) {
          entry.delegation.isRevoked = true;
        }
      }
    }

    return ok(undefined);
  }

  // ===========================================================================
  // Search
  // ===========================================================================

  /**
   * Find capabilities that match a resource path pattern.
   *
   * @param resourcePattern - Resource pattern (supports wildcards)
   * @param action - Optional action filter
   * @returns Matching capability entries
   */
  findCapabilities(
    resourcePattern: string,
    action?: string
  ): CapabilityEntry[] {
    const results: CapabilityEntry[] = [];

    for (const entries of this.store.byCapability.values()) {
      for (const entry of entries) {
        // Check action match if specified
        if (action && entry.action !== action) {
          continue;
        }

        // Check resource pattern match
        if (this.matchesResourcePattern(entry.resource, resourcePattern)) {
          results.push(entry);
        }
      }
    }

    return results;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Add a delegation to the store.
   *
   * @param key - The key associated with this delegation
   * @param delegation - The delegation to add
   */
  private addDelegation(key: KeyInfo, delegation: Delegation): void {
    // Add to byKey
    const keyDelegations = this.store.byKey.get(key.id) || [];
    if (!keyDelegations.some((d) => this.sameDelegationScope(d, delegation))) {
      keyDelegations.push(delegation);
      this.store.byKey.set(key.id, keyDelegations);
    }

    // Add to byCid
    const chains = this.store.byCid.get(delegation.cid) ?? [];
    if (!chains.some((chain) =>
      chain.keyId === key.id && this.sameDelegationScope(chain.delegation, delegation)
    )) {
      chains.push({
        delegation,
        parentCid: delegation.parentCid,
        keyId: key.id,
        storedAt: new Date(),
      });
      this.store.byCid.set(delegation.cid, chains);
    }

    // Add to byCapability for each action
    for (const action of delegation.actions) {
      const capKey = this.makeCapabilityKey(delegation.path, action);
      const entries = this.store.byCapability.get(capKey) || [];

      // Check if we already have an entry for this exact delegation
      const existingEntry = entries.find((e) =>
        this.sameDelegationScope(e.delegation, delegation)
      );

      if (existingEntry) {
        // Add this key if not already present
        if (!existingEntry.keys.some((k: KeyInfo) => k.id === key.id)) {
          existingEntry.keys.push(key);
          // Re-sort by priority
          existingEntry.keys.sort((a: KeyInfo, b: KeyInfo) => a.priority - b.priority);
        }
      } else {
        // Create new capability entry
        const entry: CapabilityEntry = {
          resource: delegation.path,
          action,
          keys: [key],
          delegation,
          expiresAt: delegation.expiry,
        };
        entries.push(entry);
        this.store.byCapability.set(capKey, entries);
      }
    }
  }

  /**
   * Create a capability key for indexing.
   *
   * @param resource - Resource path
   * @param action - Action
   * @returns Combined key string
   */
  private makeCapabilityKey(resource: string, action: string): string {
    return `${resource}|${action}`;
  }

  private sameDelegationScope(left: Delegation, right: Delegation): boolean {
    return left.cid === right.cid &&
      left.spaceId === right.spaceId &&
      left.path === right.path &&
      left.actions.length === right.actions.length &&
      left.actions.every((action) => right.actions.includes(action)) &&
      this.sameCaveats(left.caveats, right.caveats);
  }

  /** Caveats are part of the signed delegation scope, not registry metadata. */
  private sameCaveats(
    left: readonly Record<string, unknown>[] | undefined,
    right: readonly Record<string, unknown>[] | undefined,
  ): boolean {
    const canonicalize = (value: unknown): string => {
      if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        return JSON.stringify(value);
      }
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      if (typeof value === "object") {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).sort().map((key) =>
          `${JSON.stringify(key)}:${canonicalize(object[key])}`,
        ).join(",")}}`;
      }
      return JSON.stringify(value);
    };
    return canonicalize(left ?? []) === canonicalize(right ?? []);
  }

  /**
   * Find capability entries that match a resource and action.
   *
   * @param resource - Resource to match
   * @param action - Action to match
   * @returns Matching entries
   */
  private findMatchingEntries(
    resource: string,
    action: string
  ): CapabilityEntry[] {
    const results: CapabilityEntry[] = [];

    // Exact match
    const exactKey = this.makeCapabilityKey(resource, action);
    const exactEntries = this.store.byCapability.get(exactKey);
    if (exactEntries) {
      results.push(...exactEntries);
    }

    // Wildcard matches - check all entries for patterns that match this resource
    for (const [capKey, entries] of this.store.byCapability) {
      if (capKey === exactKey) continue; // Already handled

      for (const entry of entries) {
        // Check if the entry's action matches
        if (!this.actionMatches(entry.action, action)) {
          continue;
        }

        // Check if the entry's resource pattern matches the requested resource
        if (this.resourceMatchesPattern(resource, entry.resource)) {
          if (!results.some((r) =>
            this.sameDelegationScope(r.delegation, entry.delegation)
          )) {
            results.push(entry);
          }
        }
      }
    }

    return results;
  }

  /**
   * Check if an action pattern matches a specific action.
   *
   * @param pattern - Action pattern (may include wildcard like "tinycloud.kv/*")
   * @param action - Specific action to check
   * @returns true if pattern matches action
   */
  private actionMatches(pattern: string, action: string): boolean {
    return actionContains(pattern, action);
  }

  /**
   * Check if a resource matches a pattern.
   *
   * Patterns support:
   * - Exact match: "/kv/data" matches "/kv/data"
   * - Wildcard suffix: "/kv/*" matches "/kv/anything"
   * - Double wildcard: "/kv/**" matches "/kv/any/nested/path"
   *
   * @param resource - The specific resource being accessed
   * @param pattern - The pattern from the delegation
   * @returns true if resource matches pattern
   */
  private resourceMatchesPattern(resource: string, pattern: string): boolean {
    // Exact match
    if (pattern === resource) {
      return true;
    }

    // Double wildcard (**) - matches any nested path
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return resource.startsWith(prefix);
    }

    // Single wildcard (*) - matches one path segment
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      if (!resource.startsWith(prefix)) {
        return false;
      }
      const remainder = resource.slice(prefix.length);
      // Should be a single segment (no more slashes except possibly trailing)
      return !remainder.includes("/") || remainder === "/";
    }

    // Prefix match for paths ending with /
    if (pattern.endsWith("/") && resource.startsWith(pattern)) {
      return true;
    }

    return false;
  }

  /**
   * Check if a specific resource matches a resource pattern for searching.
   *
   * @param entryResource - The resource from a capability entry
   * @param searchPattern - The pattern to search for
   * @returns true if entry resource matches search pattern
   */
  private matchesResourcePattern(
    entryResource: string,
    searchPattern: string
  ): boolean {
    // Use the same logic as resourceMatchesPattern
    return this.resourceMatchesPattern(entryResource, searchPattern) ||
           this.resourceMatchesPattern(searchPattern, entryResource);
  }
}

/**
 * Create a new CapabilityKeyRegistry instance.
 *
 * @returns A new registry instance
 */
export function createCapabilityKeyRegistry(): ICapabilityKeyRegistry {
  return new CapabilityKeyRegistry();
}
