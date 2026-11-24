/**
 * Sign-out "retire the key" (TC-3443): ask every host a session used to refuse
 * its session key from now on, via the node's `POST /session/retire`. Loaded
 * when a session starts, so a sign-out right after has it at hand; the root
 * captures what the retire needs before teardown (see {@link LeavingSession}).
 *
 * A retire UCAN is self-issued by the session key to the host's node DID with
 * exactly `tinycloud.session/retire` on `urn:tinycloud:session:self`, no
 * proofs, a nonce, and a short expiry. The body carries every root delegation
 * the client holds for the key, so a host records the retire even for a root
 * it never saw. Hosts run in parallel; network errors, 429 and 503 are retried
 * a bounded number of times. The status names every host that did not confirm,
 * so no caller can claim more than happened.
 */
import type {
  LeavingSession,
  NodeSignOutFailure,
  NodeSignOutStatus,
  RetireSessionKeyInput,
  SessionRootProof,
} from "./sessionRetire";

export const RETIRE_RESOURCE = "urn:tinycloud:session:self";
export const RETIRE_ABILITY = "tinycloud.session/retire";
const ATTEMPTS = 3;
const BACKOFF_MS = [250, 1_000];
const TIMEOUT_MS = 5_000;
/** The node's cap on delegations in one retire body. */
const MAX_ROOTS = 8;
/**
 * Browsers cap a page's in-flight `keepalive` request bodies at 64 KiB in
 * total, and refuse a request past the cap. One sign-out's keepalive bodies
 * stay under this, leaving room for the page's own.
 */
