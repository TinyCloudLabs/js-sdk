/**
 * Spaces Module Exports
 *
 * Provides space management functionality for TinyCloud SDK.
 *
 * @packageDocumentation
 */

// Space object
export {
  Space,
  ISpace,
  SpaceConfig,
  ISpaceScopedDelegations,
  ISpaceScopedSharing,
} from "./Space";

// SpaceService
export {
  SpaceService,
  ISpaceService,
  SpaceServiceConfig,
  SpaceErrorCodes,
  SpaceErrorCode,
  createSpaceService,
  // URI utilities
  parseSpaceUri,
  buildSpaceUri,
  // Public space utility
  makePublicSpaceId,
  // Delegation creation types
  SpaceDelegationParams,
  CreateDelegationFunction,
  // Space hosting type
  HostSpaceFunction,
} from "./SpaceService";

// Validation schemas and types
export {
  // Config validation
  SpaceConfigSchema,
  SpaceServiceConfigSchema,
  SpaceDelegationParamsSchema,
  validateSpaceConfig,
  validateSpaceServiceConfig,
  validateSpaceDelegationParams,
  // Server response validation
  ServerDelegationInfoSchema,
  ServerDelegationsResponseSchema,
  ServerOwnedSpaceSchema,
  ServerOwnedSpacesResponseSchema,
  ServerCreateSpaceResponseSchema,
  ServerSpaceInfoResponseSchema,
  validateServerDelegationsResponse,
  validateServerOwnedSpacesResponse,
  validateServerCreateSpaceResponse,
  validateServerSpaceInfoResponse,
  // Types
  type ValidationError,
  type ServerDelegationInfo,
  type ServerDelegationsResponse,
  type ServerOwnedSpace,
  type ServerOwnedSpacesResponse,
  type ServerCreateSpaceResponse,
  type ServerSpaceInfoResponse,
} from "./spaces.schema.js";
