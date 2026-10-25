import { describe, expect, test } from "bun:test";
import { keyAbilitiesFor, parseKeysPrefix } from "./named-keys.js";

const OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

describe("parseKeysPrefix", () => {
  test("qa and qa/ give the same grant", () => {
    const bare = parseKeysPrefix("qa", OWNER);
    const slash = parseKeysPrefix("qa/", OWNER);
    expect(bare).toEqual(slash);
    expect(bare.resource).toBe(`urn:tinycloud:encryption:${OWNER}:default/qa/`);
    expect(keyAbilitiesFor(bare)).toEqual({
      [bare.resource]: ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"],
    });
  });

  test.each([
    ["/qa"],
    ["qa//x"],
    ["QA"],
    ["apps"],
    ["apps/x"],
    [""],
  ])("%p is refused as a usage error (exit 2)", (input) => {
    let thrown: unknown;
    try {
      parseKeysPrefix(input, OWNER);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "INVALID_KEY_PREFIX", exitCode: 2 });
  });
});
