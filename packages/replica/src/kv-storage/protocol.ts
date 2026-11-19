/**
 * Main thread ↔ worker RPC of `@tinycloud/replica/kv-storage`. Requests are
 * `{id, op, …}`; replies are `{id, ok:true, result}` or `{id, ok:false, err}`;
 * the worker posts unsolicited `{event}` messages. One worker serves every
 * handle of one storage instance; `handle` names the worker-side handle.
 */
import type {
  LocalListResult,
  LocalReplicaStatus,
  LocalSyncResult,
  ReplicaDevice,
  ReplicaDenyOutcome,
  ReplicaGrantInfo,
  ReplicaGrantPolicy,
  ReplicaPeerCommit,
  ReplicaQuotaSpec,
  ReplicaSessionStamp,
  ReplicationIdentity,
} from "@tinycloud/sdk-services/kv/replication";

/** The cloneable part of `KVReplicaSpec` (functions such as `fetch` and `onPeerCommit` stay on the main thread). */
export type KvOpenSpec = {
  identity: ReplicationIdentity;
  space: string;
  prefix: string;
  allowSecrets: boolean;
  device?: ReplicaDevice;
  stamp?: ReplicaSessionStamp;
  grantPolicy?: ReplicaGrantPolicy;
  quota?: ReplicaQuotaSpec;
  contentFetch?: "eager" | "lazy";
};

export type KvRequest =
  | { op: "open"; spec: KvOpenSpec }
  | { op: "get"; handle: number; key: string }
  | { op: "list"; handle: number; prefix: string; after?: string; limit?: number }
  | { op: "grant"; handle: number }
  | { op: "installGrant"; handle: number; ucan: string }
  | { op: "sync"; handle: number; syncStartEpoch: number }
  /** Abort the in-flight request `target` (a sync); answered once the abort is delivered. */
  | { op: "cancel"; target: number }
  | { op: "status"; handle: number }
  /** Cancel and await the handle's syncs, then release it. */
  | { op: "close"; handle: number };

export type KvOpenResult = { handle: number; deviceDid: string; partitionId: string };

/** `get` crosses with its value as a transferable ArrayBuffer. */
export type KvGetResult =
  | { status: "present"; key: string; value: ArrayBuffer; etag: string; metadata: Record<string, string>; meta: LocalListResult["meta"] }
  | { status: "content_missing"; key: string; etag: string; metadata: Record<string, string>; meta: LocalListResult["meta"] }
  | { status: "deleted" | "absent" | "coverage_incomplete" | "not_covered"; key: string; meta: LocalListResult["meta"] };

export type KvResults = {
  open: KvOpenResult;
  get: KvGetResult;
  list: LocalListResult;
  grant: ReplicaGrantInfo | null;
  installGrant: ReplicaGrantInfo;
  sync: LocalSyncResult;
  cancel: { cancelled: boolean };
  status: Omit<LocalReplicaStatus, "persisted" | "purgePending">;
  close: { closed: true };
};

export type KvWireError = { code: string; message: string; detail?: Record<string, unknown> };

/** Replies to open and handle operations carry the stamp they ran under (`ReplicaStampedReply`). */
export type KvReply = { id: number; ok: true; result: unknown; stamp?: ReplicaSessionStamp } | { id: number; ok: false; err: KvWireError };

/** Worker asks the main-thread lifecycle to durably deny an expired account. */
export type KvConsentExpiryAck =
  | { op: "consentExpiryAck"; requestId: number; ok: true; outcome: ReplicaDenyOutcome }
  | { op: "consentExpiryAck"; requestId: number; ok: false; message: string };

export type KvEvent =
  | { event: "ready" }
  | { event: "consentExpiry"; requestId: number }
  /** Another tab committed a sync for this handle's partition. */
  | { event: "peerCommit"; handle: number; info: ReplicaPeerCommit };

/** The BroadcastChannel message a worker sends its siblings after a sync that committed pages. */
export type KvChannelMessage = { type: "committed"; partitionId: string; info: ReplicaPeerCommit };
