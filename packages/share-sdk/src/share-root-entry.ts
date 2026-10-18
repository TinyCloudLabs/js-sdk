// `@tinycloud/share-sdk/share-root`: a separate entry so bundles that use only
// the main entry (web-sdk) never carry share-root code.
//
// Owner wallet approvals per action (TC-1423 D3):
// - `:share` network (`ensureShareNetwork`): 1, once per owner; 0 when it exists.
// - Share root (`ShareRoot.create` / a re-root in `ensureShareRoot`): 1.
// - Bearer link under a root (`publishRootBearerLink`): 0.
// - Revoke of one bearer link by the share key (`revokeRootBearerLink`): 0;
//   by the owner (owner SIWE `POST /revoke`): 1.
// - Per-share grant (`ShareGrant.create`; every email/domain and edit share
//   while the Node does not advertise `enforce`): 1 per share. Its policy
//   registration through `publishAuthority`: 0.
// - Policy roots under a `kv+share-decrypt` root (`policyRootSigner`): 0.
// - Owner revoke of one root or grant (owner SIWE `POST /revoke`): 1 each.
// - Kill-all, until the Node ships network-scoped revoke controls (NODE-B2
//   N4'): 1 for a space-scoped revoke control, which covers kv-only roots and
//   their links, plus 1 owner SIWE per live decrypt-bearing CACAO (each
//   per-share grant, each `kv+share-decrypt` root), as the per-CID fallback.
//   With N4': 1 in total.
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
export { ShareGrant, type ShareGrantAccess, type ShareGrantRecord } from "./share-grant.js";
export { ensureShareNetwork, shareNetworkIdFor, type ShareNetworkResult } from "./share-network.js";
export { publishRootBearerLink, revokeRootBearerLink, type RootBearerLink } from "./share-root-link.js";
