import { describe, expect, test } from "bun:test";

import {
  delegationGroup,
  EXPIRING_SOON_MS,
  isExpiringSoon,
  shortDid,
} from "../../src/ui/data/map";

const SESSION = "did:key:session";

describe("delegationGroup", () => {
  test("granted to the session's own DID is this-app", () => {
    expect(delegationGroup({ direction: "granted", delegateDid: SESSION }, SESSION)).toBe("this-app");
  });

  test("granted to another DID is to-others", () => {
    expect(delegationGroup({ direction: "granted", delegateDid: "did:key:other" }, SESSION)).toBe(
      "to-others",
    );
  });

  test("received is always received, even when delegate is the session", () => {
    expect(delegationGroup({ direction: "received", delegateDid: SESSION }, SESSION)).toBe("received");
  });
});

describe("isExpiringSoon", () => {
  const now = Date.UTC(2025, 0, 1);

  test("null expiry never expires soon", () => {
    expect(isExpiringSoon(null, now)).toBe(false);
  });

  test("expiry exactly 24h away counts as expiring soon", () => {
    expect(isExpiringSoon(new Date(now + EXPIRING_SOON_MS), now)).toBe(true);
  });

  test("expiry just beyond 24h does not", () => {
    expect(isExpiringSoon(new Date(now + EXPIRING_SOON_MS + 1), now)).toBe(false);
  });

  test("already expired is not expiring soon", () => {
    expect(isExpiringSoon(new Date(now - 1), now)).toBe(false);
  });
});

describe("shortDid", () => {
  test("keeps short DIDs whole", () => {
    expect(shortDid("did:key:abc")).toBe("did:key:abc");
  });

  test("elides long DIDs to prefix and suffix", () => {
    const did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
    expect(shortDid(did)).toBe(`${did.slice(0, 14)}…${did.slice(-6)}`);
  });
});
