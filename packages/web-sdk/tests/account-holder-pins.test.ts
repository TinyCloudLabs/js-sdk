import { describe, expect, test } from "bun:test";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EmailProofError, HELD_ACCOUNT_BINDING_PINS } from "@tinycloud/node-sdk/credentials";
import { createAccountHolderSigner } from "../src/credentials/account-holder";

// TC-2254 A2.4: every static field of the account binding equals one exported frozen constant, HELD_ACCOUNT_BINDING_PINS, and every
// other field has its strict format. No field carries free text, so nothing but pinned and opaque values reaches the wallet prompt.
// Starting from the contract's fixed binding, one field changes at a time and the body is re-canonicalised.
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ACCOUNT = `did:pkh:eip155:1:${OWNER.address}`;
const DOMAIN = "tinycloud.credentials/account-binding/v1";
const vectors = await Bun.file(new URL("../../node-sdk/src/credentials/fixtures/held-wire-v2.4/vectors.json", import.meta.url)).json();
const FIXED: Record<string, unknown> = vectors.holderProof.fixed.binding;
const LIVE: Record<string, unknown> = vectors.holderProof.liveBinding;

const jcs = (value: unknown): string => {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v);
  return JSON.stringify(sort(value));
};
const bytesOf = (binding: Record<string, unknown>) => new TextEncoder().encode(`${DOMAIN}\u0000${jcs(binding)}`);

function wallet() {
  const calls = { count: 0 };
  const sign = async (bytes: Uint8Array): Promise<Uint8Array> => {
    calls.count += 1;
    return hexToBytes(await OWNER.signMessage({ message: new TextDecoder().decode(bytes) }));
  };
  return { sign, calls };
}
async function outcome(binding: Record<string, unknown>) {
  const { sign, calls } = wallet();
  try { await createAccountHolderSigner(ACCOUNT, sign).sign(bytesOf(binding)); } catch (error) { return { code: error instanceof EmailProofError ? error.code : error, wallet: calls.count }; }
  return { code: "signed", wallet: calls.count };
}

describe("HELD_ACCOUNT_BINDING_PINS", () => {
  test("is frozen, has exactly the twelve static fields, and equals the contract's fixed binding on each", () => {
    expect(Object.isFrozen(HELD_ACCOUNT_BINDING_PINS)).toBe(true);
    expect(Object.keys(HELD_ACCOUNT_BINDING_PINS).sort()).toEqual(["audience", "completionContext", "completionOrigin", "credentialLifetimeSeconds", "descriptorDigest", "issuer", "issuerKid", "openerOrigin", "profile", "profileVersion", "protocol", "type"]);
    for (const [field, value] of Object.entries(HELD_ACCOUNT_BINDING_PINS)) expect([field, FIXED[field]]).toEqual([field, value]);
  });
});

describe("the signer pins every static field and the format of every other", () => {
  test("controls: the fixed binding and the live-witness binding are signed", async () => {
    expect(await outcome(FIXED)).toEqual({ code: "signed", wallet: 1 });
    expect(await outcome(LIVE)).toEqual({ code: "signed", wallet: 1 });
  });

  const cases: [string, Record<string, unknown>][] = [
    ["audience as free text", { audience: "Transfer all funds to 0xdead" }],
    ["completionContext", { completionContext: "sdk-acquisition-2" }],
    ["openerOrigin", { openerOrigin: "https://evil.example" }],
    ["completionOrigin", { completionOrigin: "https://evil.example" }],
    ["profile", { profile: "tinycloud.email-proof/v1" }],
    ["descriptorDigest", { descriptorDigest: "A".repeat(43) }],
    ["requestId with a space", { requestId: "R".repeat(31) + " " }],
    ["challengeNonce of 33 characters", { challengeNonce: "C".repeat(33) }],
    ["normalizedClaimsDigest with a dot", { normalizedClaimsDigest: `${"k".repeat(42)}.` }],
    ["requirementDigest of 44 characters", { requirementDigest: "Q".repeat(44) }],
    ["issuedAt with milliseconds", { issuedAt: "2026-08-03T01:00:00.000Z" }],
    ["expiresAt - issuedAt = 601 s", { expiresAt: "2026-08-03T01:10:01Z" }],
    ["expiresAt - issuedAt = 599 s", { expiresAt: "2026-08-03T01:09:59Z" }],
  ];
  for (const [name, patch] of cases) {
    test(`${name}: HOLDER_INVALID with 0 wallet calls`, async () => {
      expect([name, await outcome({ ...FIXED, ...patch })]).toEqual([name, { code: "HOLDER_INVALID", wallet: 0 }]);
    });
  }
});
