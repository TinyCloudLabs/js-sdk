import { expect, test } from "bun:test";
import { sessionStateIsUsable, storedSessionState, withoutTrustFields } from "./scoped-login.js";

const profile = { posture: "owner-openkey" as const, authMethod: "openkey" as const };
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const session = (originalEnd: string, leaseEnd?: string) => ({
  siwe: `example.com wants you to sign in\n\nExpiration Time: ${originalEnd}`,
  signature: "0xsigned",
  ...(leaseEnd ? { renewal: { receipt: { leaseAuthorization: "lease", leaseExpiresAt: leaseEnd } } } : {}),
});

test("past its original grant, a session with a live lease is renewed until the lease ends", () => {
  const leaseEnd = at(86_400_000);
  const state = storedSessionState(session(at(-60_000), leaseEnd), profile);
  expect(state).toEqual({ state: "renewed", expiresAt: leaseEnd });
  expect(sessionStateIsUsable(state.state)).toBe(true);
});

test("a live original grant reports its own expiry even with a lease", () => {
  const originalEnd = at(3_600_000);
  expect(storedSessionState(session(originalEnd, at(86_400_000)), profile)).toEqual({ state: "present", expiresAt: originalEnd });
});

test("once the lease has ended too, the session is expired at its original end", () => {
  const originalEnd = at(-120_000);
  const state = storedSessionState(session(originalEnd, at(-60_000)), profile);
  expect(state).toEqual({ state: "expired", expiresAt: originalEnd });
  expect(sessionStateIsUsable(state.state)).toBe(false);
});

test("a lease supplied by an OpenKey callback is not kept as session authority", () => {
  expect(withoutTrustFields({ siwe: "x", renewal: { receipt: {} } })).toEqual({ siwe: "x" });
});
