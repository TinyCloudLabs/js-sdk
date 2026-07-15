/**
 * WASM binding abstraction for TinyCloud SDK.
 *
 * Allows TinyCloudNode to accept either @tinycloud/node-sdk-wasm (Node.js)
 * or @tinycloud/web-sdk-wasm (browser) without direct dependency on either.
 *
 * @packageDocumentation
 */

import type { InvokeAnyFunction, InvokeFunction } from "@tinycloud/sdk-services";
import type { WasmRecapEntry } from "./capabilities";

/**
 * The persisted authority material that must be verified as one unit before a
 * restored session can use its ReCap or lifetime locally.
 */
export interface PersistedSessionProof {
  delegationHeader: { Authorization: string };
  delegationCid: string;
  spaceId: string;
  /** @deprecated Ignored by validation; capabilities come from the signed ReCap. */
  spaces?: Record<string, string>;
  jwk: object;
  /** @deprecated Ignored by validation; the verification method is derived from `jwk`. */
  verificationMethod?: string;
  address: string;
  chainId: number;
  siwe: string;
  signature: string;
}

/** Canonical facts produced by the WASM-side persisted-session verifier. */
export interface ValidatedPersistedSessionProof {
  /** The SIWE expiration exactly as signed, when the SIWE contains one. */
  expiresAt?: string;
  /** @deprecated Legacy caveat-free witness; restore does not trust it. */
  recap?: WasmRecapEntry[];
  /**
   * Exact, caveat-preserving ReCap reconstruction from a verifier that
   * implements persisted-session validation v2. This remains optional so a
   * pre-existing custom binding stays source-compatible, but restore rejects
   * authenticated authority unless this witness is available.
   */
  verifiedRecap?: Array<WasmRecapEntry & { caveats: Record<string, unknown>[] }>;
}

/**
 * Platform-agnostic WASM bindings interface.
 *
 * Each platform provides its own implementation:
 * - node-sdk-wasm: Node.js WASM bindings
 * - web-sdk-wasm: Browser WASM bindings
 */
export interface IWasmBindings {
  /** Invoke a TinyCloud action */
  invoke: InvokeFunction;
  /** Invoke multiple TinyCloud capabilities in one authorization header */
  invokeAny?: InvokeAnyFunction;
  /** Compute a CID for signed invocation bytes. */
  computeCid?: (data: Uint8Array, codec: bigint) => string;
  /** Prepare a session (generate session key, build SIWE message) */
  prepareSession: (params: any) => any;
  /** Complete session setup (create delegation) */
  completeSessionSetup: (params: any) => any;
  /** Ensure an address is in EIP-55 checksummed format */
  ensureEip55: (address: string) => string;
  /** Generate a space ID from address, chain ID, and prefix */
  makeSpaceId: (address: string, chainId: number, prefix: string) => string;
  /** Create a delegation */
  createDelegation: (...args: any[]) => any;
  /**
   * Parse the recap resource of a signed SIWE message into structured
   * permission entries. Used by the capability-chain delegation flow to
   * decide whether a requested delegation is derivable from the current
   * session without a fresh wallet prompt.
   *
   * Returns an empty array when the SIWE has no recap resource.
   */
  parseRecapFromSiwe: (siweString: string) => WasmRecapEntry[];
  /**
   * Optional verifier-v2 parser that preserves ReCap caveats. Kept optional
   * so existing custom bindings remain source-compatible.
   */
  parseVerifiedRecapFromSiwe?: (siweString: string) => Array<WasmRecapEntry & {
    caveats: Record<string, unknown>[];
  }>;
  /** Generate a host SIWE message for space activation */
  generateHostSIWEMessage: (params: any) => string;
  /** Convert a signed SIWE message to delegation headers */
  siweToDelegationHeaders: (params: any) => any;
  /** Get the protocol version */
  protocolVersion: () => number;

  // Vault crypto functions
  vault_encrypt: (key: Uint8Array, plaintext: Uint8Array) => Uint8Array;
  vault_decrypt: (key: Uint8Array, blob: Uint8Array) => Uint8Array;
  vault_derive_key: (
    salt: Uint8Array,
    signature: Uint8Array,
    info: Uint8Array,
  ) => Uint8Array;
  vault_x25519_from_seed: (seed: Uint8Array) => { publicKey: Uint8Array; privateKey: Uint8Array };
  vault_x25519_dh: (
    privateKey: Uint8Array,
    publicKey: Uint8Array,
  ) => Uint8Array;
  vault_random_bytes: (length: number) => Uint8Array;
  vault_sha256: (data: Uint8Array) => Uint8Array;

  /** Factory for session managers */
  createSessionManager: () => ISessionManager;

  /**
   * Verify a persisted EIP-191 SIWE proof and bind it to its reconstructed
   * Cacao header/CID, session DID, address, chain and ReCap spaces. Optional
   * so pre-existing custom bindings remain type-compatible; restore rejects
   * authenticated persisted data when the primitive is unavailable.
   */
  validatePersistedSession?: (
    proof: PersistedSessionProof,
  ) => ValidatedPersistedSessionProof;

  /** Ensure WASM module is initialized (optional — some bindings auto-init) */
  ensureInitialized?: () => Promise<void>;
}

/**
 * Session key manager backed by WASM.
 *
 * Manages Ed25519 session keys used for delegated authentication.
 */
export interface ISessionManager {
  /** Create a new session key with the given ID, returns the DID */
  createSessionKey(id: string): string;
  /**
   * Optional for custom bindings built before persisted-key restore.
   * `restoreSession` detects support at runtime.
   */
  replaceSessionKey?(jwk: object, keyId: string): string;
  /** List every live key so a primary-key replacement cannot discard shares. */
  listSessionKeys?(): string[];
  /** Rename a session key ID */
  renameSessionKeyId(oldId: string, newId: string): void;
  /** Get the DID for a session key */
  getDID(keyId: string): string;
  /** Get the JWK representation of a session key */
  jwk(keyId: string): string | undefined;
}
