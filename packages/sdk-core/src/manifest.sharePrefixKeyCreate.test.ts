/*
 * TC-2242. A static manifest entry on the DEFAULT network's `share/` prefix may carry `key.create` alongside `decrypt`, so an owner
 * signs in once with the capability to create the per-share keys (`<network>/share/<shareId>`) the node's key-admin invocation names.
 * Nothing else widens: key.create stays refused on a whole network, on any other prefix, on an exact key (the runtime route), on a
 * non-default network and on a lower-cased (non-EIP-55) owner address; no other action is accepted on the share prefix.
 */
import { describe, expect, it } from "bun:test";

import {
  ENCRYPTION_MANIFEST_SPACE,
  ENCRYPTION_PERMISSION_SERVICE,
  ManifestValidationError,
  expandPermissionEntries,
  expandRuntimePermissionEntries,
  type PermissionEntry,
} from "./manifest";

const OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const PREFIX = `${NETWORK}/share/`;
const CREATE = "tinycloud.encryption/key.create";
const DECRYPT = "tinycloud.encryption/decrypt";

const entry = (path: string, actions: string[]): PermissionEntry => ({ service: ENCRYPTION_PERMISSION_SERVICE, path, actions });
const expanded = (path: string, actions: string[]) => expandPermissionEntries([entry(path, actions)]);
const exact = (actions: string[]) => [{ service: ENCRYPTION_PERMISSION_SERVICE, space: ENCRYPTION_MANIFEST_SPACE, path: PREFIX, actions, skipPrefix: true }];

describe("key.create on the default network's share prefix (static manifest)", () => {
  it("accepts decrypt and key.create in one entry, in both spellings, normalized to full ability URNs in order", () => {
    expect(expanded(PREFIX, ["decrypt", "key.create"])).toEqual(exact([DECRYPT, CREATE]));
    expect(expanded(PREFIX, [DECRYPT, CREATE])).toEqual(exact([DECRYPT, CREATE]));
    expect(expanded(PREFIX, ["key.create", "decrypt"])).toEqual(exact([CREATE, DECRYPT]));
  });

  it("accepts key.create on its own and as two entries, and dedupes the two spellings of one action", () => {
    expect(expanded(PREFIX, ["key.create"])).toEqual(exact([CREATE]));
    expect(expandPermissionEntries([entry(PREFIX, ["decrypt"]), entry(PREFIX, ["key.create"])])).toEqual([...exact([DECRYPT]), ...exact([CREATE])]);
    expect(expanded(PREFIX, ["key.create", CREATE, "decrypt", DECRYPT])).toEqual(exact([CREATE, DECRYPT]));
  });

  it("keeps decrypt on the share prefix as it was", () => {
    expect(expanded(PREFIX, ["decrypt"])).toEqual(exact([DECRYPT]));
  });

  const refused: [string, string, string[]][] = [
    ["key.create on the whole network", NETWORK, ["key.create"]],
    ["decrypt + key.create on the whole network", NETWORK, ["decrypt", "key.create"]],
    ["key.create on an exact share key (that is the runtime route)", `${NETWORK}/share/abc`, ["key.create"]],
    ["key.create on another prefix", `${NETWORK}/other/`, ["key.create"]],
    ["key.create on an apps prefix", `${NETWORK}/apps/app/`, ["key.create"]],
    ["key.create on a nested share prefix", `${NETWORK}/share/a/`, ["key.create"]],
    ["key.create on a non-default network's share prefix", `${NETWORK.replace(":default", ":other")}/share/`, ["key.create"]],
    ["key.create on a lower-cased (non-EIP-55) owner address", `${NETWORK.toLowerCase()}/share/`, ["key.create"]],
    ["decrypt + key.create on a lower-cased owner address", `${NETWORK.toLowerCase()}/share/`, ["decrypt", "key.create"]],
    ["key.create on a wrong mixed-case (not EIP-55) owner address", PREFIX.replace("0x5aAeb", "0x5AAeb"), ["key.create"]],
    ["key.create on a 0X-prefixed owner address", PREFIX.replace(":0x", ":0X"), ["key.create"]],
    ["key.create on a chain id with a leading zero", PREFIX.replace("eip155:1:", "eip155:01:"), ["key.create"]],
    ["key.create on a 41-hex owner address", PREFIX.replace("BeAed", "BeAed0"), ["key.create"]],
    ["key.create on an extra :default segment", `${NETWORK}:default/share/`, ["key.create"]],
    ["key.create on a malformed owner DID", "urn:tinycloud:encryption:did:pkh:eip155:1:notanaddress:default/share/", ["key.create"]],
    ["network.create on the share prefix", PREFIX, ["network.create"]],
    ["key.create with network.revoke on the share prefix", PREFIX, ["key.create", "network.revoke"]],
    ["key.delete on the share prefix", PREFIX, ["key.delete"]],
    ["key.block on the share prefix", PREFIX, ["key.block"]],
    ["an unknown action on the share prefix", PREFIX, ["key.create", "unknown"]],
    ["a wildcard action on the share prefix", PREFIX, ["*"]],
  ];
  for (const [name, path, actions] of refused) {
    it(`refuses ${name}`, () => {
      expect(() => expanded(path, actions)).toThrow(ManifestValidationError);
    });
  }

  it("still accepts decrypt on a lower-cased prefix as before (only key.create requires the checksummed address)", () => {
    expect(() => expanded(`${NETWORK.toLowerCase()}/share/`, ["decrypt"])).not.toThrow();
  });

  it("still refuses key.create on a whole network with the existing unknown-action error", () => {
    expect(() => expanded(NETWORK, ["key.create"])).toThrow(/unknown encryption action/);
  });

  it("keeps the runtime route exact-key only: a runtime request for key.create on the share prefix is refused", () => {
    expect(() => expandRuntimePermissionEntries([entry(PREFIX, ["tinycloud.encryption/key.create"])], OWNER)).toThrow(ManifestValidationError);
    expect(() => expandRuntimePermissionEntries([entry(PREFIX, ["key.create", "decrypt"])], OWNER)).toThrow(ManifestValidationError);
    expect(expandRuntimePermissionEntries([entry(PREFIX, ["decrypt"])], OWNER)).toEqual(exact([DECRYPT]));
    expect(expandRuntimePermissionEntries([entry(`${NETWORK}/share/abc`, ["tinycloud.encryption/key.create"])], OWNER)).toHaveLength(1);
  });
});
