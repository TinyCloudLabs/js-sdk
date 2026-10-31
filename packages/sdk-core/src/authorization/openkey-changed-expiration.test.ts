import { describe, it, expect } from "bun:test";
import { EXPIRY } from "../expiry";
import { checkChangedExpiration } from "./openkey-protocol";

// checkChangedExpiration is the gate for a request that carried `expiryChangeable: true` (TC-2276): the user may
// have changed the expiry in OpenKey, and nothing else may differ.

const NOW = Date.parse("2026-08-01T00:30:00.000Z");
const ISSUED = "2026-08-01T00:00:00.000Z";
const PREPARED_EXPIRY = "2026-08-01T01:00:00.000Z";

function siwe(
  parts: { expiry?: string | null; notBefore?: string; issuedAt?: string; nonce?: string; extra?: string[]; statement?: string } = {},
): string {
  return [
    "example.com wants you to sign in with your Ethereum account:",
    "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
    "",
    parts.statement ?? "I further authorize the stated URI to perform the following actions.",
    "",
    "URI: did:key:z6Mkexample",
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${parts.nonce ?? "abcdef01"}`,
    `Issued At: ${parts.issuedAt ?? ISSUED}`,
    ...(parts.expiry === null ? [] : [`Expiration Time: ${parts.expiry ?? PREPARED_EXPIRY}`]),
    ...(parts.notBefore ? [`Not Before: ${parts.notBefore}`] : []),
    ...(parts.extra ?? []),
    "Resources:",
    "- urn:recap:eyJhdHQiOnsidGlueWNsb3VkOmZvby9rdi9kYXRhIjp7InRpbnljbG91ZC5rdi9nZXQiOlt7fV19fSwicHJmIjpbXX0",
  ].join("\n");
}

const iso = (ms: number) => new Date(ms).toISOString();
const check = (signed: string, options: { prepared?: string; now?: number; maxExpiresAt?: number } = {}) =>
  checkChangedExpiration({
    preparedSiwe: options.prepared ?? siwe(),
    signedSiwe: signed,
    now: options.now ?? NOW,
    ...(options.maxExpiresAt === undefined ? {} : { maxExpiresAt: options.maxExpiresAt }),
  });

describe("checkChangedExpiration accepts", () => {
  it("a later expiry", () => {
    expect(check(siwe({ expiry: "2026-08-02T00:00:00.000Z" }))).toBeNull();
  });

  it("an earlier expiry", () => {
    expect(check(siwe({ expiry: "2026-08-01T00:40:00.000Z" }))).toBeNull();
  });

  it("an expiry just past the 60 second margin", () => {
    expect(check(siwe({ expiry: iso(NOW + 60_001) }))).toBeNull();
  });

  it("an expiry exactly at the request max and exactly at the ten-year ceiling", () => {
    expect(check(siwe({ expiry: "2026-08-01T03:00:00.000Z" }), { maxExpiresAt: Date.parse("2026-08-01T03:00:00.000Z") })).toBeNull();
    expect(check(siwe({ expiry: iso(NOW + EXPIRY.MAX_MS) }))).toBeNull();
  });

  it("an unchanged expiry, including one that is already inside the margin (the prepared bytes were not edited)", () => {
    const soon = siwe({ expiry: iso(NOW + 5_000) });
    expect(check(soon, { prepared: soon })).toBeNull();
  });

  it("a changed expiry on a message that has a Not Before", () => {
    const withNotBefore = siwe({ notBefore: "2026-08-01T00:00:00.000Z" });
    expect(check(siwe({ notBefore: "2026-08-01T00:00:00.000Z", expiry: "2026-08-03T00:00:00.000Z" }), { prepared: withNotBefore })).toBeNull();
  });
});

describe("checkChangedExpiration refuses", () => {
  it("an expiry at or before now", () => {
    expect(check(siwe({ expiry: iso(NOW) }))).toContain("expiry");
    expect(check(siwe({ expiry: iso(NOW - 1) }))).toContain("expiry");
  });

  it("an expiry inside the 60 second margin, including exactly now + 60 s", () => {
    expect(check(siwe({ expiry: iso(NOW + 59_999) }))).toContain("expiry");
    expect(check(siwe({ expiry: iso(NOW + 60_000) }))).toContain("expiry");
  });

  it("an expiry at or before Issued At (with a clock behind the message)", () => {
    const early = Date.parse("2026-07-31T00:00:00.000Z");
    // After now + 60 s, so only the Issued At rule can refuse it.
    expect(check(siwe({ expiry: "2026-07-31T12:00:00.000Z" }), { now: early })).toContain("Issued At");
    expect(check(siwe({ expiry: ISSUED }), { now: early })).toContain("Issued At");
  });

  it("an expiry at or before Not Before", () => {
    const prepared = siwe({ notBefore: "2026-08-01T02:00:00.000Z" });
    expect(check(siwe({ notBefore: "2026-08-01T02:00:00.000Z", expiry: "2026-08-01T01:30:00.000Z" }), { prepared })).toContain("Not Before");
    expect(check(siwe({ notBefore: "2026-08-01T02:00:00.000Z", expiry: "2026-08-01T02:00:00.000Z" }), { prepared })).toContain("Not Before");
  });

  it("an expiry beyond the request max", () => {
    const max = Date.parse("2026-08-01T03:00:00.000Z");
    expect(check(siwe({ expiry: iso(max + 1) }), { maxExpiresAt: max })).toContain("maximum");
  });

  it("an expiry beyond the ten-year ceiling when there is no request max", () => {
    expect(check(siwe({ expiry: iso(NOW + EXPIRY.MAX_MS + 1) }))).toBe(
      "expiry is more than 10 years away, the longest this SDK accepts; choose a shorter expiry",
    );
  });

  it("two Expiration Time lines, whichever one the parser would pick", () => {
    const lines = ["Expiration Time: 2026-08-01T00:50:00.000Z"];
    expect(check(siwe({ expiry: "2026-08-02T00:00:00.000Z", extra: lines }))).toContain("exactly one");
    expect(check(siwe({ expiry: "2026-08-01T00:50:00.000Z", extra: ["Expiration Time: 2026-08-02T00:00:00.000Z"] }))).toContain("exactly one");
    // A second line smuggled in through the statement.
    expect(check(siwe({ expiry: "2026-08-02T00:00:00.000Z", statement: "Hello.\nExpiration Time: 2026-08-01T00:50:00.000Z" }))).toContain("exactly one");
  });

  it("a signed message with no Expiration Time, or an unparseable one", () => {
    expect(check(siwe({ expiry: null }))).toContain("exactly one");
    expect(check(siwe({ expiry: "tomorrow" }))).toContain("expiry");
    expect(check(siwe({ expiry: "2026-13-45T00:00:00.000Z" }))).toContain("expiry");
  });

  it("a prepared message that has no Expiration Time to compare with", () => {
    expect(check(siwe({ expiry: "2026-08-02T00:00:00.000Z" }), { prepared: siwe({ expiry: null }) })).toContain("exactly one");
  });

  it("a changed Issued At together with a valid changed expiry", () => {
    const reason = check(siwe({ issuedAt: "2026-08-01T00:00:30.000Z", expiry: "2026-08-02T00:00:00.000Z" }));
    expect(reason).toContain("altered immutable SIWE fields");
    expect(reason).toContain("issuedAt");
  });

  it("a changed non-expiry field together with a valid changed expiry", () => {
    const nonce = check(siwe({ nonce: "00000000", expiry: "2026-08-02T00:00:00.000Z" }));
    expect(nonce).toContain("altered immutable SIWE fields");
    expect(nonce).toContain("nonce");
    const domain = check(siwe({ expiry: "2026-08-02T00:00:00.000Z" }).replace("example.com", "attacker.example"));
    expect(domain).toContain("domain");
    const resource = check(`${siwe({ expiry: "2026-08-02T00:00:00.000Z" })}\n- https://other.example/`);
    expect(resource).toContain("nonRecapResources");
  });

  it("a changed non-expiry field with an unchanged expiry", () => {
    expect(check(siwe({ nonce: "00000000" }))).toContain("nonce");
  });
});
