import type { GetResult } from "../contracts/client";

const acceptedRefusalCodes = new Set(["AUTH_REQUIRED", "GRANT_EXPIRED", "NETWORK_ERROR"]);
const acceptedErrorEnvelope = /"code"\s*:\s*"(?:AUTH_REQUIRED|GRANT_EXPIRED|NETWORK_ERROR)"/;

export function acceptsOfflineCliExpiry(result: GetResult, probe: true | string): boolean {
  if (probe === true) return result.exit === 3 || result.exit === 5;
  const noReplicaRead = result.read?.source !== "replica" && !result.events.some((item) =>
    item.event.type === "replication.read" && item.event.source === "replica");
  const hasAllowedCode = (result.code !== undefined && acceptedRefusalCodes.has(result.code)) || acceptedErrorEnvelope.test(result.stderr ?? "");
  return !result.ok && typeof result.exit === "number" && result.exit !== 0 && hasAllowedCode && noReplicaRead;
}
