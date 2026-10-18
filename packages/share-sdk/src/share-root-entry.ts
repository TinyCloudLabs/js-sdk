// `@tinycloud/share-sdk/share-root`: a separate entry so bundles that use only
// the main entry (web-sdk) never carry share-root code.
//
// Owner wallet approvals per action (TC-1423 D3, per-share networks):
// - Share root (`ShareRoot.create` / a re-root in `ensureShareRoot`): 1. It is
//   kv/bearer only and never decrypts.
// - Bearer link under a root (`publishRootBearerLink`): 0.
// - Revoke of one bearer link by the share key (`revokeRootBearerLink`): 0;
//   by the owner (owner SIWE `POST /revoke`): 1.
// - Addressed (email/domain) or edit share (`ShareGrant.prepare` +
//   `approve`): 1 per share, covering its exact KV key and its own network
//   `share-<shareId>`. Creating that network (`ensureNetwork`), policy
//   registration (`publishAuthority`) and retiring the network
//   (`retireNetwork`) while the key is held: 0. A shareId that is not
//   network-safe, or whose network already exists or was retired, fails
//   before the prompt: 0.
// - Owner read-back of an edit share (`openEditShare`): 1, key lives <= 1 h.
// - Revoke one share (`revokeShareGrant`): 0 to retire its network, then 1
//   owner SIWE for the grant. One root or link: 1 owner SIWE each.
// - Kill-all (`planShareControlBatches` + `runShareControlBatch`): 1 per
//   control. Controls name only per-share networks (never `:default`,
//   `:share` or any other network) and are sized by bytes: each signed
//   `Authorization` value stays within SHARE_CONTROL_HEADER_BUDGET_BYTES
//   (30,000; the production ingress refuses values above 32,751 bytes),
//   which fits 34 shares per control with the `applications`/`default`
//   delegation rows. Every control carries those rows, so on v1.20.6 and
//   NODE-B2 N4' a kill-all of L shares costs ceil(L/34) approvals (measured
//   live across two controls). Node 1.21.0 and N1b refuse control revokes of
//   decrypt-bearing grants: each such grant then needs 1 more owner SIWE
//   (`revokeFallback`), so L shares cost ceil(L/34) + L. The networks are
//   retired first either way, so decrypt is cut before any grant revoke.
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
export { publishRootBearerLink, revokeRootBearerLink, type RootBearerLink } from "./share-root-link.js";
