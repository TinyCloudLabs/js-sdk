/**
 * NodeWasmBindings - Default IWasmBindings implementation for Node.js.
 *
 * Wraps @tinycloud/node-sdk-wasm functions into the IWasmBindings interface.
 * This is used as the default when no custom wasmBindings is provided in config.
 *
 * @packageDocumentation
 */

import {
  invoke,
  invokeAny,
  computeCid,
  prepareSession,
  completeSessionSetup,
  validatePersistedSession,
  validateSessionGrant,
  ensureEip55,
  makeSpaceId,
  createDelegation,
  parseRecapFromSiwe,
  parseVerifiedRecapFromSiwe,
  generateHostSIWEMessage,
  siweToDelegationHeaders,
  protocolVersion,
  TCWSessionManager,
  initPanicHook,
  vault_encrypt,
  vault_decrypt,
  vault_derive_key,
  vault_x25519_from_seed,
  vault_x25519_dh,
  vault_random_bytes,
  vault_sha256,
} from "@tinycloud/node-sdk-wasm";
import { assertUcanExpiryWithinLimit } from "./ucanExpiry";
import type {
  IWasmBindings,
  ISessionManager,
  PersistedSessionProof,
} from "@tinycloud/sdk-core";

/**
 * Node.js WASM bindings using @tinycloud/node-sdk-wasm.
 *
 * This is the default IWasmBindings implementation for Node.js environments.
 * Browser environments provide their own BrowserWasmBindings via config.wasmBindings.
 */
export class NodeWasmBindings implements IWasmBindings {
  private static panicHookInitialized = false;

  constructor() {
    // Initialize WASM panic hook once (improves error messages from WASM)
    if (!NodeWasmBindings.panicHookInitialized) {
      initPanicHook();
      NodeWasmBindings.panicHookInitialized = true;
    }
  }

  invoke = invoke;
  invokeAny = invokeAny;
  computeCid = computeCid;
  prepareSession = prepareSession;
  completeSessionSetup = completeSessionSetup;
  validatePersistedSession(proof: PersistedSessionProof) {
    return validatePersistedSession(proof);
  }
  validateSessionGrant(proof: PersistedSessionProof) {
    return validateSessionGrant(proof);
  }
  ensureEip55 = ensureEip55;
  makeSpaceId = makeSpaceId;
  /** The WASM fails past 2255-06-05T23:47:34Z with an opaque range error; refuse first, with the date. */
  createDelegation = (...args: Parameters<typeof createDelegation>) => {
    assertUcanExpiryWithinLimit(Number(args[4]) * 1000);
    return createDelegation(...args);
  };
  parseRecapFromSiwe = parseRecapFromSiwe;
  parseVerifiedRecapFromSiwe = parseVerifiedRecapFromSiwe;
  generateHostSIWEMessage = generateHostSIWEMessage;
  siweToDelegationHeaders = siweToDelegationHeaders;
  protocolVersion = protocolVersion;

  // Vault crypto
  vault_encrypt = vault_encrypt;
  vault_decrypt = vault_decrypt;
  vault_derive_key = vault_derive_key;
  vault_x25519_from_seed = vault_x25519_from_seed;
  vault_x25519_dh = vault_x25519_dh;
  vault_random_bytes = vault_random_bytes;
  vault_sha256 = vault_sha256;

  createSessionManager(): ISessionManager {
    return new TCWSessionManager();
  }

  // No ensureInitialized needed — Node WASM is synchronous
}
