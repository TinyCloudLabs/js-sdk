import { describe, expect, test } from "bun:test";

import {
  bareDid,
  delegationGroup,
  EXPIRING_SOON_MS,
  isExpiringSoon,
  sameDid,
  shortDid,
  toDelegationRow,
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

// tc.sessionDid is a DID URL with the session key as its fragment; the node lists the delegate DID bare.
describe("session DID with a fragment", () => {
  const KEY = "z6MkuQaSpsJFaVPB7x58XfS6iTPBM67kZVD5REmRi2UcLDQQ";
  const BARE = `did:key:${KEY}`;
  const URL_FORM = `${BARE}#${KEY}`;

  test("a bare delegate DID equals the session DID URL: this-app", () => {
    expect(delegationGroup({ direction: "granted", delegateDid: BARE }, URL_FORM)).toBe("this-app");
  });

  test("a fragment on the delegate side equals a bare session DID too", () => {
    expect(delegationGroup({ direction: "granted", delegateDid: URL_FORM }, BARE)).toBe("this-app");
  });

  test("received stays received when its delegate is this session", () => {
    expect(delegationGroup({ direction: "received", delegateDid: BARE }, URL_FORM)).toBe("received");
  });

  test("another DID stays to-others", () => {
    expect(delegationGroup({ direction: "granted", delegateDid: "did:key:z6MkOther" }, URL_FORM)).toBe(
      "to-others",
    );
  });

  test("two different keys with the same fragment text are not the same DID", () => {
    expect(sameDid("did:key:z6MkAAA#shared", "did:key:z6MkBBB#shared")).toBe(false);
    expect(delegationGroup({ direction: "granted", delegateDid: "did:key:z6MkBBB#shared" }, "did:key:z6MkAAA#shared")).toBe(
      "to-others",
    );
  });

  test("a fragment that merely spells another DID does not make them equal", () => {
    expect(sameDid("did:key:z6MkAAA#did:key:z6MkBBB", "did:key:z6MkBBB")).toBe(false);
    expect(sameDid("did:key:z6MkAAA#z6MkBBB", "did:key:z6MkBBB")).toBe(false);
  });

  test("only a single trailing fragment is dropped; a string with two # is compared as it is", () => {
    expect(bareDid(URL_FORM)).toBe(BARE);
    expect(bareDid(BARE)).toBe(BARE);
    expect(bareDid("did:key:z6Mk#a#b")).toBe("did:key:z6Mk#a#b");
    expect(sameDid("did:key:z6Mk#a#b", "did:key:z6Mk")).toBe(false);
    expect(sameDid("did:key:z6Mk#a#b", "did:key:z6Mk#a#b")).toBe(true);
  });

  test("the mapper groups the app's own session grant as this-app and keeps the node's DIDs untouched", () => {
    const now = Date.UTC(2026, 0, 1);
    const own = toDelegationRow(
      {
        cid: "bafyOwn",
        direction: "granted",
        delegatorDid: "did:pkh:eip155:1:0x00000000000000000000000000000000000c41d0",
        delegateDid: BARE,
        resources: [{ resource: "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000c41d0:default/kv/notes/", actions: ["tinycloud.kv/get"], caveats: [] }],
        parents: [],
        issuedAt: new Date(now - 3_600_000),
        notBefore: null,
        expiresAt: new Date(now + 86_400_000 * 7),
        status: "active",
      },
      URL_FORM,
      now,
    );
    expect(own.group).toBe("this-app");
    expect(own.delegateDid).toBe(BARE);
  });
});
