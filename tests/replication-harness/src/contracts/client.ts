import type { CallOptions, ClientKind } from "./common";
import type { ReplicationSpec } from "./topology";
import type { EventEnvelope, EventQuery, ReadEventLike, SyncEventLike } from "./events";
import type { FaultMode } from "./faults";
import type { RpcOp, RpcOps } from "./rpc";
export type ClientCapability = "perCallReplication" | "callerDeadline" | "maxResponseBytes" | "listPaging" | "batchPut" | "backgroundSync" | "grantIssue";
export interface OpOptions extends CallOptions {
  signal?: AbortSignal; deadlineMs?: number; fault?: FaultMode;
  replication?: Pick<ReplicationSpec, "maxStalenessMs" | "staleSyncTimeoutMs" | "verify">; flag?: "on" | "off"; debug?: boolean;
}
export interface GetOptions extends OpOptions { source?: "network"; maxResponseBytes?: number; space?: string }
export interface ListOptions extends OpOptions { source?: "network"; limit?: number; cursor?: string }
export interface PutOptions extends OpOptions { contentType?: string }
export interface SyncOptions extends OpOptions { prefix?: string }
export interface BatchPutItem { key: string; value: string | Uint8Array; contentType?: string }
export interface OpMeta { opSeq: number; startedMono: number; durationMs: number; events: EventEnvelope[] }
export interface ProcessMeta { exit?: number | null; signal?: string | null; stderr?: string }
export interface ReadView { source?: "replica" | "network" | "none"; reason?: string; code?: string; syncError?: string; stalenessMs?: number | null; syncedBeforeRead?: boolean; pendingState?: string; verify?: string }
export interface GetResult extends OpMeta, ProcessMeta { ok: boolean; found: boolean; value?: Uint8Array; code?: string; read?: ReadView; readEvent?: ReadEventLike }
export interface ListResult extends OpMeta, ProcessMeta { ok: boolean; keys?: string[]; nextCursor?: string; code?: string; read?: ReadView }
export interface WriteResult extends OpMeta, ProcessMeta { ok: boolean; code?: string; outcome?: "committed" | "failed" | "ambiguous" }
export interface BatchPutResult extends OpMeta { ok: boolean; written?: string[]; code?: string }
export interface SyncResult extends OpMeta, ProcessMeta { ok: boolean; code?: string; syncs: SyncEventLike[] }
export interface PurgeResult extends OpMeta, ProcessMeta { ok: boolean; purged: string[]; failed: { prefix: string; code: string }[] }
export interface ClearPendingResult extends OpMeta, ProcessMeta { ok: boolean; cleared: number }
export interface StatusEntry { prefix: string; state: string; reason?: string; pending?: { inFlight: number; committed: number; ambiguous: number }; pinned?: unknown[]; grant?: Record<string, unknown> | null; [field: string]: unknown }
export interface AuthorityInfo { posture: "owner" | "delegate-session"; sessionExpiresAt: number | null; grantExpiresAt: number | null }
export interface KvClient {
  readonly id: string; readonly kind: ClientKind; readonly capabilities: ReadonlySet<ClientCapability>;
  get(key: string, o?: GetOptions): Promise<GetResult>; put(key: string, value: string | Uint8Array, o?: PutOptions): Promise<WriteResult>;
  del(key: string, o?: OpOptions): Promise<WriteResult>; list(prefix: string, o?: ListOptions): Promise<ListResult>; batchPut(items: BatchPutItem[], o?: OpOptions): Promise<BatchPutResult>;
  sync(o?: SyncOptions): Promise<SyncResult>; status(o?: CallOptions): Promise<StatusEntry[]>; purge(o?: CallOptions): Promise<PurgeResult>;
  clearPending(o?: { keys?: string[] } & CallOptions): Promise<ClearPendingResult>; authority(): Promise<AuthorityInfo>;
  events(q?: EventQuery): Promise<EventEnvelope[]>; eventCursor(): number; replicaDir(): string; scanReplica(needle: Uint8Array): Promise<string[]>;
  withHost(alias: string): KvClient; restart(o?: { replication?: ReplicationSpec | false } & CallOptions): Promise<void>;
  kill(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void>; close(o: { deadlineMs: number }): Promise<{ graceful: boolean }>;
}
export interface CliCallOptions extends OpOptions { stdin?: Uint8Array; profile?: string; omitHost?: boolean }
export interface CliResult extends OpMeta { exit: number | null; signal: string | null; stdout: Uint8Array; stderr: string; json?: unknown }
export interface CliClient extends KvClient { tc(args: string[], o?: CliCallOptions): Promise<CliResult>; home(): string; profile(): string; eventsFile(): string }
export interface SdkClient extends KvClient { rpc<O extends RpcOp>(op: O, args: RpcOps[O]["args"], o?: CallOptions): Promise<RpcOps[O]["value"]> }
