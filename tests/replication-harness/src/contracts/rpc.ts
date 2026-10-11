import type { ReplicationSpec, GrantCap } from "./topology";
import type { ReplicationEventLike } from "./events";
export type B64 = { $b64: string };
export interface SdkReplicationConfig extends ReplicationSpec { storageDir: string }
export interface RpcOps {
  hello: { args: Record<string, never>; value: { driver: "tc893-sdk-driver"; protocol: 1; node: string; sdkVersion: string; sdkResolved: string; exports: string[] } };
  init: { args: { host: string; domain: string; privateKeyHex?: string; kvTimeoutMs?: number; sessionExpiryMs?: number; replication: SdkReplicationConfig | false }; value: { address: string | null } };
  signIn: { args: Record<string, never>; value: { spaceId: string; sessionExpiresAt: string | null } };
  "session.export": { args: Record<string, never>; value: { session: unknown } };
  "session.restore": { args: { session: unknown; hosts: string[] }; value: { spaceId: string; sessionExpiresAt: string | null } };
  "session.deviceKey": { args: Record<string, never>; value: { did: string } };
  "session.useDelegation": { args: { delegation: unknown; hosts: string[] }; value: { spaceId: string; sessionExpiresAt: string | null } };
  "grant.issue": { args: { audience: string; caps: GrantCap[]; expiresInMs: number }; value: { delegation: unknown; cid: string; expiresAt: string } };
  "kv.get": { args: { key: string; source?: "network"; maxResponseBytes?: number; timeoutMs?: number; space?: string }; value: { found: boolean; value?: B64 } };
  "kv.put": { args: { key: string; value: B64; contentType?: string; timeoutMs?: number }; value: Record<string, never> };
  "kv.delete": { args: { key: string; timeoutMs?: number }; value: Record<string, never> };
  "kv.list": { args: { prefix: string; source?: "network"; limit?: number; cursor?: string; timeoutMs?: number }; value: { keys: string[]; nextCursor?: string } };
  "kv.batchPut": { args: { items: { key: string; value: B64; contentType?: string }[]; timeoutMs?: number }; value: { written: string[] } };
  "replication.status": { args: Record<string, never>; value: unknown[] };
  "replication.sync": { args: { prefix?: string; timeoutMs?: number }; value: unknown };
  "replication.purge": { args: { timeoutMs?: number }; value: { purged: string[]; failed: { prefix: string; code: string }[] } };
  "replication.clearPending": { args: { keys?: string[] }; value: { cleared: number } };
  cancel: { args: { id: number }; value: { cancelled: boolean } };
  close: { args: { timeoutMs: number }; value: { closed: boolean } };
}
export type RpcOp = keyof RpcOps;
export interface RpcRequest<O extends RpcOp = RpcOp> { v: 1; id: number; op: O; args: RpcOps[O]["args"] }
export interface RpcError { code: string; message: string; name?: string; meta?: unknown }
export type RpcResponse<O extends RpcOp = RpcOp> =
  | { v: 1; type: "response"; id: number; ok: true; value: RpcOps[O]["value"]; durationMs: number }
  | { v: 1; type: "response"; id: number; ok: false; error: RpcError; durationMs: number };
export interface RpcEvent { v: 1; type: "event"; inFlight: number[]; event: ReplicationEventLike }
export interface RpcLog { v: 1; type: "log"; level: "info" | "warn" | "error"; message: string }
export type DriverLine = RpcResponse | RpcEvent | RpcLog;
