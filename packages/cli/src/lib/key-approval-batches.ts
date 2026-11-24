/**
 * Splits a secrets move's key approval into requests whose signed delegation fits the node's header limit (TC-4248).
 *
 * The node activates a delegation from the `Authorization` header of `POST /delegate`, and each exact-key resource
 * costs about 640 bytes there (measured on tee.node: 50 keys = 32,724 B), so a move of many secrets in one request
 * can exceed what the node's ingress accepts on one header line (nginx answers 400 "Request Header Or Cookie Too
 * Large" after the owner has approved). The budget comes from one bounded check against the activation origin.
 */

/** The largest `Authorization` value tee.node's ingress accepted with `large_client_header_buffers 4 32k` (measured). */
export const MEASURED_HEADER_LIMIT_BYTES = 32_751;
/** 70% of the measured 32k limit: the budget whenever the live limit is unknown. */
export const FALLBACK_BATCH_BUDGET_BYTES = Math.floor(MEASURED_HEADER_LIMIT_BYTES * 0.7);
/** The largest header line the check ever sends, and the first limit a plan assumes (256 KiB buffers). */
export const MAX_CHECK_BYTES = 256 * 1024;
/** An `Authorization` line is the value plus `Authorization: ` and CRLF. */
const HEADER_LINE_OVERHEAD_BYTES = 17;
/** The signed request around the keys: SIWE text, session key, signature, capabilities read. OpenKey's is ~1.5 KB. */
const BASE_RESERVE_BYTES = 3_000;
const MAX_HALVINGS = 3;
const CHECK_TIMEOUT_MS = 10_000;
const CHECK_HEADER = "X-TinyCloud-Header-Check";
/** nginx's "too large" page is ~200 B; more of a refusal body than this is never read. */
const MAX_ERROR_BODY_BYTES = 4096;

/**
 * Estimated `Authorization` bytes one exact-key resource adds when granted [decrypt, key.create]: the ReCap prose
 * names the resource and its two actions (L + 59), the ReCap JSON carries it with the actions and empty caveats
 * (L + 80) base64'd into the SIWE (4/3), and the whole CACAO is base64'd again (4/3). Plus 5%.
 */
export function estimateKeyBytes(resource: string): number {
  const length = new TextEncoder().encode(resource).length;
  return Math.ceil(1.05 * (4 / 3) * ((4 / 3) * (length + 80) + length + 59));
}

/** Estimated `Authorization` bytes of one request granting these resources. */
export function estimateBatchBytes(resources: readonly string[]): number {
  return resources.reduce((sum, resource) => sum + estimateKeyBytes(resource), BASE_RESERVE_BYTES);
}

/**
 * Packs key paths into batches whose estimated header stays within `budgetBytes`: sorted, then filled in order, so
 * the same keys always give the same batches. A key that alone exceeds the budget still gets a batch of its own.
 */
