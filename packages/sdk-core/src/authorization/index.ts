/**
 * TinyCloud SDK Authorization Module
 *
 * This module provides authorization and capability management
 * for the TinyCloud SDK.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import {
 *   CapabilityKeyRegistry,
 *   ICapabilityKeyRegistry,
 *   createCapabilityKeyRegistry,
 * } from "@tinycloud/sdk-core/authorization";
 *
 * // Create a capability registry
 * const registry = createCapabilityKeyRegistry();
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

export {
  // Class
  CapabilityKeyRegistry,
  // Interface
  ICapabilityKeyRegistry,
  // Factory
  createCapabilityKeyRegistry,
  // Types
  StoredDelegationChain,
  // Error codes
  CapabilityKeyRegistryErrorCodes,
  CapabilityKeyRegistryErrorCode,
} from "./CapabilityKeyRegistry";

// SignStrategy types
export {
  // Request/Response types
  SignRequest,
  SignResponse,
  SignCallback,
  OpenKeySigningStrategyOptions,
  OpenKeySigningRequestBody,
  OpenKeySigningResponseBody,
  OpenKeyCallbackStrategy,
  // Strategy types
  AutoSignStrategy,
  AutoRejectStrategy,
  CallbackStrategy,
  EventEmitterStrategy,
  SignStrategy,
  // Default
  defaultSignStrategy,
  createOpenKeyCallbackSigningStrategy,
} from "./strategies";

// Space creation handler types
export {
  // Context
  SpaceCreationContext,
  // Interface
  ISpaceCreationHandler,
  // Default implementation
  AutoApproveSpaceCreationHandler,
  // Default instance
  defaultSpaceCreationHandler,
} from "./spaceCreation";

// Versioned OpenKey authorization protocol (v1).
//
// Consumers use these types to accept a rich authorization result from
// OpenKey and validate its structure at the trust boundary before completing
// a TinyCloud session with the returned `signedMessage`.
export {
  TinyCloudAuthorizationRequestV1,
  TinyCloudAuthorizationResultV1,
  TinyCloudEffectiveGrantV1,
  CapabilityPresentationEnvelopeV1,
  validateAuthorizationResultV1,
  isPlausibleOpenKeyActionId,
  OPENKEY_ACTION_ID_SEPARATOR,
  // Signed-SIWE narrowing verification: used by node-sdk to prove the OpenKey
  // widget only narrowed (never broadened) the caller's prepared authorization.
  ImmutableSiweFields,
  RecapAttenuation,
  extractImmutableSiweFields,
  diffImmutableSiweFields,
  extractRecapAttenuations,
  unauthorizedRecapCapabilities,
} from "./openkey-protocol";