const KEEPALIVE_BUDGET_BYTES = 48 * 1024;
/** What is left of one sign-out's keepalive allowance, shared by all its requests. */
interface KeepaliveBudget { bytes: number }

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
async function attempt(input: RetireSessionKeyInput, host: string, nodeDid: { value?: string }, roots: string[], budget: KeepaliveBudget | undefined): Promise<Attempt> {
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
  const body = roots.length ? JSON.stringify({ delegations: roots }) : undefined;
  // Lets a first try outlive a page that unloads right after sign-out, while the
  // sign-out's keepalive bodies stay under the browser's cap. Retries go without.
  const keepalive = budget !== undefined && (body?.length ?? 0) <= budget.bytes;
  if (keepalive) budget.bytes -= body?.length ?? 0;
  const response = await send(fetch, `${host}/session/retire`, {
    method: "POST",
    headers: roots.length
      ? { Authorization: `Bearer ${authorization}`, "Content-Type": "application/json" }
      : { Authorization: `Bearer ${authorization}` },
    body,
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
 *
 * A request refused for one carried root (a root the host refuses for a
 * lasting reason would otherwise block the retire on every sign-out) is sent
 * once more without that root, and the remaining requests still go. The host
 * is reported `refused` with that root's index even if the rest recorded; a
 * second refusal is reported instead and ends the host's requests.
 */
async function retireOnHost(input: RetireSessionKeyInput, host: string, budget: KeepaliveBudget): Promise<boolean | Failure> {
  const nodeDid = { value: input.knownNodeIds?.get(host) };
  const roots = [...new Set(input.delegations ?? [])];
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const post = async (chunk: string[]): Promise<boolean | Failure> => {
    let result: Attempt = false;
    for (let tries = 0; tries < ATTEMPTS; tries++) {
      if (tries > 0) await sleep(BACKOFF_MS[tries - 1]!);
      result = await attempt(input, host, nodeDid, chunk, tries === 0 ? budget : undefined);
      if (typeof result === "boolean" || !result.retry) break;
    }
    if (typeof result === "boolean") return result;
    const { retry: _, ...failure } = result;
    return failure;
  };
  let recorded = true;
  let refusal: Failure | undefined;
  for (let offset = 0; offset === 0 || offset < roots.length; offset += MAX_ROOTS) {
    const chunk = roots.slice(offset, offset + MAX_ROOTS);
    let result = await post(chunk);
    if (typeof result !== "boolean" && result.delegation !== undefined && !refusal) {
      const refused = result.delegation;
      refusal = { ...result, delegation: offset + refused };
      result = await post(chunk.filter((_, index) => index !== refused));
      // A second refusal's index, in the original numbering.
      if (typeof result !== "boolean" && result.delegation !== undefined && result.delegation >= refused) result.delegation += 1;
    }
    if (typeof result !== "boolean") {
      if (result.delegation !== undefined) result.delegation += offset;
      return result;
    }
    recorded &&= result;
  }
  return refusal ?? recorded;
}

/** Retire one session key on its hosts: {@link retireSessionKeys} for a single key. */
export function retireSessionKey(input: RetireSessionKeyInput): Promise<NodeSignOutStatus> {
  return retireSessionKeys([input]);
}

/**
 * Retire several keys (a session key and its bootstrap keys) on their hosts,
 * every host in parallel. Never rejects: every host ends up in exactly one of
 * the status lists. A host is confirmed when no key failed there and at least
 * one recorded; a failure's `delegation` indexes that key's roots.
 */
export async function retireSessionKeys(inputs: readonly RetireSessionKeyInput[]): Promise<NodeSignOutStatus> {
  // One keepalive allowance for the whole sign-out: its requests are in flight together.
  const budget: KeepaliveBudget = { bytes: KEEPALIVE_BUDGET_BYTES };
  const outcomes = await Promise.all(inputs.map((input) => {
    // Resolved now, at sign-out: a retry must not pick up a `fetch` installed later.
    input = { ...input, fetch: input.fetch ?? globalThis.fetch.bind(globalThis) };
    return Promise.all([...new Set(input.hosts)].map(async (host) => [host, await retireOnHost(input, host, budget)
      .catch((error): Failure => ({ reason: "failed", message: brief(String(error)) }))] as const));
  }));
  const status: NodeSignOutStatus = { confirmed: [], nothingToRecord: [], notConfirmed: [] };
  for (const host of new Set(inputs.flatMap((input) => input.hosts))) {
    const results = outcomes.flatMap((perHost) => perHost.filter(([entry]) => entry === host).map(([, result]) => result));
    const failure = results.find((result) => typeof result !== "boolean");
    if (failure) status.notConfirmed.push({ host, ...failure });
    else if (results.includes(true)) status.confirmed.push(host);
    else status.nothingToRecord.push(host);
  }
  return status;
}

/**
 * Retire the leaving session's key and each bootstrap key on every host it
 * used. Each key carries the roots among {@link LeavingSession.roots} and the
 * wallet-signed grants that verify against it: expired and not-yet-valid roots
 * included (the host skips the expired ones, and a not-yet-valid one is
 * authority the retire must outlast). A root that does not verify against the
 * key (another key's delegatee, a bad signature, malformed) is left out: one
 * such entry makes a host refuse the whole retire.
 */
export function retireLeavingSession(leaving: LeavingSession): Promise<NodeSignOutStatus> {
  const candidates: SessionRootProof[] = [...leaving.roots];
  for (const delegation of leaving.grants) {
    if (delegation.siweProof === undefined) continue;
    candidates.push({
      delegationHeader: delegation.delegationHeader,
      delegationCid: delegation.cid,
      spaceId: delegation.spaceId,
      address: delegation.ownerAddress,
      chainId: delegation.chainId,
      siwe: delegation.siweProof.siwe,
      signature: delegation.siweProof.signature,
    });
  }
  // The session key, then each bootstrap key (the primary one may be reused as a bootstrap key).
  const keys = new Map<string, object>();
  for (const { verificationMethod, jwk } of leaving.keys) if (!keys.has(verificationMethod)) keys.set(verificationMethod, jwk);
  return retireSessionKeys([...keys].map(([verificationMethod, jwk]) => {
    const roots = new Set<string>();
    for (const candidate of candidates) {
      const authorization = candidate.delegationHeader.Authorization;
      if (roots.has(authorization) || !leaving.validate) continue;
      try {
        leaving.validate({
          delegationHeader: { Authorization: authorization },
          delegationCid: candidate.delegationCid,
          spaceId: candidate.spaceId,
          jwk,
          address: leaving.canonicalizeAddress(candidate.address),
          chainId: candidate.chainId,
          siwe: candidate.siwe,
          signature: candidate.signature,
        });
        roots.add(authorization);
      } catch {
        // Not a live root of this key.
      }
    }
    return {
      signer: {
        verificationMethod,
        signJwt: async (header, payload) => {
          const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
          return `${signingInput}.${base64Url(await leaving.signBytes(new TextEncoder().encode(signingInput), jwk))}`;
        },
      },
      hosts: leaving.hosts,
      delegations: [...roots],
      knownNodeIds: leaving.knownNodeIds,
    };
  }));
}

/** Unpadded base64url of `data`'s UTF-8 bytes, or of `data`. */
function base64Url(data: string | Uint8Array): string {
  let binary = "";
  for (const byte of typeof data === "string" ? new TextEncoder().encode(data) : data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
