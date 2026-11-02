import { describe, it, expect } from "bun:test";
import { MAX_SIWE_EXPIRY_MS } from "../expiry";
import { checkChangedExpiration } from "./openkey-protocol";

// The only upper bound on a user-changed sign-in expiry is the latest date a sign-in message can carry
// (9999-12-31T23:59:59Z). The former "ten years from now" ceiling is gone; every other rule stays (the neighbouring
// openkey-changed-expiration.test.ts covers the margin, Issued At, Not Before and the request maximum).

const NOW = Date.parse("2026-08-01T00:30:00.000Z");
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISSUED = "2026-08-01T00:00:00.000Z";
const PREPARED_EXPIRY = "2026-08-01T01:00:00.000Z";
const DATED =
  "expiry is not a valid date or is later than 9999-12-31, the latest date a TinyCloud sign-in message can carry; choose an earlier expiry";

function siwe(expiry: string): string {
  return [
    "example.com wants you to sign in with your Ethereum account:",
    "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
    "",
    "I further authorize the stated URI to perform the following actions.",
    "",
    "URI: did:key:z6Mkexample",
    "Version: 1",
    "Chain ID: 1",
    "Nonce: abcdef01",
    `Issued At: ${ISSUED}`,
    `Expiration Time: ${expiry}`,
    "Resources:",
    "- urn:recap:eyJhdHQiOnsidGlueWNsb3VkOmZvby9rdi9kYXRhIjp7InRpbnljbG91ZC5rdi9nZXQiOlt7fV19fSwicHJmIjpbXX0",
  ].join("\n");
}

const check = (expiry: string, maxExpiresAt?: number) =>
  checkChangedExpiration({
    preparedSiwe: siwe(PREPARED_EXPIRY),
    signedSiwe: siwe(expiry),
    now: NOW,
    ...(maxExpiresAt === undefined ? {} : { maxExpiresAt }),
  });
const iso = (ms: number) => new Date(ms).toISOString();

describe("checkChangedExpiration: the 9999 limit replaces the ten-year ceiling", () => {
  it("accepts 9999-12-31T23:59:59Z, the latest second a sign-in message can carry", () => {
    expect(check("9999-12-31T23:59:59Z")).toBeNull();
    expect(check(iso(MAX_SIWE_EXPIRY_MS))).toBeNull();
  });

  it("accepts ten years and a day, eleven years and a hundred years from now", () => {
    for (const ahead of [10 * YEAR_MS + DAY_MS, 11 * YEAR_MS, 100 * YEAR_MS]) {
      expect(check(iso(NOW + ahead))).toBeNull();
    }
  });

  it("refuses the first instant after that second with the dated message", () => {
    expect(check("9999-12-31T23:59:59.001Z")).toBe(DATED);
  });

  it("refuses a five-digit year (which the strict four-digit timestamp grammar cannot read) with the dated message", () => {
    expect(check("+010000-01-01T00:00:00.000Z")).toBe(DATED);
    expect(check(new Date(Date.UTC(10000, 0, 1)).toISOString())).toBe(DATED);
  });

  it("still calls a garbled timestamp not valid", () => {
    expect(check("tomorrow")).toBe("expiry is not a valid timestamp");
    expect(check("2026-13-45T00:00:00.000Z")).toBe("expiry is not a valid timestamp");
  });

  it("applies the request maximum first when it is the nearer limit", () => {
    const max = Date.parse("2026-08-01T03:00:00.000Z");
    expect(check(iso(max), max)).toBeNull();
    expect(check(iso(max + 1), max)).toBe(
      "expiry is later than the maximum for this request (the latest allowed is 2026-08-01T03:00:00.000Z); choose an earlier expiry",
    );
  });
});
