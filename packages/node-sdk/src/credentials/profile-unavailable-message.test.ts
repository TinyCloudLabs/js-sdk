import { describe, expect, test } from "bun:test";
import { acquireEmailProofWithIssuerKeys, EmailProofError, requestEmailProofCode } from "./email-proof";
import { createHeldWitness, testAccountHolder } from "./test-support/held-witness";

// TC-1454: PROFILE_UNAVAILABLE keeps its code at every throw site, but its text must be true at each. The shared text says the WITNESS does not offer
// the profile; the local refusal of the disabled held profile contacts no witness, so it says what is true: this SDK build does not enable it.
const HELD = "tinycloud.email-held/v1" as const;
const ANVIL_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const T0 = Date.parse("2026-10-30T06:53:00Z");
const LOCAL = "This SDK build doesn't enable the email verification profile.";
const WITNESS = "The witness does not offer the email verification profile.";

async function failure(run: () => Promise<unknown>): Promise<EmailProofError | undefined> {
  try { await run(); } catch (error) { if (error instanceof EmailProofError) return error; throw error; }
  return undefined;
}

describe("PROFILE_UNAVAILABLE text", () => {
  test("the local refusal (held profile, no per-call opt-in) says this SDK build does not enable it, and contacts no witness", async () => {
    const witness = createHeldWitness({ serverClock: () => T0 });
    const error = await failure(() => requestEmailProofCode({ address: "alice@example.com", holder: testAccountHolder(ANVIL_0), profile: HELD, fetch: witness.fetch, now: () => new Date(T0) }));
    expect([error?.code, error?.message, error?.recoverable]).toEqual(["PROFILE_UNAVAILABLE", LOCAL, false]);
    expect(witness.calls).toHaveLength(0);
  });

  test("the witness-side refusal (the catalog does not offer the held profile) keeps the shared text", async () => {
    const witness = createHeldWitness({ serverClock: () => T0, capability: false });
    const error = await failure(() => acquireEmailProofWithIssuerKeys({ address: "alice@example.com", holder: testAccountHolder(ANVIL_0), profile: HELD, allowHeldProfile: true, fetch: witness.fetch, now: () => new Date(T0), getCode: async () => "12345678" }, witness.issuerKeys));
    expect([error?.code, error?.message]).toEqual(["PROFILE_UNAVAILABLE", WITNESS]);
    expect(witness.calls.length).toBeGreaterThan(0);
  });

  test("the witness-side refusal for a descriptor that does not match the pin keeps the shared text as well", async () => {
    const witness = createHeldWitness({ serverClock: () => T0, catalogDigest: "A".repeat(43) });
    const error = await failure(() => acquireEmailProofWithIssuerKeys({ address: "alice@example.com", holder: testAccountHolder(ANVIL_0), profile: HELD, allowHeldProfile: true, fetch: witness.fetch, now: () => new Date(T0), getCode: async () => "12345678" }, witness.issuerKeys));
    expect([error?.code, error?.message]).toEqual(["PROFILE_UNAVAILABLE", WITNESS]);
  });
});
