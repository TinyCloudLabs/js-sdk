// `@tinycloud/share-sdk/share-root`: a separate entry so bundles that use only
// the main entry (web-sdk) never carry share-root code.
export {
  AGENT_SHARE_ROOT_MAX_LIFETIME_MS, POLICY_OWNER_AUTHORITY_FEATURES, POLICY_OWNER_AUTHORITY_PROBE_TTL_MS, SHARE_ROOT_CLOCK_SKEW_MS,
  SHARE_ROOT_LINK_MAX_LIFETIME_MS, SHARE_ROOT_MAX_LIFETIME_MS, SHARE_ROOT_PREFIX, SHARE_ROOT_REQUEST_MARGIN_MS, ShareRoot, ShareRootError,
  createPolicyOwnerModeProbe, defaultPolicyOwnerModeProbe, ensureShareRoot, readPolicyOwnerAuthorityMode,
} from "./share-root.js";
export type {
  PolicyOwnerModeProbe, ShareRootErrorCode, ShareRootErrorDetails, ShareRootKind, ShareRootLink, ShareRootOptions, ShareRootOwnerAuthority,
  ShareRootPolicySigner, ShareRootRecord, ShareRootScope,
} from "./share-root.js";
export { assertNonExtractableShareKey, signShareKeyDelegation } from "./share-key-signer.js";
export type { ShareKeyDelegationInput, ShareKeySigner } from "./share-key-signer.js";
export { decodeOwnerRootCacao, ownerRootCacaoCid, type DecodedOwnerRootCacao } from "./owner-root-cacao.js";
