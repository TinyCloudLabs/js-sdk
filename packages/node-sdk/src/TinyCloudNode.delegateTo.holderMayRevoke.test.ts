import { afterAll, expect, test } from "bun:test";
import { createHermeticEncryptedNode } from "./test-support/hermetic-encrypted-node";

// TC-3150: `holderMayRevoke` also issues the recipient a revoke-only grant for the delegation, signed by the key that signed it.
const fixture = await createHermeticEncryptedNode();
afterAll(() => fixture.stop());

const claims = (authorization: string): { iss: string; aud: string; exp: number; prf: string[]; att: Record<string, Record<string, unknown[]>> } =>
  JSON.parse(Buffer.from(authorization.replace(/^Bearer /i, "").split(".")[1]!, "base64url").toString());
const audience = () => fixture.delegate.sessionDid.split("#", 1)[0]!;

test("holderMayRevoke returns a revoke grant that names only the new delegation, for its recipient, ending when it ends", async () => {
  const before = fixture.nativeBearerStats().delegations;
  const { delegation, revokeControl } = await fixture.owner.delegateTo(audience(), [...fixture.permissions], { expiry: "1h", holderMayRevoke: true });

  expect(revokeControl).toBeDefined();
  expect(fixture.nativeBearerStats().delegations).toBe(before + 2);
  const granted = claims(delegation.delegationHeader.Authorization);
  const control = claims(revokeControl!.authorization);
  expect(control.att).toEqual({ [`urn:cid:${delegation.cid}`]: { "tinycloud.delegation/revoke": [{}] } });
  // The compact signer writes the issuer as did:key:x#x; the principal is what the node compares.
  expect(control.iss.split("#", 1)[0]).toBe(granted.iss.split("#", 1)[0]);
  expect(control.aud).toBe(audience());
  expect(control.exp).toBe(granted.exp);
  expect(control.prf).toEqual([]);
  expect(revokeControl).toMatchObject({ targetCid: delegation.cid, delegateDID: audience() });
  expect(revokeControl!.expiry.getTime()).toBe(delegation.expiry.getTime());
  expect(revokeControl!.cid).not.toBe(delegation.cid);
});

test("without holderMayRevoke no revoke grant is signed or sent", async () => {
  const before = fixture.nativeBearerStats().delegations;
  const result = await fixture.owner.delegateTo(audience(), [...fixture.permissions], { expiry: "1h" });
  expect(result.revokeControl).toBeUndefined();
  expect(fixture.nativeBearerStats().delegations).toBe(before + 1);
});

test("holderMayRevoke is refused before anything is signed for a wallet-signed delegation and a did:pkh recipient", async () => {
  const before = fixture.nativeBearerStats().delegationAttempts;
  await expect(fixture.owner.delegateTo(audience(), [...fixture.permissions], { forceWalletSign: true, holderMayRevoke: true })).rejects.toThrow("forceWalletSign");
  await expect(fixture.owner.delegateTo(`did:pkh:eip155:1:${"0x".padEnd(42, "1")}`, [...fixture.permissions], { holderMayRevoke: true })).rejects.toThrow("did:key");
  expect(fixture.nativeBearerStats().delegationAttempts).toBe(before);
});

/** Answer the Nth `/delegate` POST (1-based, from now) with `status`; the others reach the node. */
function failDelegateNumber(n: number, status: number, body: string): () => void {
  const real = globalThis.fetch;
  let seen = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.endsWith("/delegate") && (init?.method ?? "GET") === "POST" && ++seen === n) return new Response(body, { status });
    return real(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

test("a node that refuses the revoke grant with 401 marks the error revokeControlRefused and hands back the live delegation", async () => {
  const restore = failDelegateNumber(2, 401, "Cannot find parent delegation");
  try {
    const failure = await fixture.owner.delegateTo(audience(), [...fixture.permissions], { expiry: "1h", holderMayRevoke: true })
      .then(() => undefined, (error: unknown) => error as { revokeControlRefused?: boolean; delegation?: { cid: string } });
    expect(failure?.revokeControlRefused).toBe(true);
    expect(typeof failure?.delegation?.cid).toBe("string");
  } finally {
    restore();
  }
});

test("any other answer to the revoke grant (500) leaves the error unmarked", async () => {
  const restore = failDelegateNumber(2, 500, "boom");
  try {
    const failure = await fixture.owner.delegateTo(audience(), [...fixture.permissions], { expiry: "1h", holderMayRevoke: true })
      .then(() => undefined, (error: unknown) => error as { revokeControlRefused?: boolean; delegation?: { cid: string } });
    expect(failure?.revokeControlRefused).toBeUndefined();
    expect(typeof failure?.delegation?.cid).toBe("string");
  } finally {
    restore();
  }
});
