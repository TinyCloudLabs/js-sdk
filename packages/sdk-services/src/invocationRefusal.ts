import type { FetchResponse } from "./types";

const timeRefusal = Symbol();
export type InvocationRefusal = string | typeof timeRefusal;
export const refusedInvocations = new WeakMap<FetchResponse, InvocationRefusal>();

/** Only local signed request data can identify a refused proof. */
export function classifyInvocationRefusal(status: number, signed?: string): InvocationRefusal | undefined {
  if ((status !== 401 && status !== 403) || !signed) return;
  try {
    const payload = signed.split(".")[1];
    const { prf, exp, nbf, iat } = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    const now = Date.now() / 1000;
    if ((Number.isFinite(exp) && exp <= now)
      || (Number.isFinite(nbf) && nbf > now)
      || (Number.isFinite(iat) && iat > now)) return timeRefusal;
    if (Number.isFinite(exp) && (nbf == null || Number.isFinite(nbf))
      && (iat == null || Number.isFinite(iat))
      && Array.isArray(prf) && prf.length === 1 && typeof prf[0] === "string" && prf[0]) return prf[0];
  } catch {
    // Unparseable authorization cannot establish an authority verdict.
  }
}

export function invocationRefusalMeta(refusal: InvocationRefusal | undefined, detail: string) {
  // The node returns this exact plain-text reason for invocation timestamp validation.
  if (refusal === timeRefusal || detail.trim() === "Invocation expired or not yet valid") {
    return { invocationTimeRefused: true };
  }
  return refusal === undefined ? undefined : { invocationProofCid: refusal };
}
