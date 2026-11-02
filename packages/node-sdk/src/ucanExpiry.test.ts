import { describe, expect, test } from "bun:test";

import { MAX_UCAN_EXPIRY_MS, assertUcanExpiryWithinLimit, ucanExpiryRefusal } from "./ucanExpiry";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const UCAN_MESSAGE =
  "expiry is not a valid date or is later than 2255-06-05, the latest date an agent or share delegation can carry (UCAN limit); the session itself can be signed to 9999-12-31; choose an earlier expiry";
const NOT_A_DATE = "expiry is not a valid date or is later than 2255-06-05, the latest date an agent or share delegation can carry (UCAN limit); the session itself can be signed to 9999-12-31; choose an earlier expiry";

describe("the technical limit of a token signed by the session key", () => {
  test("is the latest whole second the WASM token builder can carry", () => {
    expect(new Date(MAX_UCAN_EXPIRY_MS).toISOString()).toBe("2255-06-05T23:47:34.000Z");
    expect(Date.parse("2255-06-05T23:47:34Z")).toBe(MAX_UCAN_EXPIRY_MS);
  });

  test("accepts that second, ten years and a day, and a hundred years", () => {
    const now = Date.now();
    expect(ucanExpiryRefusal(MAX_UCAN_EXPIRY_MS)).toBeNull();
    expect(ucanExpiryRefusal(new Date("2255-06-05T23:47:34Z"))).toBeNull();
    expect(ucanExpiryRefusal(now + 10 * YEAR_MS + 24 * 60 * 60 * 1000)).toBeNull();
    expect(ucanExpiryRefusal(now + 100 * YEAR_MS)).toBeNull();
  });

  test("refuses one second later with the dated message that says the session can go further", () => {
    expect(ucanExpiryRefusal(MAX_UCAN_EXPIRY_MS + 1000)).toBe(UCAN_MESSAGE);
    expect(ucanExpiryRefusal(new Date("9999-12-31T23:59:59Z"))).toBe(UCAN_MESSAGE);
  });

  test("refuses an invalid Date, NaN and Infinity with the 2255 date in the advice", () => {
    for (const bad of [new Date(Number.NaN), Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(ucanExpiryRefusal(bad)).toBe(NOT_A_DATE);
    }
  });

  test("assertUcanExpiryWithinLimit throws the refusal as an Error and returns otherwise", () => {
    expect(() => assertUcanExpiryWithinLimit(MAX_UCAN_EXPIRY_MS)).not.toThrow();
    expect(() => assertUcanExpiryWithinLimit(MAX_UCAN_EXPIRY_MS + 1000)).toThrow(UCAN_MESSAGE);
    const refusal = (() => {
      try {
        assertUcanExpiryWithinLimit(new Date(Number.NaN));
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(RangeError);
  });
});
