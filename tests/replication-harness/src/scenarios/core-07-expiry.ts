import type { GetResult } from "../contracts/client";

export const acceptedRefusalCodes = new Set(["AUTH_REQUIRED", "GRANT_EXPIRED", "NETWORK_ERROR"]);

export function hasCliErrorEnvelopeCode(stderr: string, codes: ReadonlySet<string> = acceptedRefusalCodes): boolean {
  const match = /\{\s*"error"\s*:\s*\{[\s\S]*?"code"\s*:\s*"([^"]+)"/.exec(stderr);
  return match !== null && codes.has(match[1]!);
}

export function acceptsOfflineCliExpiry(result: GetResult, probe: true | string): boolean {
  if (probe === true) return result.exit === 3 || result.exit === 5;
  const noReplicaRead = result.read?.source !== "replica" && !result.events.some((item) =>
    item.event.type === "replication.read" && item.event.source === "replica");
  return !result.ok && typeof result.exit === "number" && result.exit !== 0 && hasCliErrorEnvelopeCode(result.stderr ?? "") && noReplicaRead;
}
