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
 * In-flight `POST /delegate` activations, keyed by host + full delegation header.
 *
 * Why this exists (TC-332): a session delegation is replayed byte-for-byte by
 * many call sites (registry sync, space-hosting hooks, retry wrappers), and
 * several of them fire without awaiting each other. On the node, a *root*
 * session delegation has no parents, so `delegate()` derives an empty guard-root
 * set and acquires no chain locks; on PostgreSQL there is also no `writer_lock`
 * to serialize writes. Two byte-identical concurrent POSTs therefore compute the
 * same `epoch_hash`, both INSERT into `epoch`, and the loser takes SQLSTATE
 * 23505 on `pk-epoch`, surfacing as HTTP 500. Coalescing identical concurrent
 * activations into one request removes the trigger client-side.
 *
 * Scope is module-level, not per-client, deliberately:
 *   - `activateSessionWithHost` is a free function with no owning instance, and
 *     every one of its call sites imports this same module instance.
 *   - The collision is on the node's `(space, epoch_hash)` primary key, which is
 *     indifferent to which client object issued the POST. Two `TinyCloudNode`
 *     instances in one realm holding the same session would still collide, so
 *     per-instance state would not cover the race.
 *
 * Only *in-flight* promises are stored, never settled results. Activation is a
 * server-side mutation whose response reflects live space state (`activated` /
 * `skipped`) and whose session can be revoked, so replaying a completed result
 * would hand callers stale data and suppress legitimate re-activation. Entries
 * are evicted the moment the request settles, so sequential calls behave exactly
 * as they did before this change and the map cannot grow without bound.
 */
const inFlightActivations = new Map<string, Promise<SpaceHostResult>>();

/**
 * Build a collision-free single-flight key from the host and the *complete*
 * delegation header.
 *
 * The header is serialized in full (never truncated or hashed) as a sorted array
 * of entries, so two headers coalesce only if every name/value pair matches.
 * JSON encoding keeps the key unambiguous regardless of what characters appear
 * in a token.
 */
function activationFlightKey(
  host: string,
  delegationHeader: Record<string, string>
): string {
  const entries = Object.entries(delegationHeader).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return JSON.stringify([host, entries]);
}

/**
 * Activate a session with TinyCloud server.
 *
 * This submits the session delegation to the server, enabling the session
 * key to perform operations on behalf of the user.
 *
 * Concurrent calls with the same host and a byte-identical delegation header
 * share a single `POST /delegate`; see {@link inFlightActivations}. Sequential
 * calls always issue a fresh request.
 *
 * @param host - TinyCloud server URL
 * @param delegationHeader - Session delegation header (from session.delegationHeader)
 * @returns Result indicating success/failure (404 means space doesn't exist)
 */
export async function activateSessionWithHost(
  host: string,
  delegationHeader: { Authorization: string }
): Promise<SpaceHostResult> {
  const key = activationFlightKey(host, delegationHeader as Record<string, string>);

  const existing = inFlightActivations.get(key);
  if (!existing) return startActivationFlight(key, host, delegationHeader);

  try {
    return await existing;
  } catch {
    // Join the in-flight request, but never leave a joining caller worse off
    // than it would have been without de-duplication. If the shared request
    // fails at the *network* level (`fetch` threw), the joiner attempts once on
    // its own rather than inheriting a failure it never caused. HTTP error
    // *results* — including the 500 this change exists to prevent — are shared
    // as-is: they are the server's verdict on these exact bytes, and re-POSTing
    // them would reintroduce the fan-out. Callers keep their own retry policies
    // on top of this.
    return joinOrStartActivationFlight(key, host, delegationHeader);
  }
}

/**
 * Second and final attempt for callers displaced by a failed shared flight.
 *
 * Never retries again, which bounds the failure path at two requests no matter
 * how many callers were coalesced: whichever displaced caller runs first starts
 * the replacement flight, and the rest join it.
 */
function joinOrStartActivationFlight(
  key: string,
  host: string,
  delegationHeader: { Authorization: string }
): Promise<SpaceHostResult> {
  return (
    inFlightActivations.get(key) ?? startActivationFlight(key, host, delegationHeader)
  );
}

function startActivationFlight(
  key: string,
  host: string,
  delegationHeader: { Authorization: string }
): Promise<SpaceHostResult> {
  const flight = postSessionActivation(host, delegationHeader);
  inFlightActivations.set(key, flight);

  // Evict on settle, for both fulfilment and rejection, so a rejected flight
  // never poisons a later retry. This handler is attached before any caller's
  // continuation, so the entry is already gone by the time a caller resumes —
  // even one that retries synchronously from its own `catch`. The identity check
  // avoids evicting a newer flight registered under the same key.
  const evict = () => {
    if (inFlightActivations.get(key) === flight) inFlightActivations.delete(key);
  };
  flight.then(evict, evict);

  return flight;
}

async function postSessionActivation(
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
