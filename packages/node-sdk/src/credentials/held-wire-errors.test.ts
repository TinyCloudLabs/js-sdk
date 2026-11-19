import { describe, expect, test } from "bun:test";
import { completeEmailProofWithIssuerKeys, EmailProofError, requestEmailProofCode, type EmailProofErrorCode, type EmailProofStep } from "./email-proof";
import { createHeldWitness, testAccountHolder, vectors, type RecordedResponse, type WitnessRoute } from "./test-support/held-witness";

// The nine create_malformed_input_* refusals are the address rules the SDK enforces locally (held-wire.test.ts, S4).
// TC-2254 C2.12 and C9.5 (4): every recorded refusal of the real witness (vectors.json `refusals`, 91) is replayed through the SDK
// at its own route, and must map to the stable EmailProofError the contract's table gives. The wallet is never reached on a refusal
// before R6, and nothing after a refusal is called.
const ANVIL_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const T0 = Date.parse("2026-10-30T06:53:00Z");

interface Refusal { name: string; request: { method: string; path: string }; response: { status: number; headers?: Record<string, string>; body: { code?: string; recoverable?: boolean } } }
const refusals = vectors.refusals as Refusal[];

function routeOf(path: string): WitnessRoute {
  if (path === "/v1/acquisitions") return "create";
  return path.split("/").pop() as WitnessRoute;
}
/** The EmailProofError the contract table (C2.12) gives for a wire code at the SDK step that sees it. */
function expected(code: string, step: EmailProofStep, wire: Refusal["response"]): { code: EmailProofErrorCode; recoverable?: boolean } {
  switch (code) {
    case "UNSUPPORTED_PROFILE": case "DESCRIPTOR_MISMATCH": case "UNSUPPORTED_VERSION": return { code: "PROFILE_UNAVAILABLE", recoverable: false };
    case "RATE_LIMITED": return { code: "RATE_LIMITED" };
    case "DELIVERY_FAILED": case "ISSUER_UNREADY": return { code: "ISSUER_UNAVAILABLE", recoverable: true };
    case "REQUEST_EXPIRED": case "CHALLENGE_EXPIRED": return { code: "SESSION_EXPIRED", recoverable: false };
    case "CHALLENGE_REPLAYED": case "SIGNATURE_REPLAYED": case "ISSUANCE_REPLAYED": case "REQUEST_REPLAYED": case "RESULT_REPLAYED": return { code: "SESSION_INVALID", recoverable: false };
    case "SIGNATURE_REJECTED": return { code: "SIGNATURE_REJECTED", recoverable: true };
    case "PROOF_REJECTED": return wire.body.recoverable ? { code: "CODE_REJECTED", recoverable: true } : { code: "CODE_ATTEMPTS_EXHAUSTED", recoverable: false };
    default: // every other 4xx envelope is an unclassified rejection, mapped by the step that saw it
      return step === "request" || step === "session" ? { code: "FAILED", recoverable: false } : step === "code" ? { code: "CODE_REJECTED", recoverable: false } : { code: "CREDENTIAL_INVALID", recoverable: false };
  }
}
async function outcome(run: () => Promise<unknown>): Promise<EmailProofError | undefined> {
  try { await run(); } catch (error) { if (error instanceof EmailProofError) return error; throw error; }
  return undefined;
}

describe("the 91 recorded refusals map to the contract's SDK errors", () => {
  test("the vector file carries 91 named refusals", () => {
    expect(refusals).toHaveLength(91);
    expect(new Set(refusals.map((r) => r.name)).size).toBe(91);
  });

  const replayable = refusals.filter((r) => r.response.body && typeof r.response.body.code === "string" && !r.name.startsWith("create_malformed_input"));
  for (const refusal of replayable) {
    test(`${refusal.name}: ${refusal.response.body.code} (${refusal.response.status})`, async () => {
      const route = routeOf(refusal.request.path);
      const time = { server: T0 };
      const witness = createHeldWitness({ serverClock: () => time.server });
      const holder = testAccountHolder(ANVIL_0);
      const input = { address: "alice@example.com", holder, profile: "tinycloud.email-held/v1" as const, allowHeldProfile: true as const, fetch: witness.fetch, now: () => new Date(time.server) };
      const forced = refusal.response as unknown as RecordedResponse;
      let error: EmailProofError | undefined;
      let step: EmailProofStep;
      if (route === "create" || route === "state" || route === "challenge") {
        (witness.force as Record<string, RecordedResponse>)[route] = forced;
        step = "request";
        error = await outcome(() => requestEmailProofCode(input));
      } else {
        const pending = await requestEmailProofCode(input);
        (witness.force as Record<string, RecordedResponse>)[route] = forced;
        step = route === "result" ? "credential" : "code";
        error = await outcome(() => completeEmailProofWithIssuerKeys({ pending, code: "12345678", holder, fetch: witness.fetch, now: input.now, allowHeldProfile: true }, witness.issuerKeys));
      }
      const want = expected(refusal.response.body.code!, step, refusal.response);
      expect([refusal.name, error?.code]).toEqual([refusal.name, want.code]);
      if (want.recoverable !== undefined) expect(error?.recoverable).toBe(want.recoverable);
      if (want.code === "RATE_LIMITED") expect(error?.retryAfterMs).toBe(Number(refusal.response.headers?.["retry-after"]) * 1000);
      // Nothing after the refusal is called: no second R3, and the wallet is only ever reached after the proof.
      expect(witness.calls.filter((c) => c.route === "challenge").length).toBeLessThanOrEqual(1);
      if (route !== "holder-signature" && route !== "issue" && route !== "result") expect(holder.calls.count).toBe(0);
    });
  }
});
