/**
 * Data Vault Service Types
 *
 * Type definitions for the Data Vault (encrypted KV) service operations.
 */

import type {
  DecryptCapabilityProof,
  IEncryptionService,
} from "../encryption";
import type { PermissionHint } from "../types";

export interface VaultNetworkEncryptionConfig {
  /** Default encryption network used for inline vault envelopes. */
  networkId: string;
  /** TinyCloud encryption module used for local encrypt and node-mediated decrypt. */
  service: IEncryptionService;
  /** Proof material presented to the encryption module for decrypt requests. */
  decryptCapabilityProof?:
    | DecryptCapabilityProof
    | (() => DecryptCapabilityProof | Promise<DecryptCapabilityProof>);
}

/**
 * Configuration for DataVaultService.
 */
export interface DataVaultConfig {
  /** Space ID for encrypted data storage */
  spaceId: string;
  /** Key rotation policy */
  keyRotation?: "per-write" | "per-key"; // default: "per-write"
  /** Network-envelope encryption mode. When set, vault.unlock/key grants are not used. */
  encryption?: VaultNetworkEncryptionConfig;
}

/**
 * Options for vault put operations.
 */
export interface VaultPutOptions {
  /** Custom metadata tags appended to the envelope */
  metadata?: Record<string, string>;
  /** Content type hint for deserialization (default: auto-detect) */
  contentType?: string;
  /** Custom serializer (default: JSON.stringify for objects) */
  serialize?: (value: unknown) => Uint8Array;
}

/**
 * Options for vault get operations.
 */
export interface VaultGetOptions<T = unknown> {
  /** Custom deserializer (default: JSON.parse if content-type is JSON) */
  deserialize?: (data: Uint8Array) => T;
  /** Return raw decrypted bytes without deserialization */
  raw?: boolean;
  /** Delegated KV service for reading from the grantor's space (used by getShared) */
  kv?: { get<V>(key: string, options?: { raw?: boolean }): Promise<{ ok: boolean; data?: { data: V }; error?: { message: string } }> };
}

/**
 * Options for vault list operations.
 */
export interface VaultListOptions {
  /** Prefix filter for key names */
  prefix?: string;
  /** Remove prefix from returned keys */
  removePrefix?: boolean;
}

/**
 * Options for vault grant (sharing) operations.
 */
export interface VaultGrantOptions {
  /** Additional metadata on the grant */
  metadata?: Record<string, string>;
}

/**
 * A decrypted vault entry returned by get operations.
 *
 * @template T - Type of the decrypted value
 */
export interface VaultEntry<T> {
  /** Decrypted value */
  value: T;
  /** Envelope metadata */
  metadata: Record<string, string>;
  /** Key ID used for encryption */
  keyId: string;
}

/**
 * Safe classification for a network-encrypted vault read.
 *
 * Failure variants intentionally contain no node response, encrypted envelope,
 * plaintext, or key material. Consumers that need to distinguish an authorized
 * absence from a failed read should use this instead of {@link IDataVaultService.get}.
 */
export type VaultNetworkReadResult<T> =
  | { status: "ok"; entry: VaultEntry<T> }
  | { status: "not_found" }
  | { status: "node_unreachable" }
  | { status: "permission_required"; hint: PermissionHint }
  | { status: "read_failed" }
  | { status: "corrupt_envelope" }
  | { status: "decrypt_failed" }
  | { status: "invalid_payload" };

/**
 * Structured error codes for vault operations.
 */
/**
 * Input types for creating vault errors (service field added automatically).
 */
export type VaultErrorInput =
  | { code: "DECRYPTION_FAILED"; message?: string; cause?: Error }
  | { code: "KEY_NOT_FOUND"; key: string; message?: string }
  | { code: "INTEGRITY_ERROR"; message?: string; cause?: Error }
  | { code: "GRANT_NOT_FOUND"; grantor: string; key: string; message?: string }
  | { code: "VAULT_LOCKED"; message?: string }
  | { code: "PUBLIC_KEY_NOT_FOUND"; did: string; message?: string }
  | { code: "STORAGE_ERROR"; cause: Error; message?: string };

/**
 * Vault error with service field (compatible with ServiceError).
 */
export type VaultError = VaultErrorInput & { service: "vault"; message: string };


/** KV actions the vault needs on the public space for key publishing. */
export const VaultPublicSpaceKVActions = [
  "tinycloud.kv/get",
  "tinycloud.kv/put",
  "tinycloud.kv/metadata",
] as const;

/** Version-keyed signing message configuration for vault key derivation. */
export const VaultVersionConfig = {
  "1": {
    masterMessage: (spaceId: string) => `tinycloud-vault-master-v1:${spaceId}`,
    identityMessage: "tinycloud-encryption-identity-v1",
  },
} as const;

export const CURRENT_VAULT_VERSION = "1" as const;

/** Metadata header keys used in vault envelopes */
export const VaultHeaders = {
  VERSION: "x-vault-version",
  CIPHER: "x-vault-cipher",
  KEY_ID: "x-vault-key-id",
  CONTENT_TYPE: "x-vault-content-type",
  KDF: "x-vault-kdf",
  KEY_ROTATION: "x-vault-key-rotation",
  GRANT_VERSION: "x-vault-grant-version",
  GRANTOR: "x-vault-grantor",
} as const;
