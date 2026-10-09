import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReplicaStatusEntry, ReplicationEvent } from "@tinycloud/node-sdk";
import { appendReplicationEvent } from "./replication-log.js";
import { CLEAR_PENDING_WARNING, createReplicationReport, renderReplicationReport } from "./replication-report.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const readHit = (at: string, source: "replica" | "network", latencyMs: number, stalenessMs: number | null): Extract<ReplicationEvent, { type: "replication.read" }> => ({
  type: "replication.read", at, op: "get", space: "default", key: "notes/a", replica: "notes", source,
  reason: source === "replica" ? "hit" : "pending_write", outcome: "found", latencyMs, stalenessMs, coverage: "complete", authority: "valid",
});

describe("replication diagnostics", () => {
  test("writes private JSONL and rotates at the 5 MiB boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-replication-log-"));
    roots.push(root);
    const event = readHit(new Date().toISOString(), "replica", 2, 10);
    appendReplicationEvent(root, { ...event, key: "x".repeat(3 * 1024 * 1024) });
    appendReplicationEvent(root, { ...event, key: "y".repeat(3 * 1024 * 1024) });
    expect(statSync(join(root, "events.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(root, "events.jsonl.1"), "utf8")).toContain('"key":"' + "x".repeat(16));
    expect(readFileSync(join(root, "events.jsonl"), "utf8")).toContain('"key":"' + "y".repeat(16));
  });

  test("renders aggregates, recent divergences and pinned status with the clear warning", () => {
    const now = new Date().toISOString();
    const events: ReplicationEvent[] = [
      readHit(now, "replica", 2, 10),
      readHit(now, "network", 8, null),
      { type: "replication.write", at: now, op: "put", space: "default", keys: ["notes/a"], outcome: "ambiguous", code: "TIMEOUT", latencyMs: 3 },
      { type: "replication.divergence", at: now, op: "get", space: "default", key: "notes/a", replica: "notes", kind: "value", stalenessMs: 10 },
    ];
    const status: ReplicaStatusEntry[] = [{
      prefix: "notes", state: "ready", pending: { inFlight: 1, committed: 0, ambiguous: 1 }, lagMs: 0,
      pinned: [{ key: "notes/a", state: "ambiguous", op: "put", since: now, code: "TIMEOUT", likelyOrphaned: false }],
      grant: { cid: "cid", parentCid: "parent", expiresAt: 123, state: "active", unconstrained: true },
    }];
    const report = createReplicationReport("24h", events, status, [{ idHash: "a".repeat(26), host: "https://node", space: "default", pinned: 1 }], CLEAR_PENDING_WARNING);
    expect(report.totals).toEqual({ reads: 2, replicaReads: 1, hitRatio: 0.5, writes: 1, divergences: 1 });
    const rendered = renderReplicationReport(report);
    expect(rendered).toContain("ambiguous put since=");
    expect(rendered).toContain("parent=parent");
    expect(rendered).toContain("key until the next sync after the commit");
  });
  test("renders read reasons and capped divergence keys with the actual total", () => {
    const now = new Date().toISOString();
    const divergences: ReplicationEvent[] = Array.from({ length: 22 }, (_, index) => ({
      type: "replication.divergence",
      at: now,
      op: "get",
      space: "default",
      key: `notes/key-${index}`,
      replica: "notes",
      kind: "value",
      stalenessMs: index,
    }));
    const report = createReplicationReport("24h", [readHit(now, "network", 1, null), ...divergences], [], []);
    const rendered = renderReplicationReport(report);
    expect(rendered).toContain("Read source/reason: network:pending_write=1");
    expect(rendered).toContain("Divergences: 22; showing 20 of 22");
    expect(rendered).toContain("default notes/key-2: value stalenessMs=2");
    expect(rendered).not.toContain("default notes/key-1: value");
  });
});
