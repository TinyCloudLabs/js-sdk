import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReplicationEvent } from "@tinycloud/node-sdk";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_MODE = 0o600;
const DIR_MODE = 0o700;

/** Append a single private JSONL event, rotating the previous file at 5 MiB. */
export function appendReplicationEvent(root: string, event: ReplicationEvent): void {
  mkdirSync(root, { recursive: true, mode: DIR_MODE });
  chmodSync(root, DIR_MODE);
  const path = join(root, "events.jsonl");
  let size = 0;
  try {
    size = statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const line = `${JSON.stringify(event)}\n`;
  if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
    const rotated = join(root, "events.jsonl.1");
    try { renameSync(path, rotated); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writeFileSync(path, line, { mode: LOG_MODE });
  } else {
    appendFileSync(path, line, { mode: LOG_MODE });
  }
  chmodSync(path, LOG_MODE);
}

export function replicationLogPath(profileRoot: string): string {
  return join(profileRoot, "replication", "events.jsonl");
}


export function createReplicationEventSink(
  profileRoot: string,
  options: { debug: boolean; quiet: boolean },
): (event: ReplicationEvent) => void {
  const pinnedNotices = new Set<string>();
  const missingGrantWarnings = new Set<string>();

  return (event) => {
    appendProfileReplicationEvent(profileRoot, event);
    if (event.type === "replication.state" && event.state === "grant_missing") {
      const prefix = event.replica ?? event.space ?? "configured prefix";
      const key = `${event.space ?? ""}\u0000${event.replica ?? ""}`;
      if (!missingGrantWarnings.has(key)) {
        missingGrantWarnings.add(key);
        process.stderr.write(`[replication] Warning: no usable kv/get+sync grant for ${prefix}; reads use the network (${event.code ?? "grant_missing"}).\n`);
      }
    }
    if (options.debug) {
      if (event.type === "replication.read") {
        const detail = event.source === "replica" ? "replica hit" : `${event.source} ${event.reason}`;
        const syncStatus = event.syncedBeforeRead === undefined ? "" : ` syncedBeforeRead:${event.syncedBeforeRead}`;
        const syncError = event.syncError === undefined ? "" : ` syncError:${event.syncError}`;
        process.stderr.write(`[replication] ${event.op} ${event.key} ← ${detail} ${event.latencyMs}ms${syncStatus}${syncError}${event.stalenessMs === null ? "" : ` (synced ${Math.round(event.stalenessMs / 1000)}s ago)`}\n`);
      } else if (event.type === "replication.write") {
        process.stderr.write(`[replication] ${event.op} ${event.keys.join(",")} ${event.outcome}${event.code ? ` ${event.code}` : ""}\n`);
      } else if (event.type === "replication.sync") {
        const pending = event.pendingCleared === undefined ? "" : ` pendingCleared:${event.pendingCleared}`;
        process.stderr.write(`[replication] sync ${event.replica} ${event.outcome}${event.code ? ` ${event.code}` : ""}${pending}\n`);
      }
    }
    if (event.type === "replication.read" && (event.pendingState === "in_flight" || event.pendingState === "ambiguous") && !options.quiet && !pinnedNotices.has(event.key)) {
      pinnedNotices.add(event.key);
      process.stderr.write(`[replication] ${event.key} reads from the network: an earlier write's outcome is unknown (${event.pendingState}${event.code ? `, ${event.code}` : ""}). Review: tc replica report\n`);
    }
  };
}
export function appendProfileReplicationEvent(profileRoot: string, event: ReplicationEvent): void {
  appendReplicationEvent(dirname(replicationLogPath(profileRoot)), event);
}
