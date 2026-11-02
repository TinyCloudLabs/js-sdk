/**
 * `@tinycloud/share-sdk/share-index`: the shared share index (TC-1432 design C).
 * Published as its own entry so browser bundles that import the package root
 * (web-sdk) do not carry it. Reference: `docs/share-index.md`.
 */
export { AGENT_ID_LENGTH, INDEX_MAIN_KEY, SHARE_RECORDS_VAULT_PREFIX, agentIdFromDid, agentRecordKey, agentRecordPrefix, classifyRecordKey, isAgentId, isShareId, type ClassifiedRecordKey } from "./ids.js";
export { validateShareLink, type ShareLinkCheck, type ShareLinkShape } from "./link.js";
export { deriveAgentKeyMaterial, type AgentKeyMaterial } from "./agent-key.js";
export { AGENT_RECORD_VERSION, MAX_AGENT_RECORD_BYTES, SUPPORTED_AGENT_RECORD_V, AgentRecordError, OwnerUnwrapUnavailableError, agentRecordBinding, openAgentRecordAsAgent, openAgentRecordAsOwner, parseStoredAgentRecord, sealAgentRecord, type AgentRecordFailure, type AgentRecordHeader, type OwnerNetworkUnwrap, type OwnerNetworkWrap, type StoredAgentRecord } from "./agent-record.js";
export { INVALID_ETAG_MESSAGE, createTinyCloudShareIndexBackend, type ShareDocumentRead, type ShareIndexBackend, type ShareListResult, type ShareRawRead, type ShareWriteCondition, type ShareWriteResult, type TinyCloudShareIndexBackendOptions, type TinyCloudShareIndexClient, type VaultNetworkRead } from "./backend.js";
export { DEFAULT_CAS_POLICY, ShareIndexCasError, type CasPolicy, type ShareIndexCasErrorCode } from "./cas.js";
export { AgentShareRecordStore, WebShareRecordStore, type AgentShareRecordStoreOptions } from "./record-store.js";
export { INDEX_SCHEMA_VERSION, ShareRecordSchemaError, checkAgentRecordSchema, displayName, isSpaceOwnedBy, parseIndexDocument, project, registeredAtFits, type AgentRecordSchemaContext, type ShareIndexAgentEntry, type ShareIndexArchiveDocument, type ShareIndexDocument, type ShareIndexRow, type ShareProofState } from "./schema.js";
export { claimRank, decideClaim, type ClaimDecision } from "./precedence.js";
export { verifyAgentRecordChain, type ChainContext, type ChainVerdict, type ShareRegistrationKey } from "./verify/chain.js";
export { parseSignedUcan, type SignedUcanDelegation } from "./verify/ucan.js";
export { verifyOwnerSessionDelegation, type ParsedSiweCacao, type SiweCacaoParser } from "./verify/session.js";
export { verifyPolicyEnforcementDelegation } from "./verify/enforcement-delegation.js";
export { attenuationCovers, type Attenuation } from "./verify/attenuation.js";
export { DEFAULT_SHARE_INDEX_LIMITS, MemoryShareIndexOutbox, SenderShareIndex, headerBytes, type AgentRejectReason, type SenderShareIndexOptions, type ShareIndexFlushResult, type ShareIndexLimits, type ShareIndexLoad, type ShareIndexOp, type ShareIndexOutbox, type ShareIndexReconcileReport, type ShareIndexWriteOutcome, type ShareIndexWriteStatus, type ShareStatusPort } from "./sender-share-index.js";
export type { SenderShareRecord, SenderShareRecordProofs } from "../history.js";
export { checkRegistrationReceipt, type CheckedRegistration, type RegistrationKey } from "./verify/registration.js";
export { verifyEnvelopeV3At } from "./verify/policy-v3.js";
export { DeliveryMaterialError, STORED_DELIVERY_MATERIAL_KEYS, assertLinkBoundToMaterial, compactShareRecord, expandShareRecord, openDeliveryEnvelope, restoreShareRecordLink, type StoredDeliveryMaterial, type StoredFullShareLink, type StoredShareRecord } from "./delivery.js";
