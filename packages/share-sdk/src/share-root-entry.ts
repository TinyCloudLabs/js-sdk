// `@tinycloud/share-sdk/share-root`: a separate entry so bundles that use only
// the main entry (web-sdk) never carry share-root code.
//
// Owner wallet approvals per action (TC-1423 D3, per-share networks):
// - Share root (`ShareRoot.create` / a re-root in `ensureShareRoot`): 1. It is
//   kv/bearer only and never decrypts.
// - Bearer link under a root (`signBearerLink`): 0.
// - Addressed (email/domain) or edit share (`ShareGrant.prepare` +
//   `approve`): 1 per share, covering its exact KV key and its own network
//   `share-<shareId>`. Creating that network (`ensureNetwork`), policy
//   registration (`publishAuthority`) and retiring the network
//   (`retireNetwork`) while the key is held: 0. A shareId that is not
//   network-safe fails before the prompt: 0.
// - Owner read-back of an edit share (`openEditShare`): 1, key lives <= 1 h.
// - Revoke one share (`revokeShareGrant`): 0 to retire its network, then 1
//   owner SIWE for the grant. One root or link: 1 owner SIWE each.
// - Kill-all (`planShareControlBatches` + `runShareControlBatch`): 1 per
//   control. Controls are sized by bytes: each signed `Authorization` value
//   stays within SHARE_CONTROL_HEADER_BUDGET_BYTES (30,000; the production
//   ingress refuses values above 32,751 bytes), which fits 34 shares per
//   control (35 with no space rows). The first control also names the
//   `applications`/`default` delegation rows (roots and links). Node 1.21.0
//   refuses control revokes of decrypt-bearing grants (v1.20.6 and NODE-B2
//   N4' accept them): each such grant then needs 1 owner SIWE
//   (`revokeFallback`); the networks are retired first either way, so
//   decrypt is cut before any grant revoke.
export {
  AGENT_SHARE_ROOT_MAX_LIFETIME_MS, SHARE_ROOT_CLOCK_SKEW_MS, SHARE_ROOT_LINK_MAX_LIFETIME_MS, SHARE_ROOT_MAX_LIFETIME_MS, SHARE_ROOT_PREFIX,
  SHARE_ROOT_REQUEST_MARGIN_MS, ShareRoot, ShareRootError, ensureShareRoot,
} from "./share-root.js";
export type {
  SharePolicySigner, ShareRootErrorCode, ShareRootErrorDetails, ShareRootKind, ShareRootLink, ShareRootOptions, ShareRootOwnerAuthority, ShareRootRecord,
} from "./share-root.js";
export { assertNonExtractableShareKey, signShareKeyDelegation } from "./share-key-signer.js";
export type { ShareKeyDelegationInput, ShareKeySigner } from "./share-key-signer.js";
export { decodeOwnerRootCacao, ownerRootCacaoCid, type DecodedOwnerRootCacao } from "./owner-root-cacao.js";
export { EDIT_SHARE_READER_MAX_LIFETIME_MS, ShareGrant, assertShareGrantPath, openEditShare, revokeShareGrant } from "./share-grant.js";
export type { EditShareReader, PendingShareGrant, ShareGrantAccess, ShareGrantRecord, ShareGrantRequest, ShareGrantRow, ShareGrantRowState } from "./share-grant.js";
export { SHARE_NETWORK_NAME_PREFIX, assertNetworkSafeShareId, perShareNetworkIdFor } from "./share-network.js";
export { SHARE_CONTROL_HEADER_BUDGET_BYTES, SHARE_CONTROL_LIFETIME_MS, planShareControlBatches, runShareControlBatch } from "./share-control.js";
export type { ShareControlBatch, ShareControlOwner, ShareControlResult, ShareControlTarget } from "./share-control.js";
