import { expect, test } from "bun:test";
import { createPrivateKey, sign } from "node:crypto";
import { createEd25519HolderSigner, EMAIL_PROOF_PENDING_MAX_MS, requestEmailProofCode } from "./email-proof";
import { generateHolderKey, makeWitness } from "./test-support/witness-stub.mjs";

const ADDRESS = "reader@example.com";

/** Types a fetch implementation as `typeof globalThis.fetch` without a cast: Bun's fetch type includes `preconnect`. */
function asFetch(impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof globalThis.fetch {
  return Object.assign(impl, { preconnect: (_url?: string | URL) => {} });
}

const holderKey = generateHolderKey();
const privateKey = createPrivateKey({ key: holderKey.jwk, format: "jwk" });
const HOLDER = createEd25519HolderSigner(holderKey.bare, async (bytes) => new Uint8Array(sign(null, bytes, privateKey)));

/**
 * Wraps the witness stub so the acquisition POST carries a witness-chosen expiry, stamped at response time.
 * `served()` returns the exact expiry the witness stamped, which is the baseline the pending must honour:
 * `pending.createdAt` is read before the request, so measuring against it would race the response clock.
 */
function witnessOffering(ms: number): { fetch: typeof globalThis.fetch; served: () => number | undefined } {
  const witness = makeWitness({});
  let served: number | undefined;
  const fetch = asFetch(async (url, init) => {
    const response = await witness.fetch(url, init);
    if (init?.method !== "POST" || !String(url).endsWith("/v1/acquisitions")) return response;
    const body = await response.json() as Record<string, unknown>;
    served = Date.now() + ms;
    return Response.json({ ...body, expiresAt: new Date(served).toISOString() }, { status: response.status });
  });
  return { fetch, served: () => served };
}

test("a witness that expires sooner than 15 minutes is honoured: the pending does not outlive the witness request", async () => {
  const witness = witnessOffering(2 * 60_000);
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: witness.fetch });
  const served = witness.served();
  expect(served).toBeDefined();
  expect(Date.parse(pending.expiresAt)).toBe(served!);
  expect(Date.parse(pending.expiresAt) - Date.parse(pending.createdAt)).toBeLessThan(EMAIL_PROOF_PENDING_MAX_MS);
});
