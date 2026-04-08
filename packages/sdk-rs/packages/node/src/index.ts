/**
 * @tinycloud/node-sdk-wasm
 *
 * TinyCloud WASM bindings for Node.js environments.
 *
 * @packageDocumentation
 */

// Re-export everything from the Node.js WASM build
// Note: The wasm/ directory is created during build from wasm-pack output
export * from "./wasm/index.cjs";

// Also export common utilities directly for convenience
export {
  TCWSessionManager,
  prepareSession,
  completeSessionSetup,
  invoke,
  invokeAny,
  makeSpaceId,
  ensureEip55,
  signEthereumMessage,
  signSecp256k1,
  initPanicHook,
  exportKey,
  importKey,
  importKeyFromEnvValue,
  // Space hosting
  generateHostSIWEMessage,
  siweToDelegationHeaders,
  // Delegation creation
  createDelegation,
  // Protocol version
  protocolVersion,
  // Vault crypto
  vault_encrypt,
  vault_decrypt,
  vault_derive_key,
  vault_x25519_from_seed,
  vault_x25519_dh,
  vault_random_bytes,
  vault_sha256,
} from "./wasm/index.cjs";

// Re-export types for TypeScript consumers
export type {
  HostConfig,
  Session,
  SessionConfig,
  SiweConfig,
} from "./wasm/index.cjs";

// Note: CreateDelegationWasmParams and CreateDelegationWasmResult types are available
// from @tinycloud/sdk-core for TypeScript consumers
