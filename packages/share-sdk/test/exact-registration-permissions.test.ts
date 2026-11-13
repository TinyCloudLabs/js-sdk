import { expect, test } from "bun:test";
import { planPathBoundShare } from "../src/addressed-content";

test("each share asks to register only its own exact decrypt resource", () => {
  const encryptionNetwork = "urn:tinycloud:encryption:did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:default";
  const first = planPathBoundShare({ shareId: "0123456789abcdef", encryptionNetwork });
  const sibling = planPathBoundShare({ shareId: "fedcba9876543210", encryptionNetwork });
  expect(first.registrationPermissions).toEqual([{ service: "tinycloud.encryption", path: first.keyResource, actions: ["tinycloud.encryption/decrypt"] }]);
  expect(first.registrationPermissions[0]!.path).not.toBe(sibling.keyResource);
  expect(first.registrationPermissions[0]!.path.endsWith("/")).toBe(false);
  expect(first).not.toHaveProperty("requiredPermissions");
});
