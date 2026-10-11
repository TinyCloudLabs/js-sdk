import { blake3 } from "@noble/hashes/blake3.js";
import { randomBytes } from "node:crypto";
import { isRead, isWrite } from "../../contracts/events";
import { waitFor } from "../../contracts/clock";
import type { GetResult, KvClient, WriteResult } from "../../contracts/client";
import type { ScenarioContext } from "../../contracts/scenario";
import type { TopologySpec } from "../../contracts/topology";

export const NOTES = "notes/";
export const randomValue = (): Uint8Array => new Uint8Array(randomBytes(64 * 1024));
export const digest = (value: Uint8Array): string => Buffer.from(blake3(value)).toString("hex");
export const text = (value: Uint8Array | undefined): string => new TextDecoder().decode(value);

export function oneNode(name: string, clients: TopologySpec["clients"]): TopologySpec {
  return { name, nodes: [{ id: "a" }], clients };
}
export function ownerClient(id: string, kind: "cli" | "sdk", replication: TopologySpec["clients"][number]["replication"], identity: string): TopologySpec["clients"][number] {
  const timingDefaults = kind === "cli" ? { maxStalenessMs: 60_000, staleSyncTimeoutMs: 10_000 } : { maxStalenessMs: 120_000, staleSyncTimeoutMs: 5_000 };
  const replicationOptions = replication === undefined || replication === false ? replication : { ...timingDefaults, ...replication };
  return { id, kind, node: "a", identity, auth: { posture: "owner" }, replication: replicationOptions };
}


export function checkWrite(ctx: ScenarioContext, client: KvClient, result: WriteResult, label: string, requireCommitted = false): void {
  ctx.check(`${label} succeeded`, result.ok);
  if (requireCommitted) ctx.eq(`${label} committed`, result.outcome, "committed");
  const events = result.events.filter((entry) => entry.clientId === client.id && entry.opSeq === result.opSeq && entry.attribution === "op" && isWrite(entry.event));
  ctx.check(`${label} has attributed replication.write`, events.length > 0, result.events);
  if (requireCommitted) ctx.check(`${label} attributed write committed`, events.some((entry) => entry.event.outcome === "committed"), events);
}

export async function waitUntil<T>(ctx: ScenarioContext, client: KvClient, probe: () => Promise<T | undefined>, describe: string, intervalMs = 100): Promise<T> {
  return waitFor(ctx.clock, probe, { deadlineMs: ctx.deadline(client), intervalMs, describe, signal: ctx.signal });
}

export function replication(prefixes = [NOTES], options: { mode?: "foreground" | "background"; maxStalenessMs?: number; syncIntervalMs?: number } = {}) {
  return { prefixes, ...options };
}


export function checkReplicaHit(ctx: ScenarioContext, client: KvClient, result: GetResult, label: string): void {
  const reads = result.events.filter((entry) => entry.clientId === client.id && entry.opSeq === result.opSeq && entry.attribution === "op" && isRead(entry.event));
  const view = reads.at(-1)?.event ?? result.read;
  ctx.eq(`${label} source`, view?.source, "replica");
  ctx.eq(`${label} reason`, view?.reason, "hit");
}
export function flagOn(client: KvClient): { flag?: "on" } {
  return client.kind === "cli" ? { flag: "on" } : {};
}

export function replicationBound(client: KvClient, maxStalenessMs: number): { replication?: { maxStalenessMs: number } } {
  return client.kind === "cli" ? { replication: { maxStalenessMs } } : {};
}

export function listHasOmission(keys: string[] | undefined, key: string): boolean {
  return keys !== undefined && !keys.includes(key);
}

