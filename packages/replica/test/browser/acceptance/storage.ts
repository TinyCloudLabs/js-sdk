import type { KVReplicaStorage } from "@tinycloud/sdk-services/kv/replication";

/**
 * The replication storage the fixture hands to `TinyCloudWeb`. This is the one
 * swap point: until the S1 IndexedDB `KVReplicaStorage` adapter lands it is
 * `undefined`, so `replication.enabled` fails loudly at sign-in and the
 * scenarios that need it fail under `TC858_ACCEPTANCE_STRICT=1`.
 */
export const replicationStorage: KVReplicaStorage | undefined = undefined;
