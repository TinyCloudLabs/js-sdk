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

/** Wraps the witness stub so the acquisition POST carries a witness-chosen expiry. The stub answers that POST with 200. */
function witnessOffering(ms: number): typeof globalThis.fetch {
  const witness = makeWitness({});
  return asFetch(async (url, init) => {
    const response = await witness.fetch(url, init);
    if (init?.method !== "POST" || !String(url).endsWith("/v1/acquisitions")) return response;
    const body = await response.json() as Record<string, unknown>;
    return Response.json({ ...body, expiresAt: new Date(Date.now() + ms).toISOString() }, { status: response.status });
  });
}

test("a witness that expires sooner than 15 minutes is honoured: the pending does not outlive the witness request", async () => {
  const pending = await requestEmailProofCode({ address: ADDRESS, holder: HOLDER, fetch: witnessOffering(2 * 60_000) });
  const lifetime = Date.parse(pending.expiresAt) - Date.parse(pending.createdAt);
  expect(lifetime).toBeLessThanOrEqual(2 * 60_000);
  expect(lifetime).toBeLessThan(EMAIL_PROOF_PENDING_MAX_MS);
});
