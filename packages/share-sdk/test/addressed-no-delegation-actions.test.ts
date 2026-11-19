import { describe, expect, it } from "bun:test";
import { prepareAddressedShare } from "../src/index.js";

// TC-3286: an addressed share never grants a `tinycloud.delegation` action, so a recipient can't revoke
// (or create, list or renew) delegations with it. This check runs before any upload or registry write.
describe("addressed shares refuse delegation actions", () => {
  const targets = [
    { kind: "recipientDid", did: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111" },
    { kind: "emailDomain", domain: "tinycloud.xyz" },
  ] as const;
  for (const target of targets) {
    for (const action of ["tinycloud.delegation/revoke", "tinycloud.delegation/*"]) {
      it(`${target.kind} with ${action}, alone or beside read`, () => {
        for (const policyActions of [[action], ["tinycloud.kv/get", action]]) {
          expect(() => prepareAddressedShare({ target, actions: ["read"], policyActions, filename: "readme.md" }))
            .toThrow("addressed share action is not supported");
        }
      });
    }
  }
});
