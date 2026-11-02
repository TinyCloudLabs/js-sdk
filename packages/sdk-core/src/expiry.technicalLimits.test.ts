import { describe, expect, test } from "bun:test";
import {
  EXPIRY,
  MAX_SIWE_EXPIRY_MS,
  assertExpiryWithinTechnicalLimit,
  technicalExpiryRefusal,
} from "./expiry";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const SIWE_MESSAGE =
  "expiry is not a valid date or is later than 9999-12-31, the latest date a TinyCloud sign-in message can carry; choose an earlier expiry";
const NOT_A_DATE = "expiry is not a valid date or is later than 9999-12-31, the latest date a TinyCloud sign-in message can carry; choose an earlier expiry";

describe("the technical limit of a wallet-signed message", () => {
  test("is the latest whole second a sign-in message can carry", () => {
    expect(new Date(MAX_SIWE_EXPIRY_MS).toISOString()).toBe("9999-12-31T23:59:59.000Z");
    expect(Date.parse("9999-12-31T23:59:59Z")).toBe(MAX_SIWE_EXPIRY_MS);
  });

  test("the old ten-year policy constant is gone", () => {
    expect("MAX_MS" in EXPIRY).toBe(false);
  });
});

describe("technicalExpiryRefusal", () => {
  test("accepts the last second of 9999", () => {
    expect(technicalExpiryRefusal(MAX_SIWE_EXPIRY_MS)).toBeNull();
    expect(technicalExpiryRefusal(new Date("9999-12-31T23:59:59Z"))).toBeNull();
  });

  test("accepts what the old ten-year limit refused", () => {
    const now = Date.now();
    for (const ahead of [10 * YEAR_MS + 24 * 60 * 60 * 1000, 11 * YEAR_MS, 100 * YEAR_MS]) {
      expect(technicalExpiryRefusal(now + ahead)).toBeNull();
    }
  });

  test("refuses one second after the last second of 9999 with the dated message", () => {
    expect(technicalExpiryRefusal(MAX_SIWE_EXPIRY_MS + 1000)).toBe(SIWE_MESSAGE);
    expect(technicalExpiryRefusal(new Date(Date.UTC(10000, 0, 1)))).toBe(SIWE_MESSAGE);
  });

  test("refuses the largest date JavaScript can hold, whose ISO string has a six-digit year", () => {
    expect(new Date(8.64e15).toISOString()).toBe("+275760-09-13T00:00:00.000Z");
    expect(technicalExpiryRefusal(new Date(8.64e15))).toBe(SIWE_MESSAGE);
  });

  test("refuses an invalid Date, NaN and Infinity clearly instead of letting toISOString throw", () => {
    expect(technicalExpiryRefusal(new Date(Number.NaN))).toBe(NOT_A_DATE);
    expect(technicalExpiryRefusal(new Date(8.64e15 + 1))).toBe(NOT_A_DATE);
    expect(technicalExpiryRefusal(Number.NaN)).toBe(NOT_A_DATE);
    expect(technicalExpiryRefusal(Number.POSITIVE_INFINITY)).toBe(NOT_A_DATE);
  });
});

describe("assertExpiryWithinTechnicalLimit", () => {
  test("returns for an accepted expiry and throws the refusal as an Error", () => {
    expect(() => assertExpiryWithinTechnicalLimit(MAX_SIWE_EXPIRY_MS)).not.toThrow();
    expect(() => assertExpiryWithinTechnicalLimit(MAX_SIWE_EXPIRY_MS + 1000)).toThrow(SIWE_MESSAGE);
    expect(() => assertExpiryWithinTechnicalLimit(new Date(Number.NaN))).toThrow(/not a valid date/);
  });

  test("never surfaces a raw RangeError", () => {
    for (const expiry of [new Date(8.64e15 + 1), new Date(Number.NaN), Number.MAX_VALUE, Date.now() + 3.15e18]) {
      let thrown: unknown;
      try {
        assertExpiryWithinTechnicalLimit(expiry);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(RangeError);
    }
  });
});
