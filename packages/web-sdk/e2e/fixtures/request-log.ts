// A request log for the harness: the same reader shape the panel client gets from the SDK
// (snapshot, subscribe, onClear), filled with sample rows and driven by the specs.
import type { RequestLogReader } from "../../src/ui/slots";

export type LogRow = Record<string, unknown>;

/** Local clock time today, so the Time column reads like the mockup's. */
function at(clock: string): number {
  const [h = 0, m = 0, s = 0] = clock.split(":").map(Number);
  return new Date().setHours(h, m, s, 0);
}

// [time, op, path, space, host, bytes, ms, code, source]: the mockup's fourteen sample requests, oldest first.
const SAMPLE: ReadonlyArray<readonly [string, string, string | null, string | null, string | null, number, number, string, string]> = [
  ["10:39:49", "kv/get", "notes/", "personal", "node.tinycloud.xyz", 2048, 81, "ok", "network"],
  ["10:39:51", "kv/head", "notes/", "personal", null, 0, 38, "ok", "replica"],
  ["10:39:52", "space/auth", null, null, "node.tinycloud.xyz", 1180, 96, "ok", "network"],
  ["10:40:19", "kv/list", "recordings/", "personal", null, 2210, 4, "ok", "replica"],
  ["10:40:41", "kv/get", "notes/", "work", "node.tinycloud.xyz", 4096, 77, "ok", "network"],
  ["10:40:56", "space/grant", null, "personal", "node.tinycloud.xyz", 612, 143, "ok", "network"],
  ["10:40:56", "kv/put", "recordings/", "personal", "node.tinycloud.xyz", 2411724, 498, "ok", "network"],
  ["10:41:12", "kv/list", "notes/", "lab-notes", "lab.example.org", 0, 5000, "TIMEOUT", "network"],
  ["10:41:31", "kv/get", "recordings/", "personal", "node.tinycloud.xyz", 5033164, 612, "ok", "network"],
  ["10:41:44", "kv/del", "notes/", "personal", "node.tinycloud.xyz", 0, 71, "HTTP_403", "network"],
  ["10:41:58", "kv/list", "notes/", "personal", null, 1433, 2, "ok", "replica"],
  ["10:41:58", "kv/get", "notes/", "personal", null, 2150, 3, "ok", "replica"],
  ["10:42:07", "sync/pull", "notes/", "personal", "node.tinycloud.xyz", 18842, 231, "ok", "network"],
  ["10:42:07", "kv/put", "notes/", "personal", "node.tinycloud.xyz", 3277, 112, "ok", "network"],
];

export function sampleRows(): LogRow[] {
  return SAMPLE.map(([clock, op, path, space, host, bytes, durationMs, code, source], index) => ({
    v: 1,
    id: index + 1,
    at: at(clock),
    service: op.split("/")[0],
    op,
    path,
    space,
    host,
    bytes,
    durationMs,
    attempts: 1,
    ok: code === "ok",
    code,
    source,
  }));
}

export function createRequestLog(initial: LogRow[]) {
  let rows = [...initial];
  const pushed = new Set<(event: unknown) => void>();
  const cleared = new Set<() => void>();
  const reader: RequestLogReader = {
    snapshot: () => [...rows],
    subscribe(cb) {
      pushed.add(cb);
      return () => void pushed.delete(cb);
    },
    onClear(cb) {
      cleared.add(cb);
      return () => void cleared.delete(cb);
    },
  };
  return {
    reader,
    push(row: LogRow) {
      rows.push(row);
      for (const cb of [...pushed]) cb(row);
    },
    clear() {
      rows = [];
      for (const cb of [...cleared]) cb();
    },
    listeners: () => pushed.size + cleared.size,
  };
}
