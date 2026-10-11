import { kvPrefixCovers } from "./scope";
import type { PendingWriteRecord, PendingWriteState } from "./types";

export function emptyPendingState(identity: PendingWriteState["identity"]): PendingWriteState {
  return { v: 2, identity: { ...identity }, committedEpoch: 0, seq: 0, records: [] };
}

export function begin(s: PendingWriteState, opId: string, keys: readonly { key: string; op: "put" | "delete" }[], at: string): PendingWriteRecord[] {
  const records = keys.map(({ key, op }) => ({ opId, seq: ++s.seq, key, op, state: "in_flight" as const, epoch: null, at, settledAt: null }));
  s.records.push(...records);
  return records;
}

export function settle(s: PendingWriteState, opId: string, outcome: "committed" | "failed" | "ambiguous", at: string, code?: string): void {
  if (outcome === "failed") { s.records = s.records.filter((r) => r.opId !== opId); return; }
  const own = s.records.filter((r) => r.opId === opId && r.state === "in_flight");
  if (outcome === "committed" && own.length > 0) {
    const epoch = ++s.committedEpoch;
    for (const r of own) { r.state = "committed"; r.epoch = epoch; r.settledAt = at; }
    return;
  }
  for (const r of own) { r.state = "ambiguous"; r.settledAt = at; if (code) r.code = code; }
}

export function afterSync(s: PendingWriteState, prefix: string, syncStartEpoch: number): number {
  const before = s.records.length;
  s.records = s.records.filter((r) => !(r.state === "committed" && r.epoch !== null && r.epoch <= syncStartEpoch && kvPrefixCovers(prefix, r.key)));
  return before - s.records.length;
}

export function clearPrefix(s: PendingWriteState, prefix: string): number {
  const before = s.records.length;
  s.records = s.records.filter((r) => !kvPrefixCovers(prefix, r.key));
  return before - s.records.length;
}

export function clearPending(s: PendingWriteState, now: number): number {
  const before = s.records.length;
  s.records = s.records.filter((r) => r.state === "committed" || (r.state === "in_flight" && now - Date.parse(r.at) <= 10 * 60_000));
  return before - s.records.length;
}

export function pinnedKeys(s: PendingWriteState, prefix: string, now: number, cap = 100) {
  return s.records.filter((r) => kvPrefixCovers(prefix, r.key) && (r.state === "in_flight" || r.state === "ambiguous"))
    .sort((a, b) => a.seq - b.seq).slice(0, cap).map((r) => ({ key: r.key, state: r.state as "in_flight" | "ambiguous", op: r.op, since: r.at, ...(r.code ? { code: r.code } : {}), likelyOrphaned: r.state === "in_flight" && now - Date.parse(r.at) > 10 * 60_000 }));
}
