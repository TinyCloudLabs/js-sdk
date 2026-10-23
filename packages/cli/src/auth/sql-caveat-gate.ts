import {
  SQL_DELEGATED_CAVEATS_FEATURE,
  SqlDelegatedCaveatsUnsupportedError,
  sqlCaveatListNeedsDelegatedFeature,
} from "@tinycloud/sdk-core";

interface CaveatedPermission {
  readonly service: string;
  readonly caveats?: readonly Record<string, unknown>[];
}

/** Whether any permission asks for a delegated SQL caveat (or two or more empty-only entries). */
export function needsSqlDelegatedCaveats(permissions: readonly CaveatedPermission[]): boolean {
  return permissions.some((entry) => entry.service === "tinycloud.sql" && sqlCaveatListNeedsDelegatedFeature(entry.caveats));
}

/** How long the `/info` read may take before the request is refused (as `checkNodeInfo`). */
const INFO_TIMEOUT_MS = 5000;

/**
 * For a flow with no signed-in node yet (a first login): read the node's
 * `GET /info` and refuse, before the owner is asked to approve anything, a
 * request that needs `sql-delegated-caveats-v1` when the node does not list it,
 * cannot be read, or does not answer within `timeoutMs`. Nothing is fetched
 * for a request that needs no feature.
 */
export async function assertHostSupportsSqlDelegatedCaveats(
  host: string,
  permissions: readonly CaveatedPermission[],
  fetchFn: typeof fetch = fetch,
  timeoutMs = INFO_TIMEOUT_MS,
): Promise<void> {
  if (!needsSqlDelegatedCaveats(permissions)) return;
  let features: unknown;
  try {
    const response = await fetchFn(`${host.replace(/\/+$/, "")}/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) features = ((await response.json()) as { features?: unknown } | null)?.features;
  } catch {
    features = undefined;
  }
  if (!Array.isArray(features) || !features.includes(SQL_DELEGATED_CAVEATS_FEATURE)) {
    throw new SqlDelegatedCaveatsUnsupportedError(host);
  }
}
