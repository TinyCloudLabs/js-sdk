import type {
  KVReplicaSpec,
  ReplicaGatedHandle,
  ReplicaGatedSpec,
  ReplicaGatedStorage,
} from "@tinycloud/sdk-services/kv/replication";

import { indexedDbReplicaStorage } from "./client.js";

declare const adapter: ReturnType<typeof indexedDbReplicaStorage>;
declare const legacySpec: KVReplicaSpec;
declare const gatedSpec: ReplicaGatedSpec;

// The concrete browser factory must expose the strict Phase 2 contract.
const gatedStorage: ReplicaGatedStorage = adapter;
const opened: Promise<ReplicaGatedHandle> = adapter.open(gatedSpec);
// @ts-expect-error A Phase 1 spec has neither a required stamp nor grant policy.
adapter.open(legacySpec);

void gatedStorage;
void opened;
