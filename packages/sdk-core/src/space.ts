/**
 * Shared space utilities for TinyCloud.
 *
 * These functions are platform-agnostic and can be used by both
 * web-sdk and node-sdk for space hosting and session activation.
 */

/**
 * Result of a space hosting or session activation attempt.
 */
export interface SpaceHostResult {
  /** Whether the operation succeeded (2xx status) */
  success: boolean;
  /** HTTP status code */
  status: number;
  /** Error message if failed */
  error?: string;
  /** Space IDs that were successfully activated */
  activated?: string[];
  /** Space IDs that were skipped (e.g., space doesn't exist yet) */
  skipped?: string[];
  /** Raw node receipt CID. This identifies the commit event, not the delegation. */
  commitEventCid?: string;
}

/**
 * Fetch the peer ID from TinyCloud server for space hosting.
 *
 * The peer ID identifies the TinyCloud server instance that will host the space.
 *
 * @param host - TinyCloud server URL (e.g., "https://node.tinycloud.xyz")
 * @param spaceId - The space ID to host
 * @returns The peer ID string
 * @throws Error if the request fails
 */
export async function fetchPeerId(
  host: string,
  spaceId: string
): Promise<string> {
  const res = await fetch(
    `${host}/peer/generate/${encodeURIComponent(spaceId)}`
  );

  if (!res.ok) {
    const error = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to get peer ID: ${res.status} - ${error}`);
  }

  return res.text();
}

/**
 * Submit a space hosting delegation to TinyCloud server.
 *
 * This registers a new space with the server, allowing the user
 * to store data in it.
 *
 * @param host - TinyCloud server URL
 * @param headers - Delegation headers (from siweToDelegationHeaders)
 * @returns Result indicating success/failure
 */
export async function submitHostDelegation(
  host: string,
  headers: Record<string, string>
): Promise<SpaceHostResult> {
  const res = await fetch(`${host}/delegate`, {
    method: "POST",
    headers,
  });

  if (!res.ok) {
    return {
      success: false,
      status: res.status,
      error: await res.text().catch(() => res.statusText),
    };
  }
  try {
    const body = await res.json() as { cid?: string; activated?: string[]; skipped?: string[] };
    return {
      success: true,
      status: res.status,
      commitEventCid: body.cid,
      activated: body.activated ?? [],
      skipped: body.skipped ?? [],
    };
  } catch {
    return { success: true, status: res.status, activated: [], skipped: [] };
  }
}

/**
 * Activate a session with TinyCloud server.
 *
 * This submits the session delegation to the server, enabling the session
 * key to perform operations on behalf of the user.
 *
 * @param host - TinyCloud server URL
 * @param delegationHeader - Session delegation header (from session.delegationHeader)
 * @returns Result indicating success/failure (404 means space doesn't exist)
 */
export async function activateSessionWithHost(
  host: string,
  delegationHeader: { Authorization: string }
): Promise<SpaceHostResult> {
  const res = await fetch(`${host}/delegate`, {
    method: "POST",
    headers: delegationHeader,
  });

  if (res.ok) {
    try {
      const body = await res.json() as { cid?: string; activated?: string[]; skipped?: string[] };
      return {
        success: true,
        status: res.status,
        activated: body.activated ?? [],
        skipped: body.skipped ?? [],
        commitEventCid: body.cid,
      };
    } catch {
      // Fallback for older servers that return plain text CID
      return {
        success: true,
        status: res.status,
        activated: [],
        skipped: [],
      };
    }
  }

  return {
    success: false,
    status: res.status,
    error: await res.text().catch(() => res.statusText),
  };
}
