export interface ReplicationEventLike { type: string; at?: string; [field: string]: unknown }
export interface ReadEventLike extends ReplicationEventLike { type: "replication.read"; op?: "get" | "list"; key?: string; replica?: string | null; source?: "replica" | "network" | "none"; reason?: string; outcome?: string; code?: string; syncError?: string; stalenessMs?: number | null; syncedBeforeRead?: boolean; pendingState?: string; verify?: string }
export interface WriteEventLike extends ReplicationEventLike { type: "replication.write"; op?: string; keys?: string[]; outcome?: "committed" | "failed" | "ambiguous"; code?: string }
export interface SyncEventLike extends ReplicationEventLike { type: "replication.sync"; replica?: string; trigger?: string; outcome?: "ok" | "busy" | "error" | "aborted"; class?: string; code?: string; pendingCleared?: number; pages?: number; changes?: number; fetched?: number; durationMs?: number }
export interface StateEventLike extends ReplicationEventLike { type: "replication.state"; replica?: string; state?: string; code?: string; strategy?: string }
export interface DivergenceEventLike extends ReplicationEventLike { type: "replication.divergence"; key?: string; kind?: string; localOnly?: string[]; networkOnly?: string[] }
export interface EventEnvelope { clientId: string; seq: number; opSeq: number | null; attribution: "op" | "background" | "ambiguous"; recvMono: number; event: ReplicationEventLike }
export interface EventQuery { since?: number; opSeq?: number; type?: string | string[] }
export const isRead = (e: ReplicationEventLike): e is ReadEventLike => e.type === "replication.read";
export const isWrite = (e: ReplicationEventLike): e is WriteEventLike => e.type === "replication.write";
export const isSync = (e: ReplicationEventLike): e is SyncEventLike => e.type === "replication.sync";
export const isState = (e: ReplicationEventLike): e is StateEventLike => e.type === "replication.state";
export const isDivergence = (e: ReplicationEventLike): e is DivergenceEventLike => e.type === "replication.divergence";
