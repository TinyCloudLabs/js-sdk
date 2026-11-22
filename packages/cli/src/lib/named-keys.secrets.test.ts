import { expect, test } from "bun:test";
import { parseKeysPrefix } from "./named-keys.js";

const OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

test.each([["secrets"], ["secrets/"], ["secrets/api_key"], ["secrets/scoped/prod"]])(
  "--keys %p is refused: per-secret keys are not a --keys folder",
  (input) => {
    expect(() => parseKeysPrefix(input, OWNER)).toThrow(expect.objectContaining({ code: "INVALID_KEY_PREFIX", exitCode: 2 }));
  },
);

test("a folder that only starts with the letters `secrets` stays usable", () => {
  expect(parseKeysPrefix("secretsauce", OWNER).resource).toBe(`urn:tinycloud:encryption:${OWNER}:default/secretsauce/`);
});
