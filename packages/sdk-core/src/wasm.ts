/**
 * WASM binding abstraction for TinyCloud SDK.
 *
 * Allows TinyCloudNode to accept either @tinycloud/node-sdk-wasm (Node.js)
 * or @tinycloud/web-sdk-wasm (browser) without direct dependency on either.
 *
 * @packageDocumentation
 */

import type { InvokeAnyFunction, InvokeFunction } from "@tinycloud/sdk-services";

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
  /** Rename a session key ID */
  renameSessionKeyId(oldId: string, newId: string): void;
  /** Get the DID for a session key */
  getDID(keyId: string): string;
  /** Get the JWK representation of a session key */
  jwk(keyId: string): string | undefined;
}
