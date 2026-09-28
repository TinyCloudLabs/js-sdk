import { describe, expect, test } from "bun:test";
import { DEFAULT_SIGNED_READ_URL_EXPIRY_MS, EXPIRY } from "./expiry";

describe("EXPIRY", () => {
  test("exposes the signed read URL default from the core expiry tier", () => {
    expect(EXPIRY.SIGNED_READ_URL_MS).toBe(5 * 60 * 1000);
    expect(DEFAULT_SIGNED_READ_URL_EXPIRY_MS).toBe(EXPIRY.SIGNED_READ_URL_MS);
  });

  test("defaults sign-in sessions to 30 days", () => {
    expect(EXPIRY.SESSION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("keeps share links on the 7 day tier", () => {
    expect(EXPIRY.SHARE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
