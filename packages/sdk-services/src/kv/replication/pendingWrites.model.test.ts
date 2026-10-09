import { describe, expect, test } from "bun:test";
import { canonicalReplicationIdentity } from "./identity";
import { afterSync, begin, settle } from "./pendingWrites";
import type { PendingWriteState } from "./types";

type Content = "v0" | "v1" | "v2" | "absent";
type Op = { kind: "put"; value: Content } | { kind: "delete" };
type Mode = "ok" | "err5xx" | "reject4xx" | "timeoutCommit" | "timeoutLost" | "okSettleLost";
type Rules = { evidence: boolean; supersede: boolean; fence: boolean };
type Write = { phase: 0 | 1 | 2; linearized: number };
type Sync = { phase: 0 | 1 | 2 | 3 | 4; replica: number; epoch: number; snapshot: number };
type Read = { phase: 0 | 1 | 2; pinned: boolean; min: number; replica: number };
type State = { history: Content[]; replicas: Array<{ index: number; epoch: number; prefix: string; device: string }>; store: PendingWriteState; writes: Write[]; syncs: Sync[]; reads: Read[] };
type Scenario = { initial: Content; ops: Op[]; modes: Mode[]; sequential: boolean; replicaCount: 1 | 2 };
type Step = { state: State; violation?: string };
const identity = canonicalReplicationIdentity({ host: "https://model.example", space: "tinycloud:pkh:eip155:1:0xabc:default", principal: "did:pkh:eip155:1:0xabc" });
const KEY = "notes/a";
const TARGET = (op: Op): Content => op.kind === "put" ? op.value : "absent";
const PROCESS: Record<Mode, boolean> = { ok: true, err5xx: true, reject4xx: false, timeoutCommit: true, timeoutLost: false, okSettleLost: true };
const FULL = process.env.TC858_MODEL_FULL === "1";
const INITS: Content[] = FULL ? ["v0", "absent"] : ["v0", "absent"];
const W1: Op[] = FULL ? [{ kind: "put", value: "v0" }, { kind: "put", value: "v1" }, { kind: "delete" }] : [{ kind: "put", value: "v0" }, { kind: "delete" }];
const W2: Op[] = FULL ? [{ kind: "put", value: "v0" }, { kind: "put", value: "v1" }, { kind: "put", value: "v2" }, { kind: "delete" }] : [{ kind: "put", value: "v1" }];
const MODES: Mode[] = FULL ? ["ok", "err5xx", "reject4xx", "timeoutCommit", "timeoutLost", "okSettleLost"] : ["ok", "reject4xx", "timeoutCommit"];

