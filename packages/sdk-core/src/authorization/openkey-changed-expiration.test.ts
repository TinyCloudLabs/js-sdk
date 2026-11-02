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
    const reason = check(siwe({ expiry: iso(max + 1) }), { maxExpiresAt: max });
    expect(reason).toContain("maximum");
    // Names the limit, so the person who picked the expiry knows what to choose instead.
    expect(reason).toContain("2026-08-01T03:00:00.000Z");
  });

  it("an expiry beyond the ten-year ceiling when there is no request max", () => {
    expect(check(siwe({ expiry: iso(NOW + EXPIRY.MAX_MS + 1) }))).toBe(
      "expiry is more than 10 years away, the longest this SDK accepts; choose a shorter expiry",
    );
  });

  // OpenKey signs any expiry the user picks; the SDK refuses the ones it cannot accept, and each refusal says what to pick.
  it("every refusal of a picked expiry says what to pick instead", () => {
    expect(check(siwe({ expiry: iso(NOW + 59_999) }))).toBe("expiry must be more than 60 seconds from now; choose a longer expiry");
    const max = Date.parse("2026-08-01T03:00:00.000Z");
    expect(check(siwe({ expiry: iso(max + 1) }), { maxExpiresAt: max })).toBe(
      "expiry is later than the maximum for this request (the latest allowed is 2026-08-01T03:00:00.000Z); choose an earlier expiry",
    );
    const early = Date.parse("2026-07-31T00:00:00.000Z");
    expect(check(siwe({ expiry: ISSUED }), { now: early })).toBe("expiry must be after Issued At; choose a later expiry");
    expect(check(siwe({ expiry: iso(NOW + EXPIRY.MAX_MS + 1) }))).toContain("choose a shorter expiry");
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

// Review follow-up (TC-2276): the helper is a public export, so it must not accept on its own what only the SIWE
// parser would have refused, and it must fail closed on inputs that make every comparison false.
describe("checkChangedExpiration fails closed", () => {
  const later = () => siwe({ expiry: "2026-08-02T00:00:00.000Z" });

  it("on a non-finite current time, changed or unchanged expiry", () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(check(later(), { now })).toContain("finite");
      expect(check(siwe(), { now })).toContain("finite");
    }
    expect(checkChangedExpiration({ preparedSiwe: siwe(), signedSiwe: later(), now: new Date(Number.NaN) })).toContain("finite");
  });

  it("on a non-finite maximum, however far the expiry is", () => {
    for (const maxExpiresAt of [Number.NaN, Number.POSITIVE_INFINITY, 1e20]) {
      expect(check(later(), { maxExpiresAt })).toContain("finite");
    }
    expect(checkChangedExpiration({ preparedSiwe: siwe(), signedSiwe: later(), now: NOW, maxExpiresAt: new Date(Number.NaN) })).toContain("finite");
  });
});

describe("checkChangedExpiration refuses a non-canonical Expiration Time line", () => {
  const expiry = "2026-08-02T00:00:00.000Z";
  const canonical = () => siwe({ expiry });
  const variants: Array<[string, () => string]> = [
    ["CRLF line endings", () => canonical().replace(/\n/g, "\r\n")],
    ["a lone carriage return", () => canonical().replace("\nURI:", "\r\nURI:")],
    ["a tab after the colon", () => canonical().replace("Expiration Time: ", "Expiration Time:\t")],
    ["a no-break space after the colon", () => canonical().replace("Expiration Time: ", "Expiration Time:\u00a0")],
    ["two spaces after the colon", () => canonical().replace("Expiration Time: ", "Expiration Time:  ")],
    ["a trailing space", () => canonical().replace(expiry, `${expiry} `)],
    ["no space after the colon", () => canonical().replace("Expiration Time: ", "Expiration Time:")],
    ["the line after Resources", () => `${siwe({ expiry: null })}\nExpiration Time: ${expiry}`],
  ];

  for (const [label, build] of variants) {
    it(label, () => {
      expect(check(build())).toContain("canonical");
    });
  }

  it("but still accepts the canonical form", () => {
    expect(check(canonical())).toBeNull();
  });
});

// Opus P3-2: the statement is line 3. A statement that is exactly `Resources:` must not be mistaken for the Resources
// list (which would wrongly refuse even an unchanged expiry).
describe("checkChangedExpiration with a statement that is exactly Resources:", () => {
  const statement = "Resources:";

  it("accepts an unchanged expiry", () => {
    expect(check(siwe({ statement }), { prepared: siwe({ statement }) })).toBeNull();
  });

  it("accepts a changed expiry", () => {
    expect(check(siwe({ statement, expiry: "2026-08-02T00:00:00.000Z" }), { prepared: siwe({ statement }) })).toBeNull();
  });

  it("still refuses an expiry line placed after the real Resources list", () => {
    const after = `${siwe({ statement, expiry: null })}\nExpiration Time: 2026-08-02T00:00:00.000Z`;
    expect(check(after, { prepared: siwe({ statement }) })).toContain("canonical");
  });
});
