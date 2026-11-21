/**
 * Sign-out "retire the key" (TC-3443): ask every host a session used to refuse
 * its session key from now on, via the node's `POST /session/retire`.
 *
 * A retire UCAN is self-issued by the session key to the host's node DID with
 * exactly `tinycloud.session/retire` on `urn:tinycloud:session:self`, no
 * proofs, a nonce, and a short expiry. The body carries every root delegation
 * the client holds for the key, so a host records the retire even for a root
 * it never saw. Hosts run in parallel; network errors, 429 and 503 are retried
 * a bounded number of times. The status names every host that did not confirm,
 * so no caller can claim more than happened.
 */

export const RETIRE_RESOURCE = "urn:tinycloud:session:self";
export const RETIRE_ABILITY = "tinycloud.session/retire";
const ATTEMPTS = 3;
const BACKOFF_MS = [250, 1_000];
const TIMEOUT_MS = 5_000;
/** The node's cap on delegations in one retire body. */
const MAX_ROOTS = 8;

export interface SessionRetireSigner {
  /** `did:key:…#…` of the session key; becomes the UCAN `iss`. */
  verificationMethod: string;
  /** A compact JWT of `header` and `payload`, signed with the session key (Ed25519). */
  signJwt: (header: object, payload: object) => Promise<string>;
}

export interface NodeSignOutFailure {
  host: string;
  /**
   * - `unreachable`: no answer (network error or timeout) on every try.
   * - `refused`: 401; the host refused the request. Not retried.
   * - `unsupported`: 404; the host has no `/session/retire`. Not retried.
   * - `failed`: any other answer, including 429 or 503 on every try (see `status`).
   */
  reason: "unreachable" | "refused" | "unsupported" | "failed";
  status?: number;
  /**
   * With `refused`: the index, among the roots sent for one key, of the one
   * the host would not admit. The host wrote nothing. Not retried without it: that root
   * would then stay unrecorded on the host.
   */
  delegation?: number;
  /** The node's reply or the transport error, at most 200 characters. Diagnostics only. */
  message?: string;
}

/** Per host, what the last sign-out's node calls achieved. */
export interface NodeSignOutStatus {
  /** Hosts that recorded the retire: the session key is refused there. */
  confirmed: string[];
  /** Hosts that answered `recorded: false`: they held no grant for the key. Not confirmed. */
  nothingToRecord: string[];
  notConfirmed: NodeSignOutFailure[];
}

/**
 * The hosts a session's delegations went to, shared by TinyCloudNode and its
 * authorization layer. `onAdd` hears each new host so the owner can save it.
 */
export class SessionHosts {
  private readonly hosts = new Set<string>();
  onAdd?: () => void;

  add(host: string): void {
    if (this.hosts.has(host)) return;
    this.hosts.add(host);
    this.onAdd?.();
  }

  /** Replace the contents without notifying: a restore or a session's end. */
  reset(hosts: Iterable<string> = []): void {
    this.hosts.clear();
    for (const host of hosts) this.hosts.add(host);
  }

  list(): string[] {
    return [...this.hosts];
  }
}

