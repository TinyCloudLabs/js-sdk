/**
 * IDataVaultService - Interface for the Data Vault (encrypted KV) service.
 *
 * Platform-agnostic interface for encrypted key-value storage with
 * client-side encryption, key management, and sharing via grants.
 */

import type { IService, Result } from "../types";
import type {
  VaultEntry,
  VaultError,
  VaultPutOptions,
  VaultGetOptions,
  VaultListOptions,
  VaultGrantOptions,
} from "./types";

/**
 * Data Vault service interface.
 *
 * Provides encrypted key-value storage with:
 * - Client-side encryption (data is encrypted before leaving the device)
 * - Result type pattern (no throwing)
 * - Key management and rotation
 * - Sharing via grants (re-encrypt to recipient's public key)
 *
 * @example
 * ```typescript
 * // Unlock the vault (derives encryption keys)
 * await vault.unlock(signer);
 *
 * // Store encrypted data
 * const result = await vault.put('medical/records', { bloodType: 'O+' });
 *
 * // Retrieve and decrypt
 * const entry = await vault.get<{ bloodType: string }>('medical/records');
 * if (entry.ok) {
 *   console.log(entry.data.value.bloodType); // 'O+'
 * }
 *
 * // Share with another user
 * await vault.grant('medical/records', recipientDID);
 * ```
 */
export interface IDataVaultService extends IService {
  /**
   * Unlock the vault. Derives keys from wallet signatures.
   * Signer is optional when cached signatures exist (browser only).
   */
  unlock(signer?: unknown): Promise<Result<void, VaultError>>;

  /**
   * Clear the cached vault signature.
   * @param spaceId - Clear only this space's cache. If omitted, clears all.
   */
  clearCache(spaceId?: string): Promise<void>;

  /** Lock the vault, clearing all key material from memory. */
  lock(): void;

  /** Whether the vault is currently unlocked. */
  readonly isUnlocked: boolean;

  // =========================================================================
  // Core Operations
  // =========================================================================

  /**
   * Encrypt and store a value at the given key.
   *
   * @param key - The key to store under
   * @param value - The value to encrypt and store
   * @param options - Optional put configuration
   */
  put(
    key: string,
    value: unknown,
    options?: VaultPutOptions
  ): Promise<Result<void, VaultError>>;

  /**
   * Retrieve and decrypt a value by key.
   *
   * @param key - The key to retrieve
   * @param options - Optional get configuration
   * @returns Result with the decrypted entry
   */
  get<T = unknown>(
    key: string,
    options?: VaultGetOptions<T>
  ): Promise<Result<VaultEntry<T>, VaultError>>;

  /**
   * Delete an encrypted key.
   *
   * @param key - The key to delete
   */
  delete(key: string): Promise<Result<void, VaultError>>;

  /**
   * List vault keys with optional prefix filtering.
   *
   * @param options - Optional list configuration
   * @returns Result with array of key names
   */
  list(options?: VaultListOptions): Promise<Result<string[], VaultError>>;

  /**
   * Get envelope metadata for a key without decrypting the value.
   *
   * @param key - The key to inspect
   * @returns Result with metadata headers
   */
  head(key: string): Promise<Result<Record<string, string>, VaultError>>;

  // =========================================================================
  // Batch Operations
  // =========================================================================

  /**
   * Encrypt and store multiple entries.
   *
   * @param entries - Array of key/value pairs with optional per-entry options
   * @returns Array of results, one per entry
   */
  putMany(
    entries: Array<{ key: string; value: unknown; options?: VaultPutOptions }>
  ): Promise<Result<void, VaultError>[]>;

  /**
   * Retrieve and decrypt multiple keys.
   *
   * @param keys - Array of keys to retrieve
   * @param options - Optional get configuration applied to all entries
   * @returns Array of results, one per key
   */
  getMany<T = unknown>(
    keys: string[],
    options?: VaultGetOptions<T>
  ): Promise<Result<VaultEntry<T>, VaultError>[]>;

  // =========================================================================
  // Sharing
  // =========================================================================

  /**
   * Grant access to a vault key for another user.
   * Re-encrypts the data key to the recipient's public key.
   *
   * @deprecated Use reencrypt() instead.
   * @param key - The key to share
   * @param recipientDID - The recipient's primary DID (did:pkh:...)
   * @param options - Optional grant configuration
   */
  grant(
    key: string,
    recipientDID: string,
    options?: VaultGrantOptions
  ): Promise<Result<void, VaultError>>;

  /**
   * Re-encrypt a vault key for another user (renamed from grant).
   * Re-encrypts the data key to the recipient's public key.
   *
   * @param key - The key to share
   * @param recipientDID - The recipient's primary DID (did:pkh:...)
   * @param options - Optional grant configuration
   */
  reencrypt(
    key: string,
    recipientDID: string,
    options?: VaultGrantOptions
  ): Promise<Result<void, VaultError>>;

  /**
   * Revoke a previously issued grant.
   *
   * @param key - The key to revoke access to
   * @param recipientDID - The recipient whose access to revoke
   */
  revoke(
    key: string,
    recipientDID: string
  ): Promise<Result<void, VaultError>>;

  /**
   * List DIDs that have been granted access to a key.
   *
   * @param key - The key to list grants for
   * @returns Result with array of recipient DIDs
   */
  listGrants(key: string): Promise<Result<string[], VaultError>>;

  /**
   * Retrieve and decrypt a value shared by another user.
   *
   * @param grantorDID - The DID of the user who shared the data
   * @param key - The key that was shared
   * @param options - Optional get configuration
   * @returns Result with the decrypted entry
   */
  getShared<T = unknown>(
    grantorDID: string,
    key: string,
    options?: VaultGetOptions<T>
  ): Promise<Result<VaultEntry<T>, VaultError>>;

  // =========================================================================
  // Key Management
  // =========================================================================

  /** The vault's public encryption key (X25519). */
  readonly publicKey: Uint8Array;

  /**
   * Resolve another user's public encryption key from their DID.
   *
   * @param did - The DID to resolve
   * @returns Result with the public key bytes
   */
  resolvePublicKey(did: string): Promise<Result<Uint8Array, VaultError>>;
}
