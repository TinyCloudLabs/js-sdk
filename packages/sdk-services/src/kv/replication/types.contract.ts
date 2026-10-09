import type {
  KVReadThrough,
  KVReplicaHandle,
  LocalReplicaStatus,
  LocalSyncResult,
  PendingWriteStore,
  ReplicaGrantInfo,
  ReplicationReason,
} from "../../index";

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type HasRequiredKey<T, K extends PropertyKey> = K extends keyof T
  ? {} extends Pick<T, K>
    ? false
    : true
  : false;

type SyncInput = Parameters<KVReplicaHandle["sync"]>[0];
type _SyncStartEpochIsRequired = Assert<HasRequiredKey<SyncInput, "syncStartEpoch">>;
type _SyncStartEpochIsNumber = Assert<Equal<SyncInput["syncStartEpoch"], number>>;
type _SyncResultCarriesEpoch = Assert<
  Equal<Extract<LocalSyncResult, { status: "synced" }>["syncedThroughEpoch"], number>
>;
type _StatusCarriesDurableEpoch = Assert<Equal<LocalReplicaStatus["syncedThroughEpoch"], number>>;
type _GrantStateIsExplicit = Assert<
  Equal<ReplicaGrantInfo["state"], "active" | "pending">
>;
type NetworkObservation = Parameters<KVReadThrough["observeNetworkRequested"]>[0];
type _ObservationReportsReason = Assert<
  Equal<NetworkObservation["reason"], "NETWORK_REQUESTED">
>;
type _ObservationReportsOperation = Assert<Equal<NetworkObservation["op"], "get" | "list">>;
type _ObservationReportsOutcome = Assert<
  Equal<NetworkObservation["outcome"], "found" | "not_found" | "error">
>;
type _ObservationReportsLatency = Assert<Equal<NetworkObservation["latencyMs"], number>>;
type _PendingStoreDeclaresDurability = Assert<HasRequiredKey<PendingWriteStore, "durable">>;
type _PendingStoreDurabilityIsBoolean = Assert<Equal<PendingWriteStore["durable"], boolean>>;
type _UnprovenSinceStartIsAReason = Assert<
  "REPLICA_UNPROVEN_SINCE_START" extends ReplicationReason ? true : false
>;
