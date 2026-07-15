/**
 * DataVaultService - Encrypted key-value storage service implementation.
 *
 * Platform-agnostic encrypted KV service that wraps KVService internally.
 * Uses dependency injection via VaultCrypto for WASM crypto operations
 * and DataVaultServiceConfig for platform dependencies.
 *
 * Architecture:
 * - Extends BaseService (not KVService)
 * - Wraps two KV instances: dataKV (prefix "vault/") and keyKV (prefix "keys/")
 * - Master key and encryption identity live in memory only (cleared on lock)
 */

import { BaseService } from "../base/BaseService";
import {
  Result,
  ok,
  err,
  serviceError,
  IServiceContext,
  ServiceSession,
} from "../types";
import { wrapError } from "../errors";
import type { IKVService } from "../kv/IKVService";
import type { KVService } from "../kv/KVService";
import type {
  DecryptCapabilityProof,
  InlineEncryptedEnvelope,
} from "../encryption";
import type { IDataVaultService } from "./IDataVaultService";
import {
  DataVaultConfig,
  VaultPutOptions,
  VaultGetOptions,
  VaultListOptions,
  VaultGrantOptions,
  VaultEntry,
  VaultNetworkReadResult,
  VaultError,
  VaultErrorInput,
  VaultHeaders,
  VaultVersionConfig,
  CURRENT_VAULT_VERSION,
} from "./types";
import {
  loadCachedSignature,
  cacheSignature,
  clearSignatureCache,
} from "./SignatureCache";

// =============================================================================
// Crypto Interface
// =============================================================================

/**
 * Crypto operations interface - implementations provided by WASM bindings.
 * Passed via DataVaultServiceConfig to keep the service platform-agnostic.
 */
export interface VaultCrypto {
  encrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array;
  decrypt(key: Uint8Array, blob: Uint8Array): Uint8Array;
  deriveKey(
    signature: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array
  ): Uint8Array;
  x25519FromSeed(
    seed: Uint8Array
  ): { publicKey: Uint8Array; privateKey: Uint8Array };
  x25519Dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Uint8Array;
}

// =============================================================================
// Extended Config
// =============================================================================

/**
 * Extended config used internally by DataVaultService.
 * Includes crypto operations and TinyCloud instance references.
 */
interface DataVaultServiceConfig extends DataVaultConfig {
  [key: string]: unknown;
  /** Crypto operations (WASM bindings) */
  crypto: VaultCrypto;
  /** TinyCloud instance for space/kv/delegation operations */
  tc: {
    kv: IKVService;
    ensurePublicSpace(): Promise<Result<void>>;
    publicKV: IKVService;
    readPublicSpace<T>(
      host: string,
      spaceId: string,
      key: string
    ): Promise<Result<T>>;
    makePublicSpaceId(address: string, chainId: number): string;
    did: string;
    address: string;
    chainId: number;
    hosts: string[];
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/** Convert a caught value to an Error. WASM throws plain objects, not Error instances. */
function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null) {
    return new Error(JSON.stringify(error));
  }
  return new Error(String(error));
}

function toBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function fromBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64Decode(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function unwrapKVData<T = unknown>(value: unknown): T {
  if (value !== null && typeof value === "object" && "data" in value) {
    return (value as { data: T }).data;
  }
  return value as T;
}

function isUnlockSigner(
  signer: unknown
): signer is { signMessage(message: string): Promise<string> } {
  return (
    typeof signer === "object" &&
    signer !== null &&
    typeof (signer as { signMessage?: unknown }).signMessage === "function"
  );
}

function defaultVaultMessage(input: VaultErrorInput): string {
  switch (input.code) {
    case "DECRYPTION_FAILED": return input.message ?? "Decryption failed";
    case "KEY_NOT_FOUND": return input.message ?? `Key not found: ${input.key}`;
    case "INTEGRITY_ERROR": return input.message ?? "Integrity check failed";
    case "GRANT_NOT_FOUND": return input.message ?? `Grant not found: ${input.grantor} / ${input.key}`;
    case "VAULT_LOCKED": return input.message ?? "Vault is locked";
    case "PUBLIC_KEY_NOT_FOUND": return input.message ?? `Public key not found for ${input.did}`;
    case "STORAGE_ERROR": return input.message ?? input.cause.message;
  }
}

function vaultError(input: VaultErrorInput): Result<never, VaultError> {
  const error: VaultError = {
    ...input,
    service: "vault",
    message: defaultVaultMessage(input),
  };
  return { ok: false, error };
}

// =============================================================================
// DataVaultService
// =============================================================================

/**
 * Data Vault service implementation.
 *
 * Provides encrypted key-value storage with client-side encryption,
 * key management, and sharing via X25519 grants.
 *
 * @example
 * ```typescript
 * // Unlock the vault
 * await vault.unlock(signer);
 *
 * // Store encrypted data
 * await vault.put('secret/notes', { content: 'Hello' });
 *
 * // Retrieve and decrypt
 * const entry = await vault.get<{ content: string }>('secret/notes');
 * if (entry.ok) {
 *   console.log(entry.data.value.content); // 'Hello'
 * }
 *
 * // Share with another user
 * await vault.grant('secret/notes', recipientDID);
 * ```
 */
export class DataVaultService extends BaseService implements IDataVaultService {
  /**
   * Service identifier for registration.
   */
  static readonly serviceName = "vault";

  /**
   * Service configuration.
   */
  declare protected _config: DataVaultServiceConfig;

  private masterKey: Uint8Array | null = null;
  private encryptionIdentity: {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  } | null = null;
  private _isUnlocked = false;
  private vaultConfig: DataVaultServiceConfig;
  private unlockInFlight: Promise<Result<void, VaultError>> | null = null;

  /**
   * Create a new DataVaultService instance.
   *
   * @param config - Service configuration including crypto and tc references
   */
  constructor(config: DataVaultServiceConfig) {
    super();
    this.vaultConfig = config;
    this._config = config;
  }

  /**
   * Get the service configuration.
   */
  get config(): DataVaultServiceConfig {
    return this._config;
  }

  /**
   * Whether the vault is currently unlocked.
   */
  get isUnlocked(): boolean {
    return this.usesNetworkEncryption || this._isUnlocked;
  }

  /**
   * The vault's public encryption key (X25519).
   * Throws if vault is locked.
   */
  get publicKey(): Uint8Array {
    if (this.usesNetworkEncryption) {
      throw new Error("Network-encrypted vaults do not expose a local public key");
    }
    if (!this.encryptionIdentity) {
      throw new Error("Vault is locked");
    }
    return this.encryptionIdentity.publicKey;
  }

  /**
   * Convenience accessor for crypto operations.
   */
  private get crypto(): VaultCrypto {
    return this.vaultConfig.crypto;
  }

  /**
   * Convenience accessor for TinyCloud instance.
   */
  private get tc() {
    return this.vaultConfig.tc;
  }

  private get networkEncryption() {
    return this.vaultConfig.encryption;
  }

  private get usesNetworkEncryption(): boolean {
    return this.networkEncryption !== undefined;
  }

  /**
   * Get the host URL.
   */
  private get host(): string {
    return this.tc.hosts[0];
  }

  private async decryptCapabilityProof(): Promise<DecryptCapabilityProof> {
    const proof = this.networkEncryption?.decryptCapabilityProof;
    if (typeof proof === "function") {
      return await proof();
    }
    return proof ?? { proofs: [] };
  }

  private serializeValue(
    value: unknown,
    options?: VaultPutOptions,
  ): { plaintext: Uint8Array; contentType: string } {
    let plaintext: Uint8Array;
    if (value instanceof Uint8Array) {
      plaintext = value;
    } else if (options?.serialize) {
      plaintext = options.serialize(value);
    } else if (typeof value === "string") {
      plaintext = toBytes(value);
    } else {
      plaintext = toBytes(JSON.stringify(value));
    }

    const contentType =
      options?.contentType ??
      (value instanceof Uint8Array ? "application/octet-stream" : "application/json");
    return { plaintext, contentType };
  }

  private deserializeValue<T>(
    plaintext: Uint8Array,
    contentType: string,
    options?: VaultGetOptions<T>,
  ): T {
    if (options?.raw) {
      return plaintext as unknown as T;
    }
    if (options?.deserialize) {
      return options.deserialize(plaintext);
    }
    if (contentType === "application/json") {
      return JSON.parse(fromBytes(plaintext)) as T;
    }
    return plaintext as unknown as T;
  }

  // =========================================================================
  // Phase 1: Core Operations
  // =========================================================================

  /**
   * Unlock the vault. Derives keys from two wallet signatures:
   * 1. Master signature (per-space) — used to derive the master encryption key
   * 2. Identity signature (per-address) — used to derive X25519 encryption identity
   *
   * If the identity public key already exists in the public space, the identity
   * signature is skipped entirely (no wallet popup). The identity private key is
   * only needed for sharing operations.
   *
   * @param signer - Object with signMessage method. Optional when cached
   *                 signatures exist (browser only).
   */
  async unlock(
    signer?: { signMessage(message: string): Promise<string> } | unknown
  ): Promise<Result<void, VaultError>> {
    if (this.usesNetworkEncryption) {
      this._isUnlocked = true;
      return { ok: true, data: undefined };
    }

    const unlockSigner = isUnlockSigner(signer) ? signer : undefined;
    if (
      this._isUnlocked &&
      this.masterKey &&
      (this.encryptionIdentity || !unlockSigner)
    ) {
      return { ok: true, data: undefined };
    }

    if (this.unlockInFlight) {
      return this.unlockInFlight;
    }

    this.unlockInFlight = this.withTelemetry("unlock", undefined, async () => {
      const spaceId = this.vaultConfig.spaceId;
      const versionConfig = VaultVersionConfig[CURRENT_VAULT_VERSION];
      const masterCacheKey = `vault-master:${spaceId}`;
      const identityCacheKey = `vault-identity:${this.tc.address}`;

      try {
        // -----------------------------------------------------------------
        // Step 1: Master signature → master key
        // -----------------------------------------------------------------
        if (!this.masterKey) {
          let masterSigBytes = await loadCachedSignature(masterCacheKey);

          if (!masterSigBytes) {
            if (!unlockSigner) {
              return vaultError({
                code: "VAULT_LOCKED",
                message: "Signer is required when no cached master signature exists",
              });
            }
            const sig = await unlockSigner.signMessage(
              versionConfig.masterMessage(spaceId)
            );
            masterSigBytes = toBytes(sig);
            await cacheSignature(masterCacheKey, masterSigBytes);
          }

          // Derive master key: deriveKey(sigBytes, sha256(spaceId), "vault-master")
          this.masterKey = this.crypto.deriveKey(
            masterSigBytes,
            this.crypto.sha256(toBytes(spaceId)),
            toBytes("vault-master")
          );
        }

        // -----------------------------------------------------------------
        // Step 2: Identity — check public space first, then sign if needed
        // -----------------------------------------------------------------
        const publicSpaceId = this.tc.makePublicSpaceId(this.tc.address, this.tc.chainId);

        // Check public space for existing vault pubkey
        let existingPubKey: string | null = null;
        try {
          const existing = await this.tc.readPublicSpace<string>(
            this.host, publicSpaceId, ".well-known/vault-pubkey"
          );
          if (existing.ok && existing.data) {
            existingPubKey = existing.data as string;
          }
        } catch {
          // Read failed — treat as missing
        }

        if (existingPubKey) {
          // Public key exists — trust it, skip identity signing entirely
          this.encryptionIdentity = {
            publicKey: base64Decode(existingPubKey),
            privateKey: new Uint8Array(0), // private key not available without signing
          };
        } else {
          // Public key missing — need identity signature to derive keypair
          let identitySigBytes = await loadCachedSignature(identityCacheKey);

          if (!identitySigBytes) {
            if (!unlockSigner) {
              // No signer available — skip identity derivation.
              // Vault still works for get/put (only needs master key).
              this.encryptionIdentity = null;
              this._isUnlocked = true;
              return ok(undefined);
            }
            const sig = await unlockSigner.signMessage(
              versionConfig.identityMessage
            );
            identitySigBytes = toBytes(sig);
            await cacheSignature(identityCacheKey, identitySigBytes);
          }

          // Derive X25519 keypair from identity signature
          const seed = this.crypto.deriveKey(
            identitySigBytes,
            toBytes("tinycloud-x25519"),
            toBytes("encryption-identity")
          );
          this.encryptionIdentity = this.crypto.x25519FromSeed(seed);

          // Publish public key to public space
          try {
            const pubKeyB64 = base64Encode(this.encryptionIdentity.publicKey);
            await this.tc.ensurePublicSpace();
            await this.tc.publicKV.put(".well-known/vault-pubkey", pubKeyB64);
            await this.tc.publicKV.put(".well-known/vault-version", CURRENT_VAULT_VERSION);
            await this.tc.publicKV.put(".well-known/vault-space", this.vaultConfig.spaceId);
          } catch {
            // Publishing failed — vault still usable
          }
        }

        this._isUnlocked = true;
        return ok(undefined);
      } catch (error) {
        // Clear key material on failure
        this.masterKey = null;
        this.encryptionIdentity = null;
        return vaultError({
          code: "STORAGE_ERROR",
          cause:
            toError(error),
        });
      }
    }) as Promise<Result<void, VaultError>>;

    try {
      return await this.unlockInFlight;
    } finally {
      this.unlockInFlight = null;
    }
  }

  /**
   * Clear the cached vault signatures.
   *
   * @param spaceId - Clear only this space's master cache. If omitted, clears all.
   */
  async clearCache(spaceId?: string): Promise<void> {
    if (spaceId) {
      await clearSignatureCache(`vault-master:${spaceId}`);
    } else {
      await clearSignatureCache();
    }
  }

  /**
   * Lock the vault, clearing all key material from memory.
   */
  lock(): void {
    this.masterKey = null;
    this.encryptionIdentity = null;
    this._isUnlocked = false;
  }

  /**
   * Called when SDK signs out. Locks the vault and aborts operations.
   */
  onSignOut(): void {
    this.lock();
    super.onSignOut();
  }

  private async putNetworkEncrypted(
    key: string,
    value: unknown,
    options?: VaultPutOptions,
  ): Promise<Result<void, VaultError>> {
    const config = this.networkEncryption;
    if (!config) {
      return vaultError({
        code: "VAULT_LOCKED",
        message: "Network encryption is not configured",
      });
    }
    if (!this.requireAuth()) {
      return vaultError({
        code: "VAULT_LOCKED",
        message: "Authentication required",
      });
    }

    try {
      const { plaintext, contentType } = this.serializeValue(value, options);
      const metadata: Record<string, string> = {
        [VaultHeaders.VERSION]: "2",
        [VaultHeaders.CIPHER]: "tinycloud-network-envelope",
        [VaultHeaders.CONTENT_TYPE]: contentType,
        ...(options?.metadata ?? {}),
      };
      const aad = toBytes(`tinycloud.vault:${this.vaultConfig.spaceId}:${key}`);
      const envelopeResult = await config.service.encryptToNetwork(
        config.networkId,
        plaintext,
        { aad, metadata },
      );
      if (!envelopeResult.ok) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause: new Error(envelopeResult.error.message),
        });
      }

      const valuePutResult = await this.tc.kv.put(
        `vault/${key}`,
        JSON.stringify(envelopeResult.data),
      );
      if (!valuePutResult.ok) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause: new Error(
            `Failed to store encrypted value: ${valuePutResult.error.message}`,
          ),
        });
      }

      return { ok: true, data: undefined };
    } catch (error) {
      return vaultError({
        code: "STORAGE_ERROR",
        cause: toError(error),
      });
    }
  }

  private async getNetworkEncrypted<T = unknown>(
    key: string,
    options?: VaultGetOptions<T>,
  ): Promise<Result<VaultEntry<T>, VaultError>> {
    const config = this.networkEncryption;
    if (!config) {
      return vaultError({
        code: "VAULT_LOCKED",
        message: "Network encryption is not configured",
      });
    }
    if (!this.requireAuth()) {
      return vaultError({
        code: "VAULT_LOCKED",
        message: "Authentication required",
      });
    }

    try {
      const valueResult = await this.tc.kv.get<string>(`vault/${key}`, {
        raw: true,
      });
      if (!valueResult.ok) {
        return vaultError({ code: "KEY_NOT_FOUND", key });
      }

      const rawEnvelope = unwrapKVData<string>(valueResult.data);
      const envelope = (
        typeof rawEnvelope === "string" ? JSON.parse(rawEnvelope) : rawEnvelope
      ) as InlineEncryptedEnvelope;
      const proof = await this.decryptCapabilityProof();
      const plaintextResult = await config.service.decryptEnvelope(envelope, proof);
      if (!plaintextResult.ok) {
        return vaultError({
          code: "DECRYPTION_FAILED",
          message: plaintextResult.error.message,
        });
      }

      const metadata: Record<string, string> = envelope.metadata ?? {};
      const contentType =
        metadata[VaultHeaders.CONTENT_TYPE] ?? "application/json";
      const keyId =
        metadata[VaultHeaders.KEY_ID] ??
        envelope.encryptedSymmetricKeyHash.slice(0, 16);
      const value = this.deserializeValue<T>(
        plaintextResult.data,
        contentType,
        options,
      );

      return { ok: true, data: { value, metadata, keyId } };
    } catch (error) {
      return vaultError({
        code: "STORAGE_ERROR",
        cause: toError(error),
      });
    }
  }

  /**
   * Read a network-encrypted entry while preserving safe failure phases.
   *
   * Unlike {@link getNetworkEncrypted}, this is intentionally message-free so
   * an operation layer can distinguish an authorized absence from a failed
   * read without receiving node, envelope, plaintext, or key material.
   */
  async readNetworkEncrypted<T = unknown>(
    key: string,
    options?: VaultGetOptions<T>,
  ): Promise<VaultNetworkReadResult<T>> {
    const config = this.networkEncryption;
    if (!config || !this.requireAuth()) {
      return { status: "read_failed" };
    }

    let valueResult: Awaited<ReturnType<IKVService["get"]>>;
    try {
      valueResult = await this.tc.kv.get<string>(`vault/${key}`, { raw: true });
    } catch {
      return { status: "node_unreachable" };
    }

    if (!valueResult.ok) {
      if (
        valueResult.error.code === "NOT_FOUND" ||
        valueResult.error.code === "KV_NOT_FOUND"
      ) {
        return { status: "not_found" };
      }
      if (
        valueResult.error.code === "NETWORK_ERROR" ||
        valueResult.error.code === "TIMEOUT" ||
        valueResult.error.code === "ABORTED"
      ) {
        return { status: "node_unreachable" };
      }
      return { status: "read_failed" };
    }

    let envelope: InlineEncryptedEnvelope;
    try {
      const rawEnvelope = unwrapKVData<string>(valueResult.data);
      envelope = (
        typeof rawEnvelope === "string" ? JSON.parse(rawEnvelope) : rawEnvelope
      ) as InlineEncryptedEnvelope;
    } catch {
      return { status: "corrupt_envelope" };
    }

    let plaintextResult: Awaited<ReturnType<typeof config.service.decryptEnvelope>>;
    try {
      const proof = await this.decryptCapabilityProof();
      plaintextResult = await config.service.decryptEnvelope(envelope, proof);
    } catch {
      return { status: "node_unreachable" };
    }

    if (!plaintextResult.ok) {
      if (plaintextResult.error.code === "INVALID_ENVELOPE") {
        return { status: "corrupt_envelope" };
      }
      if (plaintextResult.error.code === "TRANSPORT_ERROR") {
        return { status: "node_unreachable" };
      }
      return { status: "decrypt_failed" };
    }

    try {
      const metadata: Record<string, string> = envelope.metadata ?? {};
      const contentType =
        metadata[VaultHeaders.CONTENT_TYPE] ?? "application/json";
      const keyId =
        metadata[VaultHeaders.KEY_ID] ??
        envelope.encryptedSymmetricKeyHash.slice(0, 16);
      const value = this.deserializeValue<T>(
        plaintextResult.data,
        contentType,
        options,
      );
      return { status: "ok", entry: { value, metadata, keyId } };
    } catch {
      return { status: "invalid_payload" };
    }
  }

  private async headNetworkEncrypted(
    key: string,
  ): Promise<Result<Record<string, string>, VaultError>> {
    if (!this.requireAuth()) {
      return vaultError({
        code: "VAULT_LOCKED",
        message: "Authentication required",
      });
    }

    try {
      const valueResult = await this.tc.kv.get<string>(`vault/${key}`, {
        raw: true,
      });
      if (!valueResult.ok) {
        return vaultError({ code: "KEY_NOT_FOUND", key });
      }
      const rawEnvelope = unwrapKVData<string>(valueResult.data);
      const envelope = (
        typeof rawEnvelope === "string" ? JSON.parse(rawEnvelope) : rawEnvelope
      ) as InlineEncryptedEnvelope;
      return { ok: true, data: envelope.metadata ?? {} };
    } catch (error) {
      return vaultError({
        code: "STORAGE_ERROR",
        cause: toError(error),
      });
    }
  }

  /**
   * Encrypt and store a value at the given key.
   *
   * @param key - The key to store under
   * @param value - The value to encrypt and store
   * @param options - Optional put configuration
   */
  async put(
    key: string,
    value: unknown,
    options?: VaultPutOptions
  ): Promise<Result<void, VaultError>> {
    return this.withTelemetry("put", key, async () => {
      if (this.usesNetworkEncryption) {
        return this.putNetworkEncrypted(key, value, options);
      }

      if (!this._isUnlocked || !this.masterKey) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before storing data",
        });
      }

      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required",
        });
      }

      try {
        // Serialize value
        let plaintext: Uint8Array;
        if (value instanceof Uint8Array) {
          plaintext = value;
        } else if (options?.serialize) {
          plaintext = options.serialize(value);
        } else if (typeof value === "string") {
          plaintext = toBytes(value);
        } else {
          plaintext = toBytes(JSON.stringify(value));
        }

        const contentType =
          options?.contentType ??
          (value instanceof Uint8Array
            ? "application/octet-stream"
            : "application/json");

        // Generate per-entry key
        const entryKey = this.crypto.randomBytes(32);
        const keyId = hexEncode(this.crypto.sha256(entryKey)).slice(0, 16);

        // Encrypt value with entry key
        const encrypted = this.crypto.encrypt(entryKey, plaintext);

        // Encrypt entry key with master key
        const keyBlob = this.crypto.encrypt(this.masterKey, entryKey);

        // Build metadata
        const metadata: Record<string, string> = {
          [VaultHeaders.VERSION]: "1",
          [VaultHeaders.CIPHER]: "aes-256-gcm",
          [VaultHeaders.KEY_ID]: keyId,
          [VaultHeaders.CONTENT_TYPE]: contentType,
          [VaultHeaders.KDF]: "hkdf-sha256",
          [VaultHeaders.KEY_ROTATION]:
            this.vaultConfig.keyRotation ?? "per-write",
          ...(options?.metadata ?? {}),
        };

        // Store encrypted entry key in key space
        const keyMetadata = JSON.stringify({
          keyId,
          contentType,
          ...metadata,
        });
        const keyPayload = JSON.stringify({
          key: base64Encode(keyBlob),
          metadata: keyMetadata,
        });
        const keyPutResult = await this.tc.kv.put(
          `keys/${key}`,
          keyPayload
        );
        if (!keyPutResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to store key blob: ${keyPutResult.error.message}`
            ),
          });
        }

        // Store encrypted value in data space
        const valuePayload = JSON.stringify({
          data: base64Encode(encrypted),
          metadata,
        });
        const valuePutResult = await this.tc.kv.put(
          `vault/${key}`,
          valuePayload
        );
        if (!valuePutResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to store encrypted value: ${valuePutResult.error.message}`
            ),
          });
        }

        return ok(undefined);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause:
            toError(error),
        });
      }
    }) as Promise<Result<void, VaultError>>;
  }

  /**
   * Retrieve and decrypt a value by key.
   *
   * @param key - The key to retrieve
   * @param options - Optional get configuration
   * @returns Result with the decrypted entry
   */
  async get<T = unknown>(
    key: string,
    options?: VaultGetOptions<T>
  ): Promise<Result<VaultEntry<T>, VaultError>> {
    return this.withTelemetry("get", key, async () => {
      if (this.usesNetworkEncryption) {
        return this.getNetworkEncrypted<T>(key, options);
      }

      if (!this._isUnlocked || !this.masterKey) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before reading data",
        });
      }

      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required",
        });
      }

      try {
        // Fetch encrypted entry key from key space
        const keyResult = await this.tc.kv.get<string>(`keys/${key}`, {
          raw: true,
        });
        if (!keyResult.ok) {
          return vaultError({ code: "KEY_NOT_FOUND", key });
        }

        const keyEnvelope = JSON.parse(keyResult.data.data as string);
        const keyBlobBytes = base64Decode(keyEnvelope.key);
        const entryKey = this.crypto.decrypt(this.masterKey, keyBlobBytes);

        // Fetch encrypted value from data space
        const valueResult = await this.tc.kv.get<string>(`vault/${key}`, {
          raw: true,
        });
        if (!valueResult.ok) {
          return vaultError({ code: "KEY_NOT_FOUND", key });
        }

        const valueEnvelope = JSON.parse(valueResult.data.data as string);
        const encryptedBytes = base64Decode(valueEnvelope.data);
        const plaintext = this.crypto.decrypt(entryKey, encryptedBytes);

        // Read metadata
        const metadata: Record<string, string> = valueEnvelope.metadata ?? {};
        const contentType =
          metadata[VaultHeaders.CONTENT_TYPE] ?? "application/json";
        const keyId = metadata[VaultHeaders.KEY_ID] ?? "";

        // Deserialize
        let value: T;
        if (options?.raw) {
          value = plaintext as unknown as T;
        } else if (options?.deserialize) {
          value = options.deserialize(plaintext);
        } else if (contentType === "application/json") {
          value = JSON.parse(fromBytes(plaintext)) as T;
        } else {
          value = plaintext as unknown as T;
        }

        return ok({ value, metadata, keyId });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("decryption")
        ) {
          return vaultError({
            code: "DECRYPTION_FAILED",
            message: error.message,
          });
        }
        return vaultError({
          code: "STORAGE_ERROR",
          cause:
            toError(error),
        });
      }
    }) as Promise<Result<VaultEntry<T>, VaultError>>;
  }

  /**
   * Delete an encrypted key.
   * Removes both the encrypted value and the key blob.
   *
   * @param key - The key to delete
   */
  async delete(key: string): Promise<Result<void, VaultError>> {
    return this.withTelemetry("delete", key, async () => {
      if (!this.isUnlocked) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before deleting data",
        });
      }

      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required",
        });
      }

      try {
        if (this.usesNetworkEncryption) {
          const valueDelResult = await this.tc.kv.delete(`vault/${key}`);
          if (!valueDelResult.ok) {
            return vaultError({ code: "KEY_NOT_FOUND", key });
          }
          return ok(undefined);
        }

        // Delete from both key space and data space
        const [keyDelResult, valueDelResult] = await Promise.all([
          this.tc.kv.delete(`keys/${key}`),
          this.tc.kv.delete(`vault/${key}`),
        ]);

        if (!keyDelResult.ok && !valueDelResult.ok) {
          return vaultError({ code: "KEY_NOT_FOUND", key });
        }

        return ok(undefined);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause:
            toError(error),
        });
      }
    }) as Promise<Result<void, VaultError>>;
  }

  /**
   * List vault keys with optional prefix filtering.
   *
   * @param options - Optional list configuration
   * @returns Result with array of key names (vault/ prefix stripped)
   */
  async list(
    options?: VaultListOptions
  ): Promise<Result<string[], VaultError>> {
    return this.withTelemetry("list", options?.prefix, async () => {
      if (!this.isUnlocked) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before listing data",
        });
      }

      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required",
        });
      }

      try {
        const listPrefix = options?.prefix
          ? `vault/${options.prefix}`
          : "vault/";

        const listResult = await this.tc.kv.list({
          prefix: listPrefix,
          removePrefix: true,
        });

        if (!listResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to list vault keys: ${listResult.error.message}`
            ),
          });
        }

        // Keys are already stripped of the "vault/" prefix by removePrefix
        let keys = listResult.data.keys;

        // If a user prefix was provided, strip it too if requested
        if (options?.removePrefix && options.prefix) {
          const userPrefix = options.prefix.endsWith("/")
            ? options.prefix
            : `${options.prefix}/`;
          keys = keys.map((k) =>
            k.startsWith(userPrefix) ? k.slice(userPrefix.length) : k
          );
        }

        return ok(keys);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause:
            toError(error),
        });
      }
    }) as Promise<Result<string[], VaultError>>;
  }

  /**
   * Get envelope metadata for a key without decrypting the value.
   *
   * @param key - The key to inspect
   * @returns Result with metadata headers
   */
  async head(
    key: string
  ): Promise<Result<Record<string, string>, VaultError>> {
    return this.withTelemetry("head", key, async () => {
      if (this.usesNetworkEncryption) {
        return this.headNetworkEncrypted(key);
      }

      if (!this._isUnlocked) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before reading metadata",
        });
      }

      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required",
        });
      }

      try {
        // Fetch envelope without decrypting
        const valueResult = await this.tc.kv.get<string>(`vault/${key}`, {
          raw: true,
        });
        if (!valueResult.ok) {
          return vaultError({ code: "KEY_NOT_FOUND", key });
        }

        const valueEnvelope = JSON.parse(valueResult.data.data as string);
        const metadata: Record<string, string> = valueEnvelope.metadata ?? {};
        return ok(metadata);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause:
            toError(error),
        });
      }
    }) as Promise<Result<Record<string, string>, VaultError>>;
  }

  // =========================================================================
  // Batch Operations
  // =========================================================================

  /**
   * Encrypt and store multiple entries.
   *
   * @param entries - Array of key/value pairs with optional per-entry options
   * @returns Array of results, one per entry
   */
  async putMany(
    entries: Array<{ key: string; value: unknown; options?: VaultPutOptions }>
  ): Promise<Result<void, VaultError>[]> {
    return Promise.all(
      entries.map((entry) => this.put(entry.key, entry.value, entry.options))
    );
  }

  /**
   * Retrieve and decrypt multiple keys.
   *
   * @param keys - Array of keys to retrieve
   * @param options - Optional get configuration applied to all entries
   * @returns Array of results, one per key
   */
  async getMany<T = unknown>(
    keys: string[],
    options?: VaultGetOptions<T>
  ): Promise<Result<VaultEntry<T>, VaultError>[]> {
    return Promise.all(keys.map((key) => this.get<T>(key, options)));
  }

  // =========================================================================
  // Phase 2: Sharing
  // =========================================================================

  /**
   * Re-encrypt a vault key for another user (renamed from grant).
   * Re-encrypts the data key to the recipient's public key via X25519 DH.
   *
   * @param key - The key to share
   * @param recipientDID - The recipient's primary DID (did:pkh:...)
   * @param options - Optional grant configuration
   */
  async reencrypt(
    key: string,
    recipientDID: string,
    options?: VaultGrantOptions
  ): Promise<Result<void, VaultError>> {
    return this.withTelemetry("reencrypt", key, async () => {
      if (this.usesNetworkEncryption) {
        void recipientDID;
        void options;
        return vaultError({
          code: "STORAGE_ERROR",
          cause: new Error(
            "Vault key grants are deprecated for network-encrypted vaults; grant tinycloud.encryption/decrypt on the network plus KV access to vault data.",
          ),
        });
      }

      if (!this._isUnlocked || !this.masterKey) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before granting access",
        });
      }

      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required",
        });
      }

      try {
        // Step 1: Resolve recipient's public key
        const pubKeyResult = await this.resolvePublicKey(recipientDID);
        if (!pubKeyResult.ok) {
          return pubKeyResult;
        }
        const bobPubKey = pubKeyResult.data;

        // Step 2: Fetch and decrypt entry key from key space
        const keyResult = await this.tc.kv.get<string>(`keys/${key}`, {
          raw: true,
        });
        if (!keyResult.ok) {
          return vaultError({ code: "KEY_NOT_FOUND", key });
        }

        const keyEnvelope = JSON.parse(keyResult.data.data as string);
        const keyBlobBytes = base64Decode(keyEnvelope.key);
        const entryKey = this.crypto.decrypt(this.masterKey, keyBlobBytes);

        // Step 3: Create ephemeral X25519 key pair
        const ephemeralSeed = this.crypto.randomBytes(32);
        const ephemeralKeyPair = this.crypto.x25519FromSeed(ephemeralSeed);

        // Step 4: Compute shared secret via DH
        const sharedSecret = this.crypto.x25519Dh(
          ephemeralKeyPair.privateKey,
          bobPubKey
        );

        // Step 5: Derive encryption key from shared secret
        const encryptionKey = this.crypto.deriveKey(
          sharedSecret,
          toBytes("tinycloud-x25519"),
          toBytes("vault-grant")
        );

        // Step 6: Encrypt entry key with derived key
        const encryptedGrant = this.crypto.encrypt(encryptionKey, entryKey);

        // Step 7: Concatenate ephemeral public key + encrypted grant
        const grantBlob = concatBytes(
          ephemeralKeyPair.publicKey,
          encryptedGrant
        );

        // Step 8: Store grant in key space
        const grantPayload = JSON.stringify({
          grant: base64Encode(grantBlob),
          spaceId: this.vaultConfig.spaceId,
          metadata: {
            [VaultHeaders.GRANT_VERSION]: "1",
            [VaultHeaders.GRANTOR]: this.tc.did,
            ...(options?.metadata ?? {}),
          },
        });
        // Store grant in the vault's space (main space)
        const grantPutResult = await this.tc.kv.put(
          `grants/${recipientDID}/${key}`,
          grantPayload
        );
        if (!grantPutResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to store grant: ${grantPutResult.error.message}`
            ),
          });
        }

        return ok(undefined);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause:
            toError(error),
        });
      }
    }) as Promise<Result<void, VaultError>>;
  }

  /**
   * @deprecated Use reencrypt() instead.
   */
  async grant(
    key: string,
    recipientDID: string,
    options?: VaultGrantOptions
  ): Promise<Result<void, VaultError>> {
    return this.reencrypt(key, recipientDID, options);
  }

  /**
   * Retrieve and decrypt a value shared by another user.
   *
   * @param grantorDID - The DID of the user who shared the data
   * @param key - The key that was shared
   * @param options - Optional get configuration
   * @returns Result with the decrypted entry
   */
  async getShared<T = unknown>(
    grantorDID: string,
    key: string,
    options?: VaultGetOptions<T>
  ): Promise<Result<VaultEntry<T>, VaultError>> {
    return this.withTelemetry("getShared", key, async () => {
      if (this.usesNetworkEncryption) {
        const grantorKV = options?.kv;
        if (!grantorKV) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              "getShared requires a delegated KV service via options.kv.",
            ),
          });
        }

        const config = this.networkEncryption;
        if (!config) {
          return vaultError({
            code: "VAULT_LOCKED",
            message: "Network encryption is not configured",
          });
        }
        if (!this.requireAuth()) {
          return vaultError({
            code: "VAULT_LOCKED",
            message: "Authentication required",
          });
        }

        try {
          const valueResult = await grantorKV.get<string>(`vault/${key}`, {
            raw: true,
          });
          if (!valueResult.ok) {
            return vaultError({ code: "KEY_NOT_FOUND", key });
          }
          const rawEnvelope = unwrapKVData<string>(valueResult.data);
          const envelope = (
            typeof rawEnvelope === "string" ? JSON.parse(rawEnvelope) : rawEnvelope
          ) as InlineEncryptedEnvelope;
          const proof = await this.decryptCapabilityProof();
          const plaintextResult = await config.service.decryptEnvelope(
            envelope,
            proof,
          );
          if (!plaintextResult.ok) {
            return vaultError({
              code: "DECRYPTION_FAILED",
              message: plaintextResult.error.message,
            });
          }

          const metadata: Record<string, string> = envelope.metadata ?? {};
          const contentType =
            metadata[VaultHeaders.CONTENT_TYPE] ?? "application/json";
          const keyId =
            metadata[VaultHeaders.KEY_ID] ??
            envelope.encryptedSymmetricKeyHash.slice(0, 16);
          const value = this.deserializeValue<T>(
            plaintextResult.data,
            contentType,
            options,
          );
          void grantorDID;
          return { ok: true, data: { value, metadata, keyId } };
        } catch (error) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: toError(error),
          });
        }
      }

      if (
        !this._isUnlocked ||
        !this.masterKey ||
        !this.encryptionIdentity
      ) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before reading shared data",
        });
      }

      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required",
        });
      }

      try {
        const myDID = this.tc.did;
        const grantorKV = options?.kv;

        if (!grantorKV) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              "getShared requires a delegated KV service via options.kv. " +
              "Use useDelegation() to get delegated access, then pass { kv: access.kv }."
            ),
          });
        }

        // Step 1: Fetch grant from grantor's space via delegated KV
        const grantResult = await grantorKV.get<string>(`grants/${myDID}/${key}`, {
          raw: true,
        });
        if (!grantResult.ok) {
          return vaultError({
            code: "GRANT_NOT_FOUND",
            grantor: grantorDID,
            key,
          });
        }

        const grantEnvelope = typeof grantResult.data?.data === "string"
          ? JSON.parse(grantResult.data.data as string)
          : grantResult.data?.data;
        const grantBlobBytes = base64Decode((grantEnvelope as any).grant);

        // Step 2: Extract ephemeral public key and encrypted grant
        const ephemeralPubKey = grantBlobBytes.slice(0, 32);
        const encryptedGrant = grantBlobBytes.slice(32);

        // Step 3: Compute shared secret using our private key
        const sharedSecret = this.crypto.x25519Dh(
          this.encryptionIdentity.privateKey,
          ephemeralPubKey
        );

        // Step 4: Derive decryption key
        const encryptionKey = this.crypto.deriveKey(
          sharedSecret,
          toBytes("tinycloud-x25519"),
          toBytes("vault-grant")
        );

        // Step 5: Decrypt entry key
        const entryKey = this.crypto.decrypt(encryptionKey, encryptedGrant);

        // Step 6: Fetch encrypted value from grantor's space via delegated KV
        const valueResult = await grantorKV.get<string>(`vault/${key}`, {
          raw: true,
        });
        if (!valueResult.ok) {
          return vaultError({
            code: "KEY_NOT_FOUND",
            key,
          });
        }

        const valueEnvelope = typeof valueResult.data?.data === "string"
          ? JSON.parse(valueResult.data.data as string)
          : valueResult.data?.data;
        const encryptedBytes = base64Decode((valueEnvelope as any).data);
        const plaintext = this.crypto.decrypt(entryKey, encryptedBytes);

        // Read metadata
        const metadata: Record<string, string> = (valueEnvelope as any).metadata ?? {};
        const contentType =
          metadata[VaultHeaders.CONTENT_TYPE] ?? "application/json";
        const keyId = metadata[VaultHeaders.KEY_ID] ?? "";

        // Deserialize
        let value: T;
        if (options?.raw) {
          value = plaintext as unknown as T;
        } else if (options?.deserialize) {
          value = options.deserialize(plaintext);
        } else if (contentType === "application/json") {
          value = JSON.parse(fromBytes(plaintext)) as T;
        } else {
          value = plaintext as unknown as T;
        }

        return ok({ value, metadata, keyId });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("decryption")
        ) {
          return vaultError({
            code: "DECRYPTION_FAILED",
            message: error.message,
          });
        }
        return vaultError({
          code: "STORAGE_ERROR",
          cause:
            toError(error),
        });
      }
    }) as Promise<Result<VaultEntry<T>, VaultError>>;
  }

  /**
   * Resolve another user's public encryption key from their DID.
   *
   * @param did - The DID to resolve (did:pkh:eip155:{chainId}:{address})
   * @returns Result with the public key bytes
   */
  async resolvePublicKey(
    did: string
  ): Promise<Result<Uint8Array, VaultError>> {
    try {
      const parts = this.parseDID(did);
      if (!parts) {
        return vaultError({ code: "PUBLIC_KEY_NOT_FOUND", did });
      }

      const spaceId = this.tc.makePublicSpaceId(
        parts.address,
        parts.chainId
      );

      const result = await this.tc.readPublicSpace<string>(
        this.host,
        spaceId,
        ".well-known/vault-pubkey"
      );

      if (!result.ok) {
        return vaultError({ code: "PUBLIC_KEY_NOT_FOUND", did });
      }

      const pubKeyBytes = base64Decode(result.data as string);
      return { ok: true, data: pubKeyBytes } as Result<Uint8Array, VaultError>;
    } catch (error) {
      return vaultError({ code: "PUBLIC_KEY_NOT_FOUND", did });
    }
  }

  /**
   * List DIDs that have been granted access to a key.
   *
   * @param key - The key to list grants for
   * @returns Result with array of recipient DIDs
   */
  async listGrants(
    key: string
  ): Promise<Result<string[], VaultError>> {
    return this.withTelemetry("listGrants", key, async () => {
      if (this.usesNetworkEncryption) {
        void key;
        return { ok: true, data: [] };
      }

      if (!this._isUnlocked) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before listing grants",
        });
      }

      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required",
        });
      }

      try {
        const listResult = await this.tc.kv.list({
          prefix: "grants/",
          removePrefix: true,
        });

        if (!listResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to list grants: ${listResult.error.message}`
            ),
          });
        }

        // Grant paths are: {recipientDID}/{key}
        // Filter for the specific key and extract DIDs
        const dids: string[] = [];
        for (const grantPath of listResult.data.keys) {
          // Path format: {recipientDID}/{key}
          // The key may contain slashes, so we need to match the suffix
          if (grantPath.endsWith(`/${key}`)) {
            const did = grantPath.slice(
              0,
              grantPath.length - key.length - 1
            );
            if (did) {
              dids.push(did);
            }
          }
        }

        return ok(dids);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause:
            toError(error),
        });
      }
    }) as Promise<Result<string[], VaultError>>;
  }

  // =========================================================================
  // Phase 3: Key Rotation / Revocation
  // =========================================================================

  /**
   * Revoke a previously issued grant.
   *
   * This performs a full key rotation:
   * 1. Lists current grantees
   * 2. Removes the revoked recipient
   * 3. Re-encrypts the value with a new entry key
   * 4. Re-issues grants to remaining recipients
   *
   * @param key - The key to revoke access to
   * @param recipientDID - The recipient whose access to revoke
   */
  async revoke(
    key: string,
    recipientDID: string
  ): Promise<Result<void, VaultError>> {
    return this.withTelemetry("revoke", key, async () => {
      if (this.usesNetworkEncryption) {
        void recipientDID;
        return vaultError({
          code: "STORAGE_ERROR",
          cause: new Error(
            "Vault key grants are deprecated for network-encrypted vaults; revoke KV and tinycloud.encryption/decrypt grants instead.",
          ),
        });
      }

      if (!this._isUnlocked || !this.masterKey) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before revoking access",
        });
      }

      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required",
        });
      }

      try {
        // Step 1: List all current grantees
        const granteesResult = await this.listGrants(key);
        if (!granteesResult.ok) {
          return granteesResult;
        }

        const remainingGrantees = granteesResult.data.filter(
          (did) => did !== recipientDID
        );

        // Step 2: Delete the grant for the revoked recipient
        const deleteGrantResult = await this.tc.kv.delete(
          `grants/${recipientDID}/${key}`
        );
        // Grant may already be deleted, that's fine

        // Step 3: Fetch and decrypt current value
        const getResult = await this.get(key);
        if (!getResult.ok) {
          return getResult as Result<never, VaultError>;
        }

        const currentEntry = getResult.data;

        // Step 4: Generate new entry key
        const newEntryKey = this.crypto.randomBytes(32);
        const newKeyId = hexEncode(this.crypto.sha256(newEntryKey)).slice(
          0,
          16
        );

        // Step 5: Re-serialize and re-encrypt value with new key
        let plaintext: Uint8Array;
        if (currentEntry.value instanceof Uint8Array) {
          plaintext = currentEntry.value;
        } else {
          plaintext = toBytes(JSON.stringify(currentEntry.value));
        }

        const encrypted = this.crypto.encrypt(newEntryKey, plaintext);

        // Step 6: Encrypt new entry key with master key
        const newKeyBlob = this.crypto.encrypt(this.masterKey, newEntryKey);

        // Step 7: Update metadata with new key ID
        const metadata: Record<string, string> = {
          ...currentEntry.metadata,
          [VaultHeaders.KEY_ID]: newKeyId,
        };

        // Step 8: Store updated key blob
        const keyPayload = JSON.stringify({
          key: base64Encode(newKeyBlob),
          metadata: JSON.stringify({
            keyId: newKeyId,
            ...metadata,
          }),
        });
        const keyPutResult = await this.tc.kv.put(
          `keys/${key}`,
          keyPayload
        );
        if (!keyPutResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to store rotated key blob: ${keyPutResult.error.message}`
            ),
          });
        }

        // Step 9: Store re-encrypted value
        const valuePayload = JSON.stringify({
          data: base64Encode(encrypted),
          metadata,
        });
        const valuePutResult = await this.tc.kv.put(
          `vault/${key}`,
          valuePayload
        );
        if (!valuePutResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to store re-encrypted value: ${valuePutResult.error.message}`
            ),
          });
        }

        // Step 10: Re-issue grants to remaining recipients
        for (const did of remainingGrantees) {
          const grantResult = await this.reencrypt(key, did);
          if (!grantResult.ok) {
            // Continue re-issuing to other recipients even if one fails
            // The failed grant can be re-issued manually
          }
        }

        return ok(undefined);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause:
            toError(error),
        });
      }
    }) as Promise<Result<void, VaultError>>;
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  /**
   * Parse a DID string to extract address and chainId.
   * Expected format: did:pkh:eip155:{chainId}:{address}
   *
   * @param did - The DID to parse
   * @returns Parsed address and chainId, or null if invalid
   */
  private parseDID(
    did: string
  ): { address: string; chainId: number } | null {
    // did:pkh:eip155:{chainId}:{address}
    const parts = did.split(":");
    if (
      parts.length !== 5 ||
      parts[0] !== "did" ||
      parts[1] !== "pkh" ||
      parts[2] !== "eip155"
    ) {
      return null;
    }

    const chainId = parseInt(parts[3], 10);
    const address = parts[4];
    if (isNaN(chainId) || !address) {
      return null;
    }

    return { address, chainId };
  }
}
