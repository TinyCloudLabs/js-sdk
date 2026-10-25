import { describe, expect, test } from "bun:test";
import { keyAbilitiesFor, namedKeysGrantIn, parseKeysPrefix, withVerifiedNamedKeys } from "./named-keys.js";

const OWNER = "did:pkh:eip155:1:0xf0637362cc9723AaB6Db526a46772E4473097f2C";

/** A ReCap resource in the SIWE form consumed by the profile grant guard. */
function preparedSiwe(withKeys: boolean) {
  const keys = parseKeysPrefix("qa", OWNER);
  const abilities = keyAbilitiesFor(keys)[keys.resource]!;
  const att = withKeys ? { [keys.resource]: Object.fromEntries(abilities.map((ability) => [ability, [{}]])) } : {};
  const recap = Buffer.from(JSON.stringify({ att })).toString("base64url");
  return { siwe: `Resources:\n- urn:recap:${recap}`, keys };
}

describe("withVerifiedNamedKeys", () => {
  test("keeps the folder only when the session's signed ReCap carries both abilities", async () => {
    const withKeys = preparedSiwe(true);
    const without = preparedSiwe(false);
    const profile = { name: "p", namedKeys: withKeys.keys };
    expect(namedKeysGrantIn(withKeys.siwe, withKeys.keys)).toBe("both");
    expect(namedKeysGrantIn(without.siwe, withKeys.keys)).toBe("none");
    expect(withVerifiedNamedKeys(profile, { siwe: withKeys.siwe }).namedKeys).toEqual(withKeys.keys);
    expect(withVerifiedNamedKeys(profile, { siwe: without.siwe }).namedKeys).toBeUndefined();
    expect(withVerifiedNamedKeys(profile, { delegationCid: "no-siwe" }).namedKeys).toBeUndefined();
    expect(withVerifiedNamedKeys<{ name: string; namedKeys?: typeof withKeys.keys }>({ name: "p" }, { siwe: without.siwe })).toEqual({ name: "p" });
  });
});
