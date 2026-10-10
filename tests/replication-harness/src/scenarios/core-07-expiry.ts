import type { GetResult } from "../contracts/client";

export function acceptsOfflineCliExpiry(result: GetResult, probe: true | string): boolean {
  if (probe === true) return result.exit === 3 || result.exit === 5;
  const noReplicaRead = result.read?.source !== "replica" && !result.events.some((item) =>
    item.event.type === "replication.read" && item.event.source === "replica");
  return !result.ok && typeof result.exit === "number" && result.exit !== 0 &&
    ["AUTH_REQUIRED", "GRANT_EXPIRED", "NETWORK_ERROR"].includes(result.code ?? "") && noReplicaRead;
}
