// Build-only SDK-core entrypoint for operations' capability checks and compact verifier.
// The operations tsup alias imports this without loading SDK-core's full CJS entrypoint.
export { canonicalizeRecapCaveats, isCapabilitySubset } from "./capabilities.js";
export { parseSignedCompactUcanAttenuation } from "./policy/unified.js";
export { parseSpaceUri } from "./spaces/index.js";
export { registryOwnerKeyV2 } from "./registry-verdict.js";
export { verifyRegistryCacheEntry } from "./registry-cache.js";
export { warnRegistryDefaultNode } from "./registry-policy.js";

export { sameTinyCloudNode } from "./tinycloud-node";
