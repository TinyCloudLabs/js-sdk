/**
 * The main-thread ↔ worker RPC contract (TC-19). Requests are `{id, op, …}`;
 * replies are `{id, ok:true, result}` or `{id, ok:false, err}`; the worker
 * posts unsolicited `{event}` messages. Values cross as transferable
 * ArrayBuffers, never as broadcast events.
 */
import type { ReplicaStatus, SyncReport } from "../index.js";

export type OpenRequest = {
  op: "open";
  host: string;
  space: string;
  prefix: string;
  name?: string;
  /** The principal the grant is issued for; partitions the database (spec §8). */
  grantSubject?: string;
  allowSecrets?: boolean;
  /** `navigator.storage.persist()` result from the main thread. */
  persisted?: boolean;
};

export type InstallGrantRequest = { op: "installGrant"; delegation: string };
export type SyncRequest = { op: "sync"; limit?: number };
export type GetRequest = { op: "get"; key: string };
export type ListRequest = { op: "list"; prefix?: string; after?: string; limit?: number };
export type StatusRequest = { op: "status" };
export type ResetRequest = { op: "reset"; purge?: boolean };
export type RetentionRequest = { op: "setRetention"; grantCid: string | null };
export type CloseRequest = { op: "close" };

export type ReplicaRequest =
  | OpenRequest
  | InstallGrantRequest
  | SyncRequest
  | GetRequest
  | ListRequest
  | StatusRequest
  | ResetRequest
  | RetentionRequest
  | CloseRequest;

export type OpenResult = {
  replicaId: string;
  deviceDid: string;
  /** The verification method (DID fragment form) the app delegates to. */
  verificationMethod: string;
  /** Full replica state; null until this session presents the bound issuer's grant. */
  status: ReplicaStatus | null;
  /** Whether this session may read: an issuer-bound replica hides its state until then. */
  authorized: boolean;
  created: boolean;
};

export type SyncResult = { status: "synced" } & SyncReport | { status: "busy" };

export type GetResult =
  | { status: "present"; key: string; value: ArrayBuffer; etag: string; metadata: Record<string, string> }
  | { status: "content_missing"; key: string; etag: string; metadata: Record<string, string> }
  | { status: "deleted" | "absent" | "coverage_incomplete" | "not_covered"; key: string };

export type ListResult = { entries: Array<{ key: string; etag: string; metadata: Record<string, string>; content: boolean }> };

export type StatusResult = {
  /** Full replica state; null until this session presents the bound issuer's grant. */
  status: ReplicaStatus | null;
  persistence: { persisted: boolean | null; locksSupported: boolean };
  authorized: boolean;
};

export type ReplicaEvent =
  | { event: "committed"; serial: number }
  | { event: "authority"; state: string }
  | { event: "reset"; reason: string }
  | { event: "progress"; phase: string; pages: number; changes: number };

export type ReplicaReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; err: { code: string; message: string; detail?: Record<string, unknown> } };

export type ReplicaEventMessage = { event: ReplicaEvent };

export function isReplicaReply(message: unknown): message is ReplicaReply {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { id?: unknown; ok?: unknown };
  return typeof candidate.id === "number" && typeof candidate.ok === "boolean";
}
