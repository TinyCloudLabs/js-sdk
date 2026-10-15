import { describe, expect, test } from "bun:test";
import { DEFAULT_GRANT_TTL_MS, MAX_GRANT_TTL_MS } from "./contractConstants";
import {
  clampConsentAnchor,
  consentDeadlineMs,
  effectiveGrantExpiry,
  mintRemainingMs,
  needsSilentRenewal,
} from "./grantPolicy";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CONSENT_WINDOW_MS = 7 * DAY;
const ISSUED_AT = Date.UTC(2025, 0, 1);

/** Non-finite values a caller could pass by mistake (missing field, parse failure, overflow). */
const NON_FINITE: readonly number[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
const MISSING = undefined as unknown as number;

describe("grant policy constants (§6)", () => {
  test("grantTtlMs defaults to 24h and the ceiling is 7d", () => {
    expect(DEFAULT_GRANT_TTL_MS).toBe(DAY);
    expect(MAX_GRANT_TTL_MS).toBe(7 * DAY);
  });
});

describe("clampConsentAnchor (§6 a future-dated anchor cannot extend the window)", () => {
  test("a 365-day future anchor is pulled back to now, so the deadline is now + 7d", () => {
    const now = ISSUED_AT;
    const future = { at: now + 365 * DAY, source: "siwe" as const };
    const clamped = clampConsentAnchor(future, now);
    expect(clamped).toEqual({ at: now, source: "siwe" });
    if (clamped === null) throw new Error("expected a clamped anchor");
    expect(consentDeadlineMs(clamped)).toBe(now + CONSENT_WINDOW_MS);
  });

  test("an anchor at or before now is returned unchanged", () => {
    const past = { at: ISSUED_AT, source: "delegation_iat" as const };
    expect(clampConsentAnchor(past, ISSUED_AT + DAY)).toEqual(past);
    expect(clampConsentAnchor({ at: ISSUED_AT, source: "siwe" }, ISSUED_AT)).toEqual({ at: ISSUED_AT, source: "siwe" });
  });

  test("no anchor stays no anchor", () => {
    expect(clampConsentAnchor(null, ISSUED_AT)).toBeNull();
  });

  test("a non-finite anchor or clock yields no anchor, which means no mint", () => {
    for (const bad of [...NON_FINITE, MISSING]) {
      expect(clampConsentAnchor({ at: bad, source: "siwe" }, ISSUED_AT)).toBeNull();
      expect(clampConsentAnchor({ at: ISSUED_AT, source: "siwe" }, bad)).toBeNull();
    }
  });
});

describe("consentDeadlineMs (§6 deadline = anchor + 7d)", () => {
  test("the deadline is the anchor instant plus the consent window, whatever the anchor source", () => {
    expect(consentDeadlineMs({ at: ISSUED_AT, source: "siwe" })).toBe(ISSUED_AT + CONSENT_WINDOW_MS);
    expect(consentDeadlineMs({ at: ISSUED_AT, source: "first_install" })).toBe(ISSUED_AT + CONSENT_WINDOW_MS);
  });

  test("a non-finite anchor fails closed to -Infinity", () => {
    for (const bad of [...NON_FINITE, MISSING]) {
      expect(consentDeadlineMs({ at: bad, source: "siwe" })).toBe(Number.NEGATIVE_INFINITY);
    }
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

  test("a grantTtlMs above the 7d ceiling is clamped to it", () => {
    const installedAt = ISSUED_AT;
    const farDeadline = installedAt + 365 * DAY;
    expect(
      effectiveGrantExpiry({ signedExpiresAt: null, installedAt, grantTtlMs: 30 * DAY, consentDeadline: farDeadline }),
    ).toBe(installedAt + MAX_GRANT_TTL_MS);
  });

  test("any non-finite installedAt, grantTtlMs, consentDeadline or signed exp fails closed to -Infinity", () => {
    const valid = { signedExpiresAt: ISSUED_AT + DAY, installedAt: ISSUED_AT, grantTtlMs: DAY, consentDeadline: deadline };
    for (const bad of [...NON_FINITE, MISSING]) {
      expect(effectiveGrantExpiry({ ...valid, installedAt: bad })).toBe(Number.NEGATIVE_INFINITY);
      expect(effectiveGrantExpiry({ ...valid, grantTtlMs: bad })).toBe(Number.NEGATIVE_INFINITY);
      expect(effectiveGrantExpiry({ ...valid, consentDeadline: bad })).toBe(Number.NEGATIVE_INFINITY);
      expect(effectiveGrantExpiry({ ...valid, signedExpiresAt: bad })).toBe(Number.NEGATIVE_INFINITY);
    }
  });

  test("undefined signed exp is invalid, not an absent exp", () => {
    expect(
      effectiveGrantExpiry({
        signedExpiresAt: undefined as unknown as null,
        installedAt: ISSUED_AT,
        grantTtlMs: DAY,
        consentDeadline: deadline,
      }),
    ).toBe(Number.NEGATIVE_INFINITY);
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

  test("a grantTtlMs above the 7d ceiling is clamped to it", () => {
    expect(mintRemainingMs({ now: ISSUED_AT, grantTtlMs: 30 * DAY, consentDeadline: ISSUED_AT + 365 * DAY })).toBe(
      MAX_GRANT_TTL_MS,
    );
  });

  test("any non-finite now, grantTtlMs or consentDeadline returns 0, so no mint", () => {
    const valid = { now: ISSUED_AT, grantTtlMs: DAY, consentDeadline: ISSUED_AT + CONSENT_WINDOW_MS };
    for (const bad of [...NON_FINITE, MISSING]) {
      expect(mintRemainingMs({ ...valid, now: bad })).toBe(0);
      expect(mintRemainingMs({ ...valid, grantTtlMs: bad })).toBe(0);
      expect(mintRemainingMs({ ...valid, consentDeadline: bad })).toBe(0);
    }
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

  test("any non-finite now, installedAt, effectiveExpiresAt or consentDeadline returns false", () => {
    const valid = { now: installedAt + 3.5 * HOUR, installedAt, effectiveExpiresAt, consentDeadline };
    for (const bad of [...NON_FINITE, MISSING]) {
      expect(needsSilentRenewal({ ...valid, now: bad })).toBe(false);
      expect(needsSilentRenewal({ ...valid, installedAt: bad })).toBe(false);
      expect(needsSilentRenewal({ ...valid, effectiveExpiresAt: bad })).toBe(false);
      expect(needsSilentRenewal({ ...valid, consentDeadline: bad })).toBe(false);
    }
  });
});
