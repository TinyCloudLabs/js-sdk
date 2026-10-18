/**
 * Data Vault Service Types
 *
 * Type definitions for the Data Vault (encrypted KV) service operations.
 */

import type {
  DecryptCapabilityProof,
  IEncryptionService,
} from "../encryption";
import type { PermissionHint, ServiceError } from "../types";

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
  /**
   * `"*"` writes only when no value exists at the key. An existing value
   * fails with `ALREADY_EXISTS`; it is never overwritten.
   */
  ifNoneMatch?: "*";
  /**
   * Compare-and-swap: write only when the stored envelope still has this
   * strong ETag, passed exactly as {@link VaultEntry.etag} returned it
   * (including the quotes). Network-encrypted vaults only; cannot be combined
   * with `ifNoneMatch`.
   *
   * Failures are distinct codes: `ETAG_MISMATCH` (the value changed or was
   * deleted: re-read, re-apply, retry), `INVALID_ETAG` (malformed; never
   * retry), `OUTCOME_UNKNOWN` (the node may have applied the write, or a gateway
   * answered for it: read it back before retrying, with a freshly signed request) and `NODE_BUSY`
   * (nothing was written; retry).
   */
  ifMatch?: string;
}

/**
 * Options for vault get operations.
 */
export interface VaultGetOptions<T = unknown> {
  /** Custom deserializer (default: JSON.parse if content-type is JSON) */
  deserialize?: (data: Uint8Array) => T;
  /** Return raw decrypted bytes without deserialization */
  raw?: boolean;
  /**
   * Force the underlying KV read to bypass replica read-through. Required for
   * a usable {@link VaultEntry.etag}: only network reads return one, because
   * a replica can serve a stale etag.
   */
  source?: "network";
  /**
   * Opt-in (default off): refuse an envelope whose AAD is not bound to this
   * vault's space and this key (`tinycloud.vault:<spaceId>:<key>`). The space
   * id is compared after normalizing the spelling of its EVM addresses
   * (checksummed and lowercase are the same space). An envelope with no AAD,
   * or with a different one, fails with `AAD_MISMATCH` (`aad_mismatch` from
   * `readNetworkEncrypted`) instead of decrypting. This stops a ciphertext
   * copied to another key from being accepted; it does not stop a freshly
   * encrypted forgery. A malformed stored value is a corrupt envelope, as without this
   * option. Network-encrypted vaults only: a master-key vault and `getShared` refuse it with
   * `STORAGE_ERROR` rather than skip the check.
   */
  expectAad?: boolean;
  /** Delegated KV service for reading from the grantor's space (used by getShared) */
  kv?: { get<V>(key: string, options?: { raw?: boolean; source?: "network" }): Promise<{ ok: boolean; data?: { data: V }; error?: { message: string } }> };
}

/**
 * Options for vault list operations.
 */
export interface VaultListOptions {
  /** Prefix filter for key names */
  prefix?: string;
  removePrefix?: boolean;
  /** Force the underlying KV list to bypass replica read-through. */
  source?: "network";
  /** Maximum number of keys to return. */
  limit?: number;
  /** Opaque cursor returned by a prior bounded page. */
  cursor?: string;
}

export interface VaultListPage {
  keys: string[];
  truncated: boolean;
  nextCursor?: string;
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
  /**
   * Strong ETag of the stored envelope, for {@link VaultPutOptions.ifMatch}.
   * Present only for network-encrypted reads made with `source: "network"`
   * (always for `readNetworkEncrypted`); never taken from a replica.
   */
  etag?: string;
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
  | { status: "invalid_payload" }
  /** Only with `expectAad`: the envelope is not bound to this space and key. */
  | { status: "aad_mismatch" };

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
  | { code: "STORAGE_ERROR"; cause: Error; message?: string; meta?: Record<string, unknown> }
  | {
      code: "ALREADY_EXISTS";
      key: string;
      message?: string;
      meta?: Record<string, unknown>;
      /** The typed KV error that refused the write (an `Error` carrying its `code`, `service` and `meta`). */
      cause: ServiceError & Error;
    }
  | {
      /** HTTP 401 only: the session must sign in again. */
      code: "AUTH_UNAUTHORIZED";
      message: string;
      meta?: Record<string, unknown>;
      /** The typed KV error that refused the write (an `Error` carrying its `code`, `service` and `meta`). */
      cause: ServiceError & Error;
    }
  | {
      /** A 403, or an authorization refusal without a status: signing in again does not help. */
      code: "PERMISSION_DENIED";
      message: string;
      meta?: Record<string, unknown>;
      /** The typed KV error that refused the write (an `Error` carrying its `code`, `service` and `meta`). */
      cause: ServiceError & Error;
    }
  | {
      /** `expectAad` read: the envelope's AAD is missing or bound to another space/key. */
      code: "AAD_MISMATCH";
      key: string;
      message: string;
    }
  | {
      /** `ifMatch` write refused (HTTP 412): the value changed or no longer exists. Re-read and retry. */
      code: "ETAG_MISMATCH";
      key: string;
      message: string;
      meta?: Record<string, unknown>;
      cause: ServiceError & Error;
    }
  | {
      /** `ifMatch` is not a strong ETag (HTTP 400, or rejected before sending). Never retry. */
      code: "INVALID_ETAG";
      key: string;
      message: string;
      meta?: Record<string, unknown>;
      cause?: ServiceError & Error;
    }
  | {
      /**
       * `ifMatch` write that may have been applied: the node's `outcome_unknown` (500), a gateway
       * answer that can follow a commit (500, 502, 503 without the node's busy body, 504, 520,
       * 522, 524) or a connection that failed after the request was sent. Re-read before retrying.
       */
      code: "OUTCOME_UNKNOWN";
      key: string;
      message: string;
      meta?: Record<string, unknown>;
      cause: ServiceError & Error;
    }
  | {
      /** `ifMatch` write, the node's own busy/timeout answer (503 with its busy body): nothing was written. Safe to retry. */
      code: "NODE_BUSY";
      key: string;
      message: string;
      meta?: Record<string, unknown>;
      cause: ServiceError & Error;
    }
  | {
      code: "STORAGE_QUOTA_EXCEEDED" | "STORAGE_LIMIT_REACHED";
      message: string;
      meta?: Record<string, unknown>;
    };

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
