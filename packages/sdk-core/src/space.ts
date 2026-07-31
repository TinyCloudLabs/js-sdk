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
 * @param fetchFn - Fetch implementation to use (TC-407: defaults to global fetch,
 *   but callers should pass their instance's configured/pooled fetch so this
 *   request observes the same transport as everything else they do)
 * @returns The peer ID string
 * @throws Error if the request fails
 */
export async function fetchPeerId(
  host: string,
  spaceId: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<string> {
  const res = await fetchFn(
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
 * @param fetchFn - Fetch implementation to use (TC-407: defaults to global fetch;
 *   pass the caller's configured/pooled fetch to keep this on the same transport)
 * @returns Result indicating success/failure
 */
export async function submitHostDelegation(
  host: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<SpaceHostResult> {
  const res = await fetchFn(`${host}/delegate`, {
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
 * Stable per-fetch-implementation identity (TC-407).
 *
 * Two `TinyCloudNode` instances can be configured with different `fetch`
 * overrides (different pools, different trust boundaries) yet legitimately
 * issue byte-identical activation requests to the same host. Coalescing
 * those into one in-flight request would let one caller's transport
 * override silently satisfy another's request, breaking transport
 * isolation. A `WeakMap` keyed on the function reference assigns each
 * distinct fetch identity a small integer id without retaining unrelated
 * fetch functions (they're garbage-collectable once the owning instance is).
 */
const fetchIdentities = new WeakMap<typeof fetch, number>();
let nextFetchIdentityId = 0;

function fetchIdentity(fetchFn: typeof fetch): number {
  let id = fetchIdentities.get(fetchFn);
  if (id === undefined) {
    id = nextFetchIdentityId++;
    fetchIdentities.set(fetchFn, id);
  }
  return id;
}

/**
 * Build a collision-free single-flight key from the host, the *complete*
 * delegation header, and the fetch implementation's identity.
 *
 * The header is serialized in full (never truncated or hashed) as a sorted array
 * of entries, so two headers coalesce only if every name/value pair matches.
 * JSON encoding keeps the key unambiguous regardless of what characters appear
 * in a token. Including the fetch identity ensures coalescing never crosses
 * a transport/trust boundary (see {@link fetchIdentity}).
 */
function activationFlightKey(
  host: string,
  delegationHeader: Record<string, string>,
  fetchFn: typeof fetch
): string {
  const entries = Object.entries(delegationHeader).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return JSON.stringify([host, entries, fetchIdentity(fetchFn)]);
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
 * @param fetchFn - Fetch implementation to use (TC-407: defaults to global fetch;
 *   pass the caller's configured/pooled fetch to keep this on the same transport).
 *   Also partitions the single-flight coalescing key — see {@link fetchIdentity}.
 * @returns Result indicating success/failure (404 means space doesn't exist)
 */
export async function activateSessionWithHost(
  host: string,
  delegationHeader: { Authorization: string },
  fetchFn: typeof fetch = globalThis.fetch
): Promise<SpaceHostResult> {
  const key = activationFlightKey(host, delegationHeader as Record<string, string>, fetchFn);

  const existing = inFlightActivations.get(key);
  if (!existing) return startActivationFlight(key, host, delegationHeader, fetchFn);

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
    return joinOrStartActivationFlight(key, host, delegationHeader, fetchFn);
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
  delegationHeader: { Authorization: string },
  fetchFn: typeof fetch
): Promise<SpaceHostResult> {
  return (
    inFlightActivations.get(key) ?? startActivationFlight(key, host, delegationHeader, fetchFn)
  );
}

function startActivationFlight(
  key: string,
  host: string,
  delegationHeader: { Authorization: string },
  fetchFn: typeof fetch
): Promise<SpaceHostResult> {
  const flight = postSessionActivation(host, delegationHeader, fetchFn);
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
  delegationHeader: { Authorization: string },
  fetchFn: typeof fetch
): Promise<SpaceHostResult> {
  const res = await fetchFn(`${host}/delegate`, {
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
