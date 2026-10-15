import { describe, expect, test } from "bun:test";
import { DEFAULT_GRANT_TTL_MS, MAX_GRANT_TTL_MS } from "./contractConstants";
import { consentDeadlineMs, effectiveGrantExpiry, mintRemainingMs, needsSilentRenewal } from "./grantPolicy";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CONSENT_WINDOW_MS = 7 * DAY;
const ISSUED_AT = Date.UTC(2025, 0, 1);

describe("grant policy constants (§6)", () => {
  test("grantTtlMs defaults to 24h and the ceiling is 7d", () => {
    expect(DEFAULT_GRANT_TTL_MS).toBe(DAY);
    expect(MAX_GRANT_TTL_MS).toBe(7 * DAY);
  });
});

describe("consentDeadlineMs (§6 deadline = anchor + 7d)", () => {
  test("the deadline is the anchor instant plus the consent window, whatever the anchor source", () => {
    expect(consentDeadlineMs({ at: ISSUED_AT, source: "siwe" })).toBe(ISSUED_AT + CONSENT_WINDOW_MS);
    expect(consentDeadlineMs({ at: ISSUED_AT, source: "first_install" })).toBe(ISSUED_AT + CONSENT_WINDOW_MS);
  });
});

describe("effectiveGrantExpiry (§6 min of three bounds)", () => {
  const deadline = ISSUED_AT + CONSENT_WINDOW_MS;

  test("the local effective expiry is install + grantTtl when that is the earliest bound", () => {
    const installedAt = ISSUED_AT + DAY;
    expect(
      effectiveGrantExpiry({ signedExpiresAt: installedAt + 30 * DAY, installedAt, grantTtlMs: DAY, consentDeadline: deadline }),
    ).toBe(installedAt + DAY);
  });

  test("a signed exp shorter than the TTL bound wins", () => {
    const installedAt = ISSUED_AT;
    expect(
      effectiveGrantExpiry({ signedExpiresAt: installedAt + HOUR, installedAt, grantTtlMs: DAY, consentDeadline: deadline }),
    ).toBe(installedAt + HOUR);
  });

  test("the consent deadline caps the grant even when the TTL is later", () => {
    const installedAt = deadline - HOUR;
    expect(
      effectiveGrantExpiry({ signedExpiresAt: installedAt + 30 * DAY, installedAt, grantTtlMs: DAY, consentDeadline: deadline }),
    ).toBe(deadline);
  });

  test("a null signed exp leaves the TTL and deadline bounds in charge", () => {
    const installedAt = ISSUED_AT;
    expect(effectiveGrantExpiry({ signedExpiresAt: null, installedAt, grantTtlMs: DAY, consentDeadline: deadline })).toBe(
      installedAt + DAY,
    );
  });

  test("a later signed exp is never the local expiry", () => {
    const installedAt = ISSUED_AT;
    const signedExpiresAt = installedAt + 30 * DAY;
    const local = effectiveGrantExpiry({ signedExpiresAt, installedAt, grantTtlMs: HOUR, consentDeadline: deadline });
    expect(local).toBe(installedAt + HOUR);
    expect(local).toBeLessThan(signedExpiresAt);
  });
});

describe("mintRemainingMs (§6 fresh mint duration)", () => {
  test("remaining is min(grantTtlMs, deadline - now)", () => {
    const now = ISSUED_AT + DAY;
    expect(mintRemainingMs({ now, grantTtlMs: DAY, consentDeadline: ISSUED_AT + CONSENT_WINDOW_MS })).toBe(DAY);
    expect(mintRemainingMs({ now, grantTtlMs: 3 * DAY, consentDeadline: now + 2 * HOUR })).toBe(2 * HOUR);
  });

  test("returns a value <= 0 at or after the deadline so no mint happens", () => {
    const deadline = ISSUED_AT + CONSENT_WINDOW_MS;
    expect(mintRemainingMs({ now: deadline, grantTtlMs: DAY, consentDeadline: deadline })).toBeLessThanOrEqual(0);
    expect(mintRemainingMs({ now: deadline + 1, grantTtlMs: DAY, consentDeadline: deadline })).toBeLessThanOrEqual(0);
  });
});

describe("needsSilentRenewal (§6 renewal at <25% remaining, before the deadline)", () => {
  const installedAt = ISSUED_AT;
  const effectiveExpiresAt = installedAt + 4 * HOUR;
  const consentDeadline = ISSUED_AT + CONSENT_WINDOW_MS;

  test("renews once less than 25% of the effective lifetime remains", () => {
    expect(needsSilentRenewal({ now: installedAt + 2 * HOUR, installedAt, effectiveExpiresAt, consentDeadline })).toBe(false);
    expect(needsSilentRenewal({ now: installedAt + 3 * HOUR + 1, installedAt, effectiveExpiresAt, consentDeadline })).toBe(true);
  });

  test("never renews at or after the consent deadline", () => {
    const deadline = installedAt + 3 * HOUR;
    expect(
      needsSilentRenewal({ now: deadline, installedAt, effectiveExpiresAt, consentDeadline: deadline }),
    ).toBe(false);
  });
});
