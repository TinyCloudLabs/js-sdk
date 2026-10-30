import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { acquireEmailProofWithIssuerKeys, createEd25519HolderSigner, EmailProofError } from "./email-proof";
import { createHeldWitness, testAccountHolder } from "./test-support/held-witness";
import { makeWitness } from "./test-support/witness-stub.mjs";

// TC-2254 test-gap round (delta read of 4a8526532): behaviours that no test pinned, each killed by a scratch mutation recorded in the PR notes.
const HELD = "tinycloud.email-held/v1" as const;
const ANVIL_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const A1 = "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const T0 = Date.parse("2026-10-30T06:53:00Z");
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

async function failure(run: () => Promise<unknown>): Promise<EmailProofError | undefined> {
  try { await run(); } catch (error) { if (error instanceof EmailProofError) return error; throw error; }
  return undefined;
}

describe("the result envelope is cross-checked against the credential, field by field (C5.5 (i), (ii))", () => {
  const run = async (mutateResult: (r: Record<string, unknown>) => Record<string, unknown>) => {
    const witness = createHeldWitness({ serverClock: () => T0, mutateResult });
    const holder = testAccountHolder(ANVIL_0);
    const error = await failure(() => acquireEmailProofWithIssuerKeys({ address: "alice@example.com", holder, profile: HELD, allowHeldProfile: true, fetch: witness.fetch, now: () => new Date(T0), getCode: async () => "12345678" }, witness.issuerKeys));
    return { error, witness };
  };

  test("(a) an envelope that names another account in BOTH account fields together, over this account's credential, is refused", async () => {
    // Both fields agree with each other, so only the comparison with the holder (and the credential) can catch it.
    const { error } = await run((r) => ({ ...r, subject: A1, holderBinding: { ...(r.holderBinding as object), did: A1 } }));
    expect([error?.code, error?.step]).toEqual(["CREDENTIAL_INVALID", "credential"]);
  });

  test("(b) an envelope whose claims.emailDomain differs from the credential's, with the same email, is refused", async () => {
    const { error } = await run((r) => ({ ...r, claims: { ...(r.claims as object), emailDomain: "other.example" } }));
    expect([error?.code, error?.step]).toEqual(["CREDENTIAL_INVALID", "credential"]);
  });
});

describe("a ticket (did:key) wallet error keeps its mapping (C8.2)", () => {
  function didKeyFor(publicKey: Uint8Array): string {
    let n = BigInt(`0x${Buffer.from([0xed, 0x01, ...publicKey]).toString("hex")}`);
    let encoded = "";
    while (n > 0n) { encoded = BASE58[Number(n % 58n)] + encoded; n /= 58n; }
    return `did:key:z${encoded}`;
  }

  test("(e) a signer that throws on the ticket flow is CODE_REJECTED, not SIGNATURE_REJECTED (the held mapping is for the held flow only)", async () => {
    const seed = ed25519.utils.randomPrivateKey();
    const holder = createEd25519HolderSigner(didKeyFor(ed25519.getPublicKey(seed)), async () => { throw new Error("user declined"); });
    const witness = makeWitness({ code: "12345678" });
    const fetch = Object.assign(witness.fetch, { preconnect: () => {} }) as typeof globalThis.fetch;
    const error = await failure(() => acquireEmailProofWithIssuerKeys({ address: "reader@example.com", holder, fetch, getCode: async () => "12345678" }, witness.issuerKeys));
    expect(error).toBeInstanceOf(EmailProofError);
    expect(error?.code).toBe("CODE_REJECTED");
    expect(error?.code).not.toBe("SIGNATURE_REJECTED");
  });
});
