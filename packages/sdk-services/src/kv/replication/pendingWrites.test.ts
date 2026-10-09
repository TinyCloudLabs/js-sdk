import { describe, expect, test } from "bun:test";
import { err, ErrorCodes, ok, serviceError } from "../../types";
import { canonicalReplicationIdentity } from "./identity";
import { createMemoryPendingStore } from "./memoryPendingStore";
import { afterSync, begin, clearPending, pinnedKeys, settle } from "./pendingWrites";
import { classifyWriteOutcome } from "./outcome";

const identity = canonicalReplicationIdentity({ host: "https://node.example/", space: "tinycloud:pkh:eip155:1:0xABC:default", principal: "did:pkh:eip155:1:0xABC" });
const at = "2026-01-01T00:00:00.000Z";
const failure = (code: string, meta?: Record<string, unknown>) => err(serviceError(code, code, "kv", { meta }));

describe("pending write transitions", () => {
  test("begins per-key records and commits one epoch per operation", () => {
    const state = { v: 2 as const, identity, committedEpoch: 0, seq: 0, records: [] as ReturnType<typeof begin> };
    begin(state, "batch", [{ key: "notes/a", op: "put" }, { key: "notes/b", op: "put" }], at);
    settle(state, "batch", "committed", at);
    expect(state.committedEpoch).toBe(1);
    expect(state.records.map(({ state: value, epoch, seq }) => [value, epoch, seq])).toEqual([["committed", 1, 1], ["committed", 1, 2]]);
  });

  test("sync clears only committed records inside its prefix and epoch boundary", () => {
    const state = { v: 2 as const, identity, committedEpoch: 0, seq: 0, records: [] as ReturnType<typeof begin> };
    begin(state, "a", [{ key: "notes/a", op: "put" }], at);
    settle(state, "a", "committed", at);
    begin(state, "b", [{ key: "notes-x/b", op: "put" }], at);
    settle(state, "b", "committed", at);
    begin(state, "c", [{ key: "notes/c", op: "put" }], at);
    settle(state, "c", "ambiguous", at, "TIMEOUT");
    expect(afterSync(state, "notes", 2)).toBe(1);
    expect(state.records.map((r) => [r.key, r.state])).toEqual([["notes-x/b", "committed"], ["notes/c", "ambiguous"]]);
  });

  test("clearPending removes ambiguous and only heuristic-aged in-flight records", () => {
    const state = { v: 2 as const, identity, committedEpoch: 0, seq: 0, records: [] as ReturnType<typeof begin> };
    begin(state, "old", [{ key: "notes/old", op: "put" }], "2026-01-01T00:00:00.000Z");
    begin(state, "young", [{ key: "notes/young", op: "delete" }], "2026-01-01T00:09:59.999Z");
    begin(state, "ambiguous", [{ key: "notes/ambiguous", op: "put" }], at);
    settle(state, "ambiguous", "ambiguous", at, "TIMEOUT");
    begin(state, "committed", [{ key: "notes/committed", op: "put" }], at);
    settle(state, "committed", "committed", at);
    expect(clearPending(state, Date.parse("2026-01-01T00:10:00.001Z"))).toBe(2);
    expect(state.records.map((r) => r.key)).toEqual(["notes/young", "notes/committed"]);
    expect(pinnedKeys(state, "notes", Date.parse("2026-01-01T00:20:00.000Z"))).toEqual([{ key: "notes/young", state: "in_flight", op: "delete", since: "2026-01-01T00:09:59.999Z", likelyOrphaned: true }]);
  });
});

describe("write outcome classifier", () => {
  const rows: Array<[string, "put" | "delete" | "batchPut", ReturnType<typeof ok> | ReturnType<typeof failure>, "committed" | "failed" | "ambiguous"]> = [
    ["successful response", "put", ok(undefined), "committed"],
    ["delete not-found answer", "delete", failure(ErrorCodes.KV_NOT_FOUND), "committed"],
    ["not dispatched", "batchPut", failure(ErrorCodes.NETWORK_ERROR, { requestMayHaveDispatched: false }), "failed"],
    ["definitive error code", "put", failure(ErrorCodes.KV_PRECONDITION_FAILED), "failed"],
    ["unconfirmed batch", "batchPut", failure(ErrorCodes.NETWORK_ERROR, { outcome: "batch-unconfirmed", status: 200 }), "ambiguous"],
    ["other 4xx", "put", failure(ErrorCodes.NETWORK_ERROR, { status: 422 }), "failed"],
    ["5xx", "put", failure(ErrorCodes.KV_CONFLICT, { status: 503 }), "ambiguous"],
    ["timeout without status", "put", failure(ErrorCodes.TIMEOUT), "ambiguous"],
  ];
  for (const [name, op, result, expected] of rows) test(name, () => expect(classifyWriteOutcome(op, result)).toBe(expected));
});

test("memory pending stores canonicalize identity and serialize updates per store", async () => {
  const first = createMemoryPendingStore(identity);
  const second = createMemoryPendingStore({ host: "HTTPS://NODE.EXAMPLE:443", space: identity.space, principal: identity.principal });
  expect(second).not.toBe(first);
  expect(second.identity).toEqual(first.identity);
  await Promise.all(Array.from({ length: 20 }, (_, i) => first.update((state) => { state.seq += 1; state.records.push({ opId: String(i), seq: state.seq, key: `notes/${i}`, op: "put", state: "in_flight", epoch: null, at, settledAt: null }); })));
  expect((await first.read()).records.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  expect(first.durable).toBe(false);
});
