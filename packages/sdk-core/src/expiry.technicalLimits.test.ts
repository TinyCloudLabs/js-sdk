import { describe, expect, test } from "bun:test";
import {
  EXPIRY,
  MAX_SIWE_EXPIRY_MS,
  MAX_UCAN_EXPIRY_MS,
  assertExpiryWithinTechnicalLimit,
  technicalExpiryRefusal,
} from "./expiry";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const SIWE_MESSAGE =
  "expiry is later than 9999-12-31, the latest date a TinyCloud sign-in message can carry; choose an earlier expiry";
const UCAN_MESSAGE =
  "expiry is later than 2255-06-05, the latest date an agent or share delegation can carry (UCAN limit); the session itself can be signed to 9999-12-31; choose an earlier expiry";

describe("the two technical expiry limits", () => {
  test("are the latest whole second a sign-in message and a delegation token can carry", () => {
    expect(new Date(MAX_SIWE_EXPIRY_MS).toISOString()).toBe("9999-12-31T23:59:59.000Z");
    expect(new Date(MAX_UCAN_EXPIRY_MS).toISOString()).toBe("2255-06-05T23:47:34.000Z");
  });

  test("the old ten-year policy constant is gone", () => {
    expect("MAX_MS" in EXPIRY).toBe(false);
  });

  test("round-trip through an ISO string without losing the instant", () => {
    expect(Date.parse("9999-12-31T23:59:59Z")).toBe(MAX_SIWE_EXPIRY_MS);
    expect(Date.parse("2255-06-05T23:47:34Z")).toBe(MAX_UCAN_EXPIRY_MS);
  });
});

describe("technicalExpiryRefusal for a sign-in message (siwe)", () => {
  test("accepts the last second of 9999", () => {
    expect(technicalExpiryRefusal(MAX_SIWE_EXPIRY_MS, "siwe")).toBeNull();
    expect(technicalExpiryRefusal(new Date("9999-12-31T23:59:59Z"), "siwe")).toBeNull();
  });

  test("accepts what the old ten-year limit refused", () => {
    const now = Date.now();
    for (const ahead of [10 * YEAR_MS + 24 * 60 * 60 * 1000, 11 * YEAR_MS, 100 * YEAR_MS]) {
      expect(technicalExpiryRefusal(now + ahead, "siwe")).toBeNull();
    }
  });

  test("refuses one second after the last second of 9999 with the dated message", () => {
    expect(technicalExpiryRefusal(MAX_SIWE_EXPIRY_MS + 1000, "siwe")).toBe(SIWE_MESSAGE);
    expect(technicalExpiryRefusal(new Date(Date.UTC(10000, 0, 1)), "siwe")).toBe(SIWE_MESSAGE);
  });

  test("refuses the largest date JavaScript can hold, whose ISO string has a six-digit year", () => {
    expect(new Date(8.64e15).toISOString()).toBe("+275760-09-13T00:00:00.000Z");
    expect(technicalExpiryRefusal(new Date(8.64e15), "siwe")).toBe(SIWE_MESSAGE);
  });

  test("refuses an invalid Date, NaN and Infinity clearly instead of letting toISOString throw", () => {
    const invalid =
      "expiry is not a valid date or is too far away to hold; choose one before 9999-12-31";
    expect(technicalExpiryRefusal(new Date(Number.NaN), "siwe")).toBe(invalid);
    expect(technicalExpiryRefusal(new Date(8.64e15 + 1), "siwe")).toBe(invalid);
    expect(technicalExpiryRefusal(Number.NaN, "siwe")).toBe(invalid);
    expect(technicalExpiryRefusal(Number.POSITIVE_INFINITY, "siwe")).toBe(invalid);
  });
});

describe("technicalExpiryRefusal for a delegation token (ucan)", () => {
  test("accepts the last whole second the token can carry", () => {
    expect(technicalExpiryRefusal(MAX_UCAN_EXPIRY_MS, "ucan")).toBeNull();
    expect(technicalExpiryRefusal(new Date("2255-06-05T23:47:34Z"), "ucan")).toBeNull();
  });

  test("accepts the old ten-year boundary and a hundred years", () => {
    const now = Date.now();
    expect(technicalExpiryRefusal(now + 10 * YEAR_MS + 24 * 60 * 60 * 1000, "ucan")).toBeNull();
    expect(technicalExpiryRefusal(now + 100 * YEAR_MS, "ucan")).toBeNull();
  });

  test("refuses one second later with the dated message that says the session can go further", () => {
    expect(technicalExpiryRefusal(MAX_UCAN_EXPIRY_MS + 1000, "ucan")).toBe(UCAN_MESSAGE);
    expect(technicalExpiryRefusal(new Date("9999-12-31T23:59:59Z"), "ucan")).toBe(UCAN_MESSAGE);
  });

  test("refuses an invalid Date with the ucan date in the advice", () => {
    expect(technicalExpiryRefusal(new Date(Number.NaN), "ucan")).toBe(
      "expiry is not a valid date or is too far away to hold; choose one before 2255-06-05",
    );
  });
});

describe("assertExpiryWithinTechnicalLimit", () => {
  test("returns for an accepted expiry and throws the refusal as an Error", () => {
    expect(() => assertExpiryWithinTechnicalLimit(MAX_SIWE_EXPIRY_MS, "siwe")).not.toThrow();
    expect(() => assertExpiryWithinTechnicalLimit(MAX_UCAN_EXPIRY_MS, "ucan")).not.toThrow();
    expect(() => assertExpiryWithinTechnicalLimit(MAX_SIWE_EXPIRY_MS + 1000, "siwe")).toThrow(SIWE_MESSAGE);
    expect(() => assertExpiryWithinTechnicalLimit(MAX_UCAN_EXPIRY_MS + 1000, "ucan")).toThrow(UCAN_MESSAGE);
    expect(() => assertExpiryWithinTechnicalLimit(new Date(Number.NaN), "siwe")).toThrow(/not a valid date/);
  });

  test("never surfaces a raw RangeError", () => {
    for (const expiry of [new Date(8.64e15 + 1), new Date(Number.NaN), Number.MAX_VALUE, Date.now() + 3.15e18]) {
      let thrown: unknown;
      try {
        assertExpiryWithinTechnicalLimit(expiry, "siwe");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(RangeError);
    }
  });
});
