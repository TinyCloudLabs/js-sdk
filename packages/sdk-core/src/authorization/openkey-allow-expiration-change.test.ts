import { describe, it, expect } from "bun:test";
import {
  diffImmutableSiweFields,
  extractImmutableSiweFields,
} from "./openkey-protocol";

// `allowExpirationChange` is the opt-in for a request that carried `expiryChangeable: true` (TC-2276): it drops
// `expirationTime` from the compared fields and nothing else.

const SIWE = [
  "example.com wants you to sign in with your Ethereum account:",
  "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  "",
  "By signing this message you agree to the terms.",
  "",
  "URI: did:key:z6Mkexample",
  "Version: 1",
  "Chain ID: 1",
  "Nonce: abcdef01",
  "Issued At: 2026-08-01T00:00:00.000Z",
  "Expiration Time: 2026-08-01T01:00:00.000Z",
  "Not Before: 2026-08-01T00:00:00.000Z",
  "Resources:",
  "- urn:recap:eyJhdHQiOnsidGlueWNsb3VkOmZvby9rdi9kYXRhIjp7InRpbnljbG91ZC5rdi9nZXQiOlt7fV19fSwicHJmIjpbXX0",
].join("\n");

const EXPIRY_LINE = "Expiration Time: 2026-08-01T01:00:00.000Z";
const original = extractImmutableSiweFields(SIWE);
const withLine = (from: string, to: string) => extractImmutableSiweFields(SIWE.replace(from, to));

describe("diffImmutableSiweFields allowExpirationChange", () => {
  it("still flags expirationTime when the option is absent or false", () => {
    const later = withLine(EXPIRY_LINE, "Expiration Time: 2027-01-01T00:00:00.000Z");
    expect(diffImmutableSiweFields(original, later)).toEqual(["expirationTime"]);
    expect(diffImmutableSiweFields(original, later, { allowExpirationChange: false })).toEqual(["expirationTime"]);
    expect(diffImmutableSiweFields(original, later, { originalHasRecap: true })).toEqual(["expirationTime"]);
  });

  it("accepts an extended expiry", () => {
    const later = withLine(EXPIRY_LINE, "Expiration Time: 2027-01-01T00:00:00.000Z");
    expect(diffImmutableSiweFields(original, later, { allowExpirationChange: true, originalHasRecap: true })).toEqual([]);
  });

  it("accepts a shortened expiry", () => {
    const earlier = withLine(EXPIRY_LINE, "Expiration Time: 2026-08-01T00:10:00.000Z");
    expect(diffImmutableSiweFields(original, earlier, { allowExpirationChange: true, originalHasRecap: true })).toEqual([]);
  });

  it("accepts a signed message that dropped the expiry line (the expiry helper is the one that refuses that)", () => {
    const none = withLine(`${EXPIRY_LINE}\n`, "");
    expect(diffImmutableSiweFields(original, none, { allowExpirationChange: true, originalHasRecap: true })).toEqual([]);
  });

  for (const [field, from, to] of [
    ["nonce", "Nonce: abcdef01", "Nonce: 00000000"],
    ["issuedAt", "Issued At: 2026-08-01T00:00:00.000Z", "Issued At: 2026-08-01T00:00:01.000Z"],
    ["notBefore", "Not Before: 2026-08-01T00:00:00.000Z", "Not Before: 2026-07-31T00:00:00.000Z"],
    ["domain", "example.com wants", "attacker.example wants"],
    ["uri", "URI: did:key:z6Mkexample", "URI: did:key:z6Mkother"],
    ["chainId", "Chain ID: 1", "Chain ID: 137"],
    ["version", "Version: 1", "Version: 2"],
  ] as const) {
    it(`still lists ${field} drift when the expiry also changed`, () => {
      const changed = extractImmutableSiweFields(
        SIWE.replace(from, to).replace(EXPIRY_LINE, "Expiration Time: 2027-01-01T00:00:00.000Z"),
      );
      expect(diffImmutableSiweFields(original, changed, { allowExpirationChange: true, originalHasRecap: true })).toEqual([field]);
    });
  }

  it("still lists statement drift for a message without a ReCap, and non-ReCap resource drift", () => {
    const changedStatement = extractImmutableSiweFields(
      SIWE.replace("By signing this message you agree to the terms.", "Different.").replace(EXPIRY_LINE, "Expiration Time: 2027-01-01T00:00:00.000Z"),
    );
    expect(diffImmutableSiweFields(original, changedStatement, { allowExpirationChange: true })).toEqual(["statement"]);
    const extraResource = extractImmutableSiweFields(`${SIWE}\n- https://other.example/`);
    expect(diffImmutableSiweFields(original, extraResource, { allowExpirationChange: true, originalHasRecap: true })).toEqual(["nonRecapResources"]);
  });
});
