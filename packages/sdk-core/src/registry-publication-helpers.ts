// Source-only boundary: the publication build resolves this to the public Core root,
// sharing its validation-error constructors without loading the root barrel in source tests.
export {
  canonicalLocationPayloadV2,
  exactHttpOrigin,
  LocationRecordValidationError,
  LocationRegistryHttpError,
  OWNER_NODE_BINDING_TIMEOUT_MS,
  signLocationRecordV2,
  validateLocationRecordV2,
  validateLocationRecordV2Payload,
  verifyLocationRecordV2,
  type LocationRecordSigner,
  type LocationRecordV2,
  type LocationRecordV2Payload,
} from "./location";
export { verifyRegistryCacheEntry, type RegistryCacheStore } from "./registry-cache";
export type { RegistrySequenceStore } from "./registry-policy";
export { registryOwnerKeyV2 } from "./registry-verdict";
