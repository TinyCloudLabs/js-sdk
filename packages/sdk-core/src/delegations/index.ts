/**
 * TinyCloud SDK Delegations Module
 *
 * This module provides delegation and sharing link functionality
 * for the TinyCloud SDK. It extracts and improves upon the delegation
 * functionality previously in ITinyCloudStorage.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import {
 *   DelegationManager,
 *   SharingService,
 *   Delegation,
 *   CreateDelegationParams,
 * } from "@tinycloud/sdk-core/delegations";
 *
 * // Create delegation manager
 * const delegations = new DelegationManager({
 *   hosts: ["https://node.tinycloud.xyz"],
 *   session,
 *   invoke,
 * });
 *
 * // Create a delegation
 * const result = await delegations.create({
 *   delegateDID: "did:pkh:eip155:1:0x...",
 *   path: "shared/",
 *   actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
 * });
 * ```
 */

// Types
export {
  // Result pattern
  Result,
  DelegationError,
  DelegationErrorCodes,
  DelegationErrorCode,

  // Delegation types
  Delegation,
  CreateDelegationParams,
  DelegationChain,
  DelegationApiResponse,

  // Configuration types
  DelegationManagerConfig,
  KeyProvider,

  // v2 types for CapabilityKeyRegistry
  JWK,
  KeyType,
  KeyInfo,
  CapabilityEntry,
  DelegationRecord,
  DelegationChainV2,
  DelegationDirection,
  DelegationFilters,
  SpaceOwnership,
  SpaceInfo,
  ShareSchema,
  ShareLink,
  ShareLinkData,
  IngestOptions,
  GenerateShareParams,

  // WASM delegation types
  CreateDelegationWasmParams,
  CreateDelegationWasmResult,
  DelegatedResource,
} from "./types";

// Classes
export { DelegationManager } from "./DelegationManager";

// v2 SharingService
export {
  SharingService,
  createSharingService,
  ISharingService,
  SharingServiceConfig,
  EncodedShareData,
  ReceiveOptions,
  ShareAccess,
} from "./SharingService";

// SharingService Schemas and Validation
export {
  EncodedShareDataSchema,
  ReceiveOptionsSchema,
  SharingServiceConfigSchema,
  validateEncodedShareData,
  validateReceiveOptions,
  validateSharingServiceConfig,
} from "./SharingService.schema.js";
