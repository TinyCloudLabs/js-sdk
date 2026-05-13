import { describe, expect, test } from "bun:test";
import { DEFAULT_SIGNED_READ_URL_EXPIRY_MS, EXPIRY } from "./expiry";

describe("EXPIRY", () => {
  test("exposes the signed read URL default from the core expiry tier", () => {
    expect(EXPIRY.SIGNED_READ_URL_MS).toBe(5 * 60 * 1000);
    expect(DEFAULT_SIGNED_READ_URL_EXPIRY_MS).toBe(EXPIRY.SIGNED_READ_URL_MS);
  });
});
