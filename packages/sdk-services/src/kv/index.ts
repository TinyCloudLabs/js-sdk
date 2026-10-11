/**
 * KV Service Exports
 *
 * Key-Value storage service for TinyCloud SDK.
 */

// Service implementation
export { KVService } from "./KVService";

// Prefixed service implementation
export { PrefixedKVService, IPrefixedKVService } from "./PrefixedKVService";

// Interface
export { IKVService } from "./IKVService";

// Types
export {
  DEFAULT_SIGNED_READ_URL_EXPIRY_MS,
  KVServiceConfig,
  KVGetOptions,
  KVPutOptions,
  KVBatchPutItem,
  KVBatchPutOptions,
  KVBatchPutResponse,
  KVBatchReadResponse,
  KVListOptions,
  KVDeleteOptions,
  KVHeadOptions,
  KVCreateSignedReadUrlOptions,
  KVResponse,
  KVListResponse,
  KVSignedReadUrlResponse,
  KVResponseHeaders,
  KVAction,
  KVActionType,
} from "./types";
export type {
  KVChange,
  KVChangesAuthority,
  KVChangesOptions,
  KVChangesResponse,
} from "./types";
export type {
  AuthorityRefusal,
  KVListPage,
  KVReadThrough,
  KVReplicaHandle,
  KVReplicaSpec,
  KVReplicaStorage,
  KVReplicationController,
  KVReplicationDeps,
  LocalGetResult,
  LocalListResult,
  LocalReadMeta,
  LocalReplicaStatus,
  LocalSyncResult,
  PendingWriteRecord,
  PendingWriteState,
  PendingWriteStore,
  PinnedKey,
  PurgeTarget,
  ReplicaAuthorityState,
  ReplicaCoverage,
  ReplicaDevice,
  ReplicaGrantInfo,
  ReplicaState,
  ReplicaStatusEntry,
  ReplicationAuthority,
  ReplicationControl,
  ReplicationEvent,
  ReplicationIdentity,
  ReplicationOptions,
  ReplicationPurgeReport,
  ReplicationReason,
  ReplicationScheduler,
  ResolvedReplicationOptions,
} from "./replication/types";
export { CLEAR_PENDING_WARNING } from "./replication/constants";
export {
  canonicalReplicationIdentity,
  replicationIdentityKey,
} from "./replication/identity";
export { kvPrefixCovers, requiresSecretsOptIn } from "./replication/scope";
