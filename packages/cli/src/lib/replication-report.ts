import type { ReplicaStatusEntry, ReplicationEvent } from "@tinycloud/node-sdk";

export interface ReplicationPartitionSummary {
  idHash: string;
  host: string | null;
  space: string | null;
  pinned: number;
}

export interface ReplicationReport {
  since: string;
  totals: { reads: number; replicaReads: number; hitRatio: number; writes: number; divergences: number };
  readsBySourceReason: Record<string, number>;
  latencyMs: Record<string, { p50: number | null; p95: number | null }>;
  stalenessMs: { p50: number | null; p95: number | null; max: number | null };
  syncs: Record<string, number>;
  writes: Record<string, number>;
  divergences: ReplicationEvent[];
  replicas: ReplicaStatusEntry[];
  partitions: ReplicationPartitionSummary[];
  warning?: string;
}

export const CLEAR_PENDING_WARNING = "Clearing pending writes stops pinning keys whose last write had an unknown outcome or never finished. If such a write did commit, or commits later, this device can serve the older value for that key until the next sync after the commit, as it would for a write from another device.";
function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  values.sort((left, right) => left - right);
  return values[Math.ceil(fraction * values.length) - 1] ?? values[values.length - 1]!;
}

/** Aggregate already-filtered JSONL events with live replica and partition state. */
export function createReplicationReport(
  since: string,
  events: readonly ReplicationEvent[],
  replicas: ReplicaStatusEntry[],
  partitions: ReplicationPartitionSummary[],
  warning?: string,
): ReplicationReport {
  const reads = events.filter((event) => event.type === "replication.read");
  const replicaReads = reads.filter((event) => event.source === "replica");
  const sourceLatency = new Map<string, number[]>();
  const readsBySourceReason: Record<string, number> = {};
  for (const event of reads) {
    const key = `${event.source}:${event.reason}`;
    readsBySourceReason[key] = (readsBySourceReason[key] ?? 0) + 1;
    const values = sourceLatency.get(event.source) ?? [];
    values.push(event.latencyMs);
    sourceLatency.set(event.source, values);
  }
  const latencyMs = Object.fromEntries([...sourceLatency].map(([source, values]) => [source, {
    p50: percentile([...values], 0.5),
    p95: percentile([...values], 0.95),
  }]));
  const staleness = reads.flatMap((event) => event.stalenessMs === null ? [] : [event.stalenessMs]);
  const syncs: Record<string, number> = {};
  const writes: Record<string, number> = {};
  const divergences = events.filter((event) => event.type === "replication.divergence").slice(-20);
  for (const event of events) {
    if (event.type === "replication.sync") {
      const key = `${event.class ?? "none"}:${event.code ?? event.outcome}`;
      syncs[key] = (syncs[key] ?? 0) + 1;
    } else if (event.type === "replication.write") {
      writes[event.outcome] = (writes[event.outcome] ?? 0) + 1;
    }
  }
  return {
    since,
    totals: {
      reads: reads.length,
      replicaReads: replicaReads.length,
      hitRatio: reads.length === 0 ? 0 : replicaReads.length / reads.length,
      writes: events.filter((event) => event.type === "replication.write").length,
      divergences: events.filter((event) => event.type === "replication.divergence").length,
    },
    readsBySourceReason,
    latencyMs,
    stalenessMs: { p50: percentile([...staleness], 0.5), p95: percentile([...staleness], 0.95), max: staleness.length ? Math.max(...staleness) : null },
    syncs,
    writes,
    divergences,
    replicas,
    partitions,
    ...(warning === undefined ? {} : { warning }),
  };
}

export function renderReplicationReport(report: ReplicationReport): string {
  const lines = [
    `Replication report (since ${report.since})`,
    `Reads: ${report.totals.reads}; replica: ${report.totals.replicaReads}; hit ratio: ${(report.totals.hitRatio * 100).toFixed(1)}%`,
    `Latency ms: ${Object.entries(report.latencyMs).map(([source, value]) => `${source} p50=${value.p50 ?? "—"} p95=${value.p95 ?? "—"}`).join("; ") || "none"}`,
    `Staleness ms: p50=${report.stalenessMs.p50 ?? "—"} p95=${report.stalenessMs.p95 ?? "—"} max=${report.stalenessMs.max ?? "—"}`,
    `Syncs: ${Object.entries(report.syncs).map(([key, count]) => `${key}=${count}`).join(", ") || "none"}`,
    `Writes: ${Object.entries(report.writes).map(([key, count]) => `${key}=${count}`).join(", ") || "none"}`,
    `Divergences: ${report.totals.divergences}; showing ${report.divergences.length}`,
    `Replicas: ${report.replicas.length}`,
  ];
  for (const replica of report.replicas) {
    const grant = replica.grant ? ` grant=${replica.grant.cid} parent=${replica.grant.parentCid ?? "—"} expires=${replica.grant.expiresAt ?? "—"}` : " grant=missing";
    lines.push(`  ${replica.prefix}: ${replica.state}; pending in_flight=${replica.pending.inFlight} committed=${replica.pending.committed} ambiguous=${replica.pending.ambiguous}${grant}`);
    for (const pinned of replica.pinned) lines.push(`    pinned ${pinned.key} ${pinned.state} ${pinned.op} since=${pinned.since} code=${pinned.code ?? "—"} likelyOrphaned=${pinned.likelyOrphaned}`);
  }
  for (const partition of report.partitions) {
    lines.push(`Partition ${partition.idHash}: host=${partition.host ?? "unknown"} space=${partition.space ?? "unknown"} pinned=${partition.pinned}`);
  }
  if (report.partitions.some((partition) => partition.pinned > 100)) lines.push("Warning: a partition holds more than 100 pinned records.");
  if (report.warning) lines.push(`Warning: ${report.warning}`);
  return lines.join("\n");
}
