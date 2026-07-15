/**
 * WASM binding abstraction for TinyCloud SDK.
 *
 * Allows TinyCloudNode to accept either @tinycloud/node-sdk-wasm (Node.js)
 * or @tinycloud/web-sdk-wasm (browser) without direct dependency on either.
 *
 * @packageDocumentation
 */

import type {
  InvokeAnyFunction,
  InvokeFunction,
} from "@tinycloud/sdk-services";
import type { WasmRecapEntry } from "./capabilities";
import type {
  NativeVerifiedRecipientDidDelegationBundleV2,
  RecipientDidDelegationBundleV2,
} from "./recipientDidSharing";

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
   * Atomically verify a recipient-DID delegation bundle without network I/O.
   *
   * Optional so custom and older runtimes remain source compatible. Consumers
   * must fail closed when this is absent; parsing individual artifacts is not
   * an authority proof. One successful call MUST jointly verify genuine
   * Cacao/UCAN signatures and recomputed CIDs; SIWE ReCap root authority;
   * issuer-to-audience and cited-parent continuity; resource/action/caveat and
   * delegation-mode attenuation at every edge; not-before/expiry bounds; and
   * exact, complete, authority-contributing proof membership in the supplied
   * root-to-leaf order. The returned owner, session principal + DID URL,
   * recipient, proof/grant CIDs, scope, and effective times MUST all come from
   * that same verified graph. No node fetch, registry lookup, status request,
   * or unsigned discovery is permitted inside this operation.
   *
   * `nowUnixSeconds` is an integer UTC epoch supplied by the caller so
   * verification is deterministic and testable. Native errors cross the WASM
   * boundary as rejection; they MUST NOT be converted into partial output.
   */
  verifyRecipientDidDelegationBundleV2?: (
    bundle: RecipientDidDelegationBundleV2,
    nowUnixSeconds: bigint,
  ) => NativeVerifiedRecipientDidDelegationBundleV2;
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
  vault_x25519_from_seed: (seed: Uint8Array) => {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  };
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