export function batchKeyPaths(
  keyPaths: readonly string[],
  resourceOf: (keyPath: string) => string,
  budgetBytes: number,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = BASE_RESERVE_BYTES;
  for (const keyPath of [...new Set(keyPaths)].sort()) {
    const cost = estimateKeyBytes(resourceOf(keyPath));
    if (current.length > 0 && bytes + cost > budgetBytes) {
      batches.push(current);
      current = [];
      bytes = BASE_RESERVE_BYTES;
    }
    current.push(keyPath);
    bytes += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export type HeaderCheck = "fits" | "too_large" | "unknown";

/**
 * Whether `origin` accepts one header line of `bytes`. Sends `GET /version` with a padding header of `a`s and
 * nothing else from the profile or session.
 *
 * Why this measures what `POST /delegate` hits: nginx reads every request line and header line, for any method and
 * route, into one `large_client_header_buffers` buffer before it looks at the route, and answers 400 "Request Header
 * Or Cookie Too Large" for a line that does not fit; a total-header cap in front (Cloudflare) is route-agnostic too.
 * The check's header name is longer than `Authorization`, so a check that fits implies the delegation's line fits.
 */
export async function checkHeaderFits(
  origin: string,
  bytes: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<HeaderCheck> {
  let response: Response;
  try {
    response = await fetchImpl(new URL("/version", origin), {
      method: "GET",
      headers: { [CHECK_HEADER]: "a".repeat(Math.min(bytes, MAX_CHECK_BYTES)) },
      redirect: "manual",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch {
    return "unknown";
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return "fits";
  }
  if (response.status === 431) {
    await response.body?.cancel().catch(() => undefined);
    return "too_large";
  }
  const body = await readHead(response, MAX_ERROR_BODY_BYTES);
  return response.status === 400 && /Request Header Or Cookie Too Large/i.test(body) ? "too_large" : "unknown";
}

/** The first `limit` bytes of a response body as text; the rest is never read. */
async function readHead(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value.subarray(0, limit - size));
      size += Math.min(value.length, limit - size);
    }
  } catch {
    // A body that fails part way is judged on what arrived.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export interface KeyApprovalPlan {
  batches: string[][];
  /** The budget the batches were cut to: 70% of the limit assumed, never the check's size. */
  budgetBytes: number;
  /** `measured`: the origin took the largest request (+5%); `fallback`: 70% of the measured 32k limit. */
  budgetSource: "measured" | "fallback";
}

/**
 * Plans the key approvals for `keyPaths`. The budget is 70% of an assumed header limit: 256 KiB first, halved on each
 * clear "too large", at most 3 times (at most 4 checks), with the 32k fallback as the floor. Each check sends the
 * planned largest request +5%, which stays under the limit assumed. A plan whose requests all fit the fallback needs
 * no check. Anything but a clear "fits" or a clear "too large" (network error, timeout, redirect, 5xx, no origin)
 * falls back.
 */
export async function planKeyApprovals(
  keyPaths: readonly string[],
  resourceOf: (keyPath: string) => string,
  origin: string | undefined,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<KeyApprovalPlan> {
  const fallback: KeyApprovalPlan = {
    batches: batchKeyPaths(keyPaths, resourceOf, FALLBACK_BATCH_BUDGET_BYTES),
    budgetBytes: FALLBACK_BATCH_BUDGET_BYTES,
    budgetSource: "fallback",
  };
  let limitBytes = MAX_CHECK_BYTES - HEADER_LINE_OVERHEAD_BYTES;
  for (let halvings = 0; halvings <= MAX_HALVINGS; halvings++) {
    const budgetBytes = Math.floor(limitBytes * 0.7);
    if (budgetBytes <= FALLBACK_BATCH_BUDGET_BYTES) break;
    const batches = batchKeyPaths(keyPaths, resourceOf, budgetBytes);
    const bytes = Math.max(0, ...batches.map((batch) => estimateBatchBytes(batch.map(resourceOf))));
    // A plan the 32k fallback holds needs no check; neither can one with no origin to check.
    if (bytes <= FALLBACK_BATCH_BUDGET_BYTES || origin === undefined) break;
    const verdict = await checkHeaderFits(origin, Math.ceil(bytes * 1.05), fetchImpl);
    if (verdict === "fits") return { batches, budgetBytes, budgetSource: "measured" };
    if (verdict === "unknown") break;
    limitBytes = Math.floor(limitBytes / 2);
  }
  return fallback;
}

/** The stderr line each owner run prints about its key approvals (Monica, TC-4248). */
export function keyApprovalsLine(plan: Pick<KeyApprovalPlan, "budgetBytes" | "budgetSource"> & { requests: number }): string {
  const bytes = plan.budgetBytes.toLocaleString("en-US");
  return plan.budgetSource === "measured"
    ? `Key approvals: ${plan.requests} (each up to ${bytes} bytes, measured on this node).`
    : `Key approvals: ${plan.requests} (each up to ${bytes} bytes, safe default; this node's limit was not measured).`;
}