function clone(s: State): State {
  return { history: [...s.history], replicas: s.replicas.map((r) => ({ ...r })), store: { ...s.store, identity, records: s.store.records.map((r) => ({ ...r })) }, writes: s.writes.map((w) => ({ ...w })), syncs: s.syncs.map((y) => ({ ...y })), reads: s.reads.map((r) => ({ ...r })) };
}
function stateKey(s: State): string {
  return `${s.history.join(",")}|${s.replicas.map((r) => `${r.prefix}.${r.device}.${r.index}.${r.epoch}`).join(",")}|${s.store.committedEpoch}.${s.store.seq}|${s.store.records.map((r) => `${r.opId}.${r.seq}.${r.state}.${r.epoch ?? "-"}`).join(",")}|${s.writes.map((w) => `${w.phase}.${w.linearized}`).join(",")}|${s.syncs.map((y) => `${y.phase}.${y.replica}.${y.epoch}.${y.snapshot}`).join(",")}|${s.reads.map((r) => `${r.phase}.${Number(r.pinned)}.${r.min}.${r.replica}`).join(",")}`;
}
function createState(sc: Scenario): State {
  return { history: [sc.initial], replicas: Array.from({ length: sc.replicaCount }, (_, i) => ({ index: 0, epoch: 0, prefix: i === 0 ? "notes" : "notes/", device: `replica-device-${i}` })), store: { v: 2, identity, committedEpoch: 0, seq: 0, records: [] }, writes: sc.ops.map(() => ({ phase: 0, linearized: -1 })), syncs: Array.from({ length: 2 }, (_, i) => ({ phase: 0, replica: sc.replicaCount === 1 ? 0 : (i + 1) % 2, epoch: -1, snapshot: -1 })), reads: Array.from({ length: 2 }, (_, i) => ({ phase: 0, pinned: false, min: -1, replica: sc.replicaCount === 1 ? 0 : i % 2 })) };
}
function transitions(s: State, sc: Scenario, rules: Rules): Step[] {
  const result: Step[] = [];
  const latest = () => s.history.length - 1;
  for (let i = 0; i < sc.ops.length; i++) {
    const write = s.writes[i]!;
    const mode = sc.modes[i]!;
    const prev = i > 0 ? s.writes[i - 1]! : undefined;
    if (write.phase === 0 && (prev === undefined || (sc.sequential ? prev.phase === 2 : prev.phase >= 1))) {
      const n = clone(s); begin(n.store, `W${i}`, [{ key: KEY, op: sc.ops[i]!.kind === "delete" ? "delete" : "put" }], "2026-01-01T00:00:00.000Z"); n.writes[i]!.phase = 1; result.push({ state: n });
    }
    if (write.phase >= 1 && write.linearized < 0 && PROCESS[mode] && (mode === "timeoutCommit" || write.phase === 1)) {
      const n = clone(s); const op = sc.ops[i]!;
      if (op.kind === "delete" && n.history.at(-1) === "absent") n.writes[i]!.linearized = n.history.length - 1;
      else { n.history.push(TARGET(op)); n.writes[i]!.linearized = n.history.length - 1; }
      result.push({ state: n });
    }
    const maySettle = write.phase === 1 && (write.linearized >= 0 || mode === "reject4xx" || mode === "timeoutLost" || mode === "timeoutCommit");
    if (maySettle) {
      const n = clone(s); const outcome = mode === "ok" ? "committed" : mode === "reject4xx" ? "failed" : mode === "okSettleLost" ? undefined : "ambiguous";
      if (outcome) settle(n.store, `W${i}`, outcome, "2026-01-01T00:00:00.000Z", mode === "err5xx" ? "NETWORK_ERROR" : "TIMEOUT");
      if (rules.supersede && outcome === "committed") {
        const mine = n.store.records.find((r) => r.opId === `W${i}`);
        if (mine) n.store.records = n.store.records.filter((r) => !(r.state === "ambiguous" && r.key === mine.key && r.seq < mine.seq));
      }
      n.writes[i]!.phase = 2; result.push({ state: n });
    }
  }
  for (let i = 0; i < s.syncs.length; i++) {
    const sync = s.syncs[i]!;
    if (sync.phase === 0 && (i === 0 || s.syncs[i - 1]!.phase === 4)) {
      const n = clone(s); n.syncs[i] = { ...sync, phase: 1, epoch: s.store.committedEpoch }; result.push({ state: n });
    } else if (sync.phase === 1) {
      const n = clone(s); n.syncs[i]!.phase = 2; n.syncs[i]!.snapshot = latest(); result.push({ state: n });
    } else if (sync.phase === 2) {
      const n = clone(s); const current = n.syncs[i]!; n.replicas[current.replica]!.index = current.snapshot; result.push({ state: n });
      n.replicas[current.replica]!.epoch = current.epoch; n.syncs[i]!.phase = 3;
    } else if (sync.phase === 3) {
      const n = clone(s); afterSync(n.store, s.replicas[sync.replica]!.prefix, sync.epoch);
      if (rules.evidence) {
        const row = n.history[n.replicas[sync.replica]!.index];
        n.store.records = n.store.records.filter((record) => !(record.state === "in_flight" || record.state === "ambiguous") || TARGET(sc.ops[Number(record.opId.slice(1))]!) !== row);
      }
      n.syncs[i]!.phase = 4; result.push({ state: n });
    }
  }
  for (let i = 0; i < s.reads.length; i++) {
    const read = s.reads[i]!;
    if (read.phase === 0 && (i === 0 || s.reads[i - 1]!.phase >= 1)) {
      const n = clone(s); const min = Math.max(-1, ...s.writes.map((w) => w.linearized));
      const pinned = s.store.records.some((r) => r.key === KEY) || (rules.fence && s.replicas[read.replica]!.epoch < s.store.committedEpoch);
      n.reads[i] = { ...read, phase: 1, pinned, min }; result.push({ state: n });
    } else if (read.phase === 1) {
      const n = clone(s); const r = n.reads[i]!; const served = r.pinned ? n.history[latest()]! : n.history[n.replicas[r.replica]!.index]!;
      n.reads[i]!.phase = 2;
      const violation = r.min >= 0 && !n.history.slice(r.min).includes(served) ? `read served ${served}; allowed values ${[...new Set(n.history.slice(r.min))].join("|")}` : undefined;
      result.push({ state: n, violation });
    }
  }
  return result;
}
function explore(sc: Scenario, rules: Rules): { states: number; violations: number } {
  const seen = new Set<string>(); let violations = 0;
  const visit = (s: State) => {
    const key = stateKey(s); if (seen.has(key)) return; seen.add(key);
    for (const next of transitions(s, sc, rules)) { if (next.violation) violations++; visit(next.state); }
  };
  visit(createState(sc)); return { states: seen.size, violations };
}
function scenarios(replicaCount: 1 | 2): Scenario[] {
  const result: Scenario[] = [];
  for (const sequential of [true, false]) for (const initial of INITS) for (const first of W1) for (const second of W2) for (const a of MODES) for (const b of MODES) {
    result.push({ initial, ops: [first, second], modes: [a, b], sequential, replicaCount });
  }
  return result;
}

describe("pending-write exhaustive state model", () => {
  test("Appendix A matrix has no stale local serve; mutation rules are caught", () => {
    const matrix = scenarios(1);
    let violations = 0; let states = 0;
    for (const scenario of matrix) { const result = explore(scenario, { evidence: false, supersede: false, fence: true }); violations += result.violations; states += result.states; }
    expect(violations).toBe(0);
    expect(states).toBeGreaterThan(100_000);
    const counterexample = { initial: "v0" as Content, ops: [{ kind: "put", value: "v0" } as Op, { kind: "put", value: "v1" } as Op], modes: ["timeoutCommit" as Mode, "ok" as Mode], sequential: false, replicaCount: 1 as const };
    expect(explore(counterexample, { evidence: true, supersede: false, fence: true }).violations).toBeGreaterThan(0);
    expect(explore(counterexample, { evidence: false, supersede: true, fence: true }).violations).toBeGreaterThan(0);
  }, 30_000);

  test("same-identity replica/device/prefix family is fenced", () => {
    const family = scenarios(2).filter((scenario) => scenario.modes.every((mode) => mode === "ok" || mode === "timeoutCommit"));
    for (const scenario of family) {
      const result = explore(scenario, { evidence: false, supersede: false, fence: true });
      expect(result.violations).toBe(0);
    }
    const counterexample = { initial: "v0" as Content, ops: [{ kind: "put", value: "v1" } as Op, { kind: "delete" } as Op], modes: ["ok" as Mode, "ok" as Mode], sequential: true, replicaCount: 2 as const };
    expect(explore(counterexample, { evidence: false, supersede: false, fence: false }).violations).toBeGreaterThan(0);
  }, 30_000);
});