export interface RetireSessionKeyInput {
  signer: SessionRetireSigner;
  hosts: readonly string[];
  /**
   * Every root delegation the client holds for the session key, as the
   * `Authorization` value `/delegate` takes. Sent to every host, so a host
   * that never saw a root still covers it. Each must name the session key as
   * its delegatee: one that does not makes the host refuse the request.
   */
  delegations?: readonly string[];
  /** Node DIDs already known for some hosts (sign-in `/info`, registry). Others are fetched from `/info`. */
  knownNodeIds?: ReadonlyMap<string, string>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type Failure = Omit<NodeSignOutFailure, "host">;
/** `true`: recorded; `false`: nothing to record. */
type Attempt = boolean | (Failure & { retry?: boolean });

const brief = (text: string) => text.trim().slice(0, 200) || undefined;
const retryable = (status: number) => status === 429 || status === 503;

async function send(fetch: typeof globalThis.fetch, url: string, init: RequestInit): Promise<Response | Attempt> {
  try {
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    return { reason: "unreachable", message: brief(error instanceof Error ? error.message : String(error)), retry: true };
  }
}

/** One try for one host: learn its node DID if needed, then post a freshly signed retire. */
async function attempt(input: RetireSessionKeyInput, host: string, nodeDid: { value?: string }, roots: string[], keepalive: boolean): Promise<Attempt> {
  const fetch = input.fetch!;
  if (!nodeDid.value) {
    const response = await send(fetch, `${host}/info`, {});
    if (!(response instanceof Response)) return response;
    const did = response.ok ? ((await response.json().catch(() => undefined)) as { nodeId?: unknown } | undefined)?.nodeId : undefined;
    if (typeof did !== "string" || !did) return { reason: "failed", status: response.status, retry: retryable(response.status) };
    nodeDid.value = did;
  }
  let authorization: string;
  try {
    authorization = await input.signer.signJwt({ alg: "EdDSA", typ: "JWT", ucv: "0.10.0" }, {
      iss: input.signer.verificationMethod,
      aud: nodeDid.value,
      // The node refuses a retire that expires more than 120 s ahead; 60 s leaves room for clock skew.
      exp: Math.floor((input.now ?? Date.now)() / 1000) + 60,
      nnc: crypto.randomUUID(),
      prf: [],
      att: { [RETIRE_RESOURCE]: { [RETIRE_ABILITY]: [{}] } },
    });
  } catch (error) {
    return { reason: "failed", message: brief(String(error)) };
  }
  const response = await send(fetch, `${host}/session/retire`, {
    method: "POST",
    headers: roots.length
      ? { Authorization: `Bearer ${authorization}`, "Content-Type": "application/json" }
      : { Authorization: `Bearer ${authorization}` },
    body: roots.length ? JSON.stringify({ delegations: roots }) : undefined,
    // Lets the first try outlive a page that unloads right after sign-out.
    // Retries go without: browsers cap a page's in-flight keepalive bodies at 64 KiB.
    keepalive,
  });
  if (!(response instanceof Response)) return response;
  // Only `recorded: true` means the host wrote the retire.
  if (response.ok) return ((await response.json().catch(() => undefined)) as { recorded?: unknown } | undefined)?.recorded === true;
  const text = await response.text().catch(() => "");
  const failure: Failure & { retry?: boolean } = { reason: "failed", status: response.status, message: brief(text), retry: retryable(response.status) };
  if (response.status === 404) failure.reason = "unsupported";
  if (response.status === 401) {
    failure.reason = "refused";
    // `session_retire_invalid: delegation <i>: …` names the carried root the host refused.
    const index = /^session_retire_invalid: delegation (\d+):/.exec(text)?.[1];
    if (index) failure.delegation = Number(index);
  }
  return failure;
}

/**
 * Every root goes to the host, at most {@link MAX_ROOTS} per request, one
 * request after another. The host confirms only when every request recorded.
 */
async function retireOnHost(input: RetireSessionKeyInput, host: string): Promise<boolean | Failure> {
  const nodeDid = { value: input.knownNodeIds?.get(host) };
  const roots = [...new Set(input.delegations ?? [])];
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let recorded = true;
  for (let offset = 0; offset === 0 || offset < roots.length; offset += MAX_ROOTS) {
    let result: Attempt = false;
    for (let tries = 0; tries < ATTEMPTS; tries++) {
      if (tries > 0) await sleep(BACKOFF_MS[tries - 1]!);
      result = await attempt(input, host, nodeDid, roots.slice(offset, offset + MAX_ROOTS), tries === 0);
      if (typeof result === "boolean" || !result.retry) break;
    }
    if (typeof result !== "boolean") {
      const { retry: _, ...failure } = result;
      if (failure.delegation !== undefined) failure.delegation += offset;
      return failure;
    }
    recorded &&= result;
  }
  return recorded;
}

/**
 * Retire the session key on every host, in parallel. Never rejects: every
 * host ends up in exactly one of the status lists.
 */
export async function retireSessionKey(input: RetireSessionKeyInput): Promise<NodeSignOutStatus> {
  // Resolved now, at sign-out: a retry must not pick up a `fetch` installed later.
  input = { ...input, fetch: input.fetch ?? globalThis.fetch.bind(globalThis) };
  const hosts = [...new Set(input.hosts)];
  const results = await Promise.all(hosts.map((host) =>
    retireOnHost(input, host).catch((error): Failure => ({ reason: "failed", message: brief(String(error)) }))));
  const status: NodeSignOutStatus = { confirmed: [], nothingToRecord: [], notConfirmed: [] };
  hosts.forEach((host, index) => {
    const result = results[index]!;
    if (result === true) status.confirmed.push(host);
    else if (result === false) status.nothingToRecord.push(host);
    else status.notConfirmed.push({ host, ...result });
  });
  return status;
}

/**
 * Retire several keys (a session key and its bootstrap keys) on their hosts.
 * A host is confirmed when no key failed there and at least one recorded; a
 * failure's `delegation` indexes that key's roots.
 */
export async function retireSessionKeys(inputs: readonly RetireSessionKeyInput[]): Promise<NodeSignOutStatus> {
  const statuses = await Promise.all(inputs.map(retireSessionKey));
  if (statuses.length === 1) return statuses[0]!;
  const merged: NodeSignOutStatus = { confirmed: [], nothingToRecord: [], notConfirmed: [] };
  for (const host of new Set(inputs.flatMap((input) => input.hosts))) {
    const failure = statuses.flatMap((status) => status.notConfirmed).find((entry) => entry.host === host);
    if (failure) merged.notConfirmed.push(failure);
    else if (statuses.some((status) => status.confirmed.includes(host))) merged.confirmed.push(host);
    else merged.nothingToRecord.push(host);
  }
  return merged;
}
