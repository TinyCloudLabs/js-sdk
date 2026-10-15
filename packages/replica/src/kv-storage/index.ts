/**
 * `@tinycloud/replica/kv-storage`: the browser `KVReplicaStorage` for
 * read-through replication (`replication.storage`). ESM only — the worker is
 * resolved through `new URL("./kv-storage.worker.js", import.meta.url)`.
 */
export { indexedDbReplicaStorage } from "./client.js";
export type { IndexedDbReplicaStorageOptions } from "./client.js";
export { FIRST_INSTALL_KEY_PREFIX, KV_DATABASE, KV_STORE, identityKeyHashOf, kvPartitionEraser, openKvDatabase, partitionIdOf } from "./schema.js";
export { saltedHash } from "../profile-gate/saltedHash.js";
export { ReplicaError, ReplicaErrorCode, isReplicaError } from "../errors.js";
