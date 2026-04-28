import { describe, expect, test } from "bun:test";

import type { TinyCloudSession } from "@tinycloud/sdk-core";
import { DelegatedAccess, type RestorableSession } from "./DelegatedAccess";
import type { PortableDelegation } from "./delegation";

function makeSession(): TinyCloudSession {
  return {
    address: "0x1204f2e9f634B5A8c09CA1579d351B99B27faE50",
    chainId: 1,
    sessionKey: "cli",
    spaceId: "space:test",
    delegationCid: "bafyreitest-activation-cid",
    delegationHeader: { Authorization: "ucan:session-bound-header" },
    verificationMethod: "did:key:z6Mkk9-session#z6Mkk9",
    jwk: { kty: "OKP", crv: "Ed25519", x: "test-pub" },
    siwe: "",
    signature: "",
  };
}

function makeDelegation(): PortableDelegation {
  return {
    cid: "bafyreitest-delegation-cid",
    spaceId: "space:test",
    chainId: 1,
    path: "",
    actions: ["tinycloud.kv/get"],
    expiry: new Date(Date.now() + 24 * 3600 * 1000),
    ownerAddress: "0xAAAaAaaAaaAaaAaAAaAaAaaAaAAaAAaAAaAaaAaa",
    notBefore: new Date(),
    delegateDID: "did:pkh:eip155:1:0xAGENT",
  } as unknown as PortableDelegation;
}

describe("DelegatedAccess.restorable", () => {
  const invoke = (() => {
    throw new Error("invoke should not be called in this test");
  }) as any;

  test("projects session handles in the shape restoreSession consumes", () => {
    const session = makeSession();
    const access = new DelegatedAccess(session, makeDelegation(), "https://node.test", invoke);

    const restorable: RestorableSession = access.restorable;

    expect(restorable).toEqual({
      delegationHeader: { Authorization: "ucan:session-bound-header" },
      delegationCid: "bafyreitest-activation-cid",
      spaceId: "space:test",
      jwk: { kty: "OKP", crv: "Ed25519", x: "test-pub" },
      verificationMethod: "did:key:z6Mkk9-session#z6Mkk9",
      address: "0x1204f2e9f634B5A8c09CA1579d351B99B27faE50",
      chainId: 1,
    });
  });

  test("delegationCid is the session's activation cid, not the portable delegation's cid", () => {
    // In wallet mode, useDelegation mints a new delegationCid bound to the
    // activator's session key. Restoring must use that, not the portable
    // delegation's own cid, or the server rejects the session.
    const session = makeSession();
    const delegation = makeDelegation();
    const access = new DelegatedAccess(session, delegation, "https://node.test", invoke);

    expect(access.restorable.delegationCid).toBe(session.delegationCid);
    expect(access.restorable.delegationCid).not.toBe(delegation.cid);
  });

  test("returns a fresh object each read (caller can mutate without side effects)", () => {
    const session = makeSession();
    const access = new DelegatedAccess(session, makeDelegation(), "https://node.test", invoke);

    const first = access.restorable;
    const second = access.restorable;

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
