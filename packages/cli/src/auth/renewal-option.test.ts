import { expect, test } from "bun:test";
import { parseRenewLifetimeSeconds, renewalLine } from "./renewal-option.js";
import { approvalPendingOf } from "../output/errors.js";

test.each([["90d", 90 * 86_400], ["26w", 26 * 7 * 86_400], ["1y", 365 * 86_400], ["12h", 12 * 3600], ["365d", 365 * 86_400]])(
  "%s is %i seconds", (value, seconds) => { expect(parseRenewLifetimeSeconds(value)).toBe(seconds); });

test.each(["366d", "2y", "53w", "0d", "-1d", "1.5d", "90", "d", "90 d", "1y2d", "", "999999d", "90D"])(
  "%p is refused", (value) => { expect(() => parseRenewLifetimeSeconds(value)).toThrow(/Invalid --renew/); });

test("the link line states the longest renewal the request asks for", () => {
  expect(renewalLine(90 * 86_400)).toContain("up to 90 days");
  expect(renewalLine(86_400)).toContain("up to 1 day.");
  expect(renewalLine(12 * 3600)).toContain("up to 12 hours");
});

test("a pending approval carries the asked renewal only when it is a positive whole number", () => {
  const base = { step: 1, of: 1, approvalUrl: "https://openkey.example/a/x", expiresAt: "2026-11-16T05:00:00.000Z" };
  const parsed = (renewalLeaseSeconds: unknown) => approvalPendingOf({ code: "APPROVAL_PENDING", metadata: { pending: { ...base, renewalLeaseSeconds } } });
  expect(parsed(90 * 86_400)).toEqual({ ...base, renewalLeaseSeconds: 90 * 86_400 });
  for (const bad of [0, -1, 1.5, "90d", null]) expect(parsed(bad)).toEqual(base);
  expect(approvalPendingOf({ code: "APPROVAL_PENDING", metadata: { pending: base } })).toEqual(base);
});
