// TC-2363: whether a signed expiry is above the request's lifetime must not depend on this machine's clock, so it is counted from
// the signed SIWE's own `Issued At`. Without a readable `Issued At` nothing is proven, so the answer is "no".
import { describe, expect, test } from "bun:test";
import { outlivesRequestFromIssuedAt } from "./scoped-login.js";

const HOUR = 3_600_000;
const issued = Date.parse("2030-01-01T00:00:00.000Z");
const siwe = (issuedAt: string | undefined) => ["example.test wants you to sign in", "", "statement", ...(issuedAt === undefined ? [] : [`Issued At: ${issuedAt}`]), "Expiration Time: 2030-01-01T01:00:00.000Z"].join("\n");

describe("outlivesRequestFromIssuedAt", () => {
  test("a lifetime as requested (and within the 30 s allowance) does not outlive it, whatever the local clock says", () => {
    expect(outlivesRequestFromIssuedAt(siwe("2030-01-01T00:00:00.000Z"), issued + HOUR, { durationMs: HOUR })).toBe(false);
    expect(outlivesRequestFromIssuedAt(siwe("2030-01-01T00:00:00.000Z"), issued + HOUR + 29_000, { durationMs: HOUR })).toBe(false);
  });
  test("a lifetime above the request does", () => {
    expect(outlivesRequestFromIssuedAt(siwe("2030-01-01T00:00:00.000Z"), issued + HOUR + 31_000, { durationMs: HOUR })).toBe(true);
    expect(outlivesRequestFromIssuedAt(siwe("2030-01-01T00:00:00.000Z"), issued + 3 * HOUR, { durationMs: HOUR })).toBe(true);
  });
  test("no readable Issued At proves nothing: not an overshoot, however long the expiry", () => {
    expect(outlivesRequestFromIssuedAt(siwe(undefined), issued + 1000 * HOUR, { durationMs: HOUR })).toBe(false);
    expect(outlivesRequestFromIssuedAt(siwe("not a date"), issued + 1000 * HOUR, { durationMs: HOUR })).toBe(false);
  });
  test("the LAST anchored Issued At line counts: a line inside the statement does not stand in for it", () => {
    const injected = siwe("2030-01-01T00:00:00.000Z").replace("statement", "Issued At: 2099-01-01T00:00:00.000Z");
    expect(outlivesRequestFromIssuedAt(injected, issued + 3 * HOUR, { durationMs: HOUR })).toBe(true);
  });
});
