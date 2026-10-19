import { kvPrefixCovers } from "@tinycloud/sdk-services/kv/replication/prefix";
import type { KVReadThrough, ReplicationEvent } from "@tinycloud/sdk-services";

/** Loaded only after a refused restore. No replica storage, authority, or worker access. */
export function createGatedNetworkReadThrough(input: {
  space: string;
  prefixes: readonly string[];
  now: () => number;
  emit: (event: ReplicationEvent) => void;
}): KVReadThrough {
  const report = (
    op: "get" | "list", space: string, path: string, replica: string | null,
    reason: "replica_gated" | "not_covered" | "unsupported_option" | "network_cursor" | "NETWORK_REQUESTED" | "cursor_restart",
    outcome: "found" | "not_found" | "error", latencyMs: number,
  ) => input.emit({
    type: "replication.read", at: new Date(input.now()).toISOString(), op, space, key: path,
    replica, source: reason === "cursor_restart" ? "none" : "network", reason, outcome, latencyMs,
    stalenessMs: null, coverage: null, authority: null,
    ...(reason === "replica_gated" ? { code: "REPLICA_GATED" } : {}),
  });
  const readNetwork = async <T extends { ok: boolean }>(
    r: { space: string; network: () => Promise<T> }, op: "get" | "list", path: string,
    prefix: string | null, reason: "replica_gated" | "not_covered" | "unsupported_option" | "network_cursor" | "NETWORK_REQUESTED",
  ): Promise<T> => {
    const started = input.now();
    let outcome: "found" | "not_found" | "error" = "error";
    try {
      const result = await r.network();
      outcome = result.ok ? "found" : op === "get" && reason === "not_covered" && "error" in result &&
        (result.error as { code?: string }).code === "KV_NOT_FOUND" ? "not_found" : "error";
      return result;
    } finally {
      report(op, r.space, path, prefix, reason, outcome, input.now() - started);
    }
  };
  const covered = (path: string) => input.prefixes.find((prefix) => kvPrefixCovers(prefix, path));
  return {
    get: (r) => {
      if (r.space !== input.space) return r.network();
      if (r.options?.source === "network") return readNetwork(r, "get", r.path, null, "NETWORK_REQUESTED");
      const prefix = covered(r.path);
      return readNetwork(r, "get", r.path, prefix ?? null, prefix === undefined ? "not_covered" : "replica_gated");
    },
    list: (r) => {
      if (r.space !== input.space) return r.network();
      if (r.options?.source === "network") return readNetwork(r, "list", r.listPath, null, "NETWORK_REQUESTED");
      if (r.options?.cursor?.startsWith("tcr1.")) {
        report("list", r.space, r.listPath, null, "cursor_restart", "error", 0);
        return Promise.resolve({ ok: false, error: {
          code: "INVALID_INPUT", message: "Local list cursor cannot be served; restart without the cursor",
          service: "kv", meta: { replication: "cursor_restart" },
        } });
      }
      if (r.options?.cursor) return readNetwork(r, "list", r.listPath, null, "network_cursor");
      if (r.options?.raw) return readNetwork(r, "list", r.listPath, null, "unsupported_option");
      const prefix = covered(r.listPath);
      return readNetwork(r, "list", r.listPath, prefix ?? null, prefix === undefined ? "not_covered" : "replica_gated");
    },
    write: (r) => r.network(),
    observeNetworkRequested: (r) => {
      if (r.space === input.space) report(r.op, r.space, r.path, null, r.reason, r.outcome, r.latencyMs);
    },
  };
}
