import type { ReplicationEvent, ReplicationScheduler } from "./types";

export type ReplicationEventInput = ReplicationEvent extends infer Event
  ? Event extends { at: string }
    ? Omit<Event, "at">
    : never
  : never;

export function emitEvent(emit: (event: ReplicationEvent) => void, scheduler: ReplicationScheduler, event: ReplicationEventInput): void {
  try { emit({ ...event, at: new Date(scheduler.now()).toISOString() } as ReplicationEvent); } catch { /* Observability never changes KV behavior. */ }
}
