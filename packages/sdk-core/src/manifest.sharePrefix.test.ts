/*
 * A static manifest entry on the DEFAULT network's `share/` prefix carries `decrypt` only (the node registers a share policy only for an owner
 * holding it). Share keys are not created by the client, so `key.create` is not a share-prefix action, and no other action is accepted there.
 */
import { describe, expect, it } from "bun:test";

import {
  ENCRYPTION_MANIFEST_SPACE,
  ENCRYPTION_PERMISSION_SERVICE,
  ManifestValidationError,
  expandPermissionEntries,
  type PermissionEntry,
} from "./manifest";

const OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const PREFIX = `${NETWORK}/share/`;
const DECRYPT = "tinycloud.encryption/decrypt";

const entry = (path: string, actions: string[]): PermissionEntry => ({ service: ENCRYPTION_PERMISSION_SERVICE, path, actions });
const expanded = (path: string, actions: string[]) => expandPermissionEntries([entry(path, actions)]);
const exact = (path: string, actions: string[]) => [{ service: ENCRYPTION_PERMISSION_SERVICE, space: ENCRYPTION_MANIFEST_SPACE, path, actions, skipPrefix: true }];

describe("the default network's share prefix (static manifest)", () => {
  it("expands decrypt in both spellings to one full ability URN", () => {
    expect(expanded(PREFIX, ["decrypt"])).toEqual(exact(PREFIX, [DECRYPT]));
    expect(expanded(PREFIX, ["decrypt", DECRYPT])).toEqual(exact(PREFIX, [DECRYPT]));
    const lower = `${NETWORK.toLowerCase()}/share/`;
    expect(expanded(lower, ["decrypt"])).toEqual(exact(lower, [DECRYPT]));
  });

  const refused: [string, string, string[]][] = [
    ["key.create", PREFIX, ["key.create"]],
    ["the full key.create ability", PREFIX, ["tinycloud.encryption/key.create"]],
    ["decrypt + key.create", PREFIX, ["decrypt", "key.create"]],
    ["network.create", PREFIX, ["network.create"]],
    ["key.delete", PREFIX, ["key.delete"]],
    ["key.block", PREFIX, ["key.block"]],
    ["a wildcard action", PREFIX, ["*"]],
    ["decrypt on a non-default network's share prefix", `${NETWORK.replace(":default", ":other")}/share/`, ["decrypt"]],
    ["decrypt on a nested share prefix", `${NETWORK}/share/a/`, ["decrypt"]],
  ];
  for (const [name, path, actions] of refused) {
    it(`refuses ${name}`, () => {
      expect(() => expanded(path, actions)).toThrow(ManifestValidationError);
    });
  }
});
