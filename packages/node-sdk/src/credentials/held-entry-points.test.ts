import { describe, expect, test } from "bun:test";
import { acquireEmailProof, completeEmailProof, EmailProofError, requestEmailProofCode } from "./email-proof";
import { isTicketEmailProofResult, type EmailProofResult } from "./email-proof";
import { createHeldWitness, testAccountHolder } from "./test-support/held-witness";

// TC-2254 contract C8.3 (1), ruled by the contract owner: EVERY public entry point that can reach the held profile refuses it WITHOUT the explicit
// per-call opt-in, with PROFILE_UNAVAILABLE / UNSUPPORTED_PROFILE, BEFORE any network call. No exception for the low-level driver or the web root.
//   email-proof entry points: requestEmailProofCode, completeEmailProof, acquireEmailProof (here). The driver (transport, interpreter) is in
//   held-optin-transport.test.ts, the web-sdk entry points in web-sdk/tests, the CLI share publish in cli.
const HELD = "tinycloud.email-held/v1" as const;
const ANVIL_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("the email-proof entry points refuse the held profile without the opt-in, with zero requests", () => {
  const witness = () => createHeldWitness();
  const holder = () => testAccountHolder(ANVIL_0);
  const refusal = async (run: () => Promise<unknown>) => { try { await run(); } catch (e) { return e instanceof EmailProofError ? e.code : e; } return "no-throw"; };

  test("requestEmailProofCode, completeEmailProof and acquireEmailProof", async () => {
    const w = witness();
    const h = holder();
    const input = { address: "alice@example.com", holder: h, profile: HELD, fetch: w.fetch };
    expect(await refusal(() => requestEmailProofCode(input))).toBe("PROFILE_UNAVAILABLE");
    expect(await refusal(() => acquireEmailProof({ ...input, getCode: async () => "12345678" }))).toBe("PROFILE_UNAVAILABLE");
    const pending = { type: "TinyCloudEmailProofPending", version: 1, profile: HELD, address: "alice@example.com", requestId: "R".repeat(32), verifier: "v", holderDid: h.did, descriptorDigest: "D".repeat(43), requirementDigest: "Q".repeat(43), openerOrigin: "https://localhost", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), serverExpiresAt: new Date(Date.now() + 600_000).toISOString() };
    expect(await refusal(() => completeEmailProof({ pending: pending as never, code: "12345678", holder: h, fetch: w.fetch }))).toBe("PROFILE_UNAVAILABLE");
    expect(w.calls).toHaveLength(0);
    expect(h.calls.count).toBe(0);
  });
});

describe("a held result is not a ticket result", () => {
  test("isTicketEmailProofResult is false for the held profile and true for the ticket", () => {
    const result = (id: string) => ({ envelope: { profile: { id, version: 1 } } }) as unknown as EmailProofResult;
    expect(isTicketEmailProofResult(result(HELD))).toBe(false);
    expect(isTicketEmailProofResult(result("tinycloud.email-proof/v1"))).toBe(true);
  });
});
