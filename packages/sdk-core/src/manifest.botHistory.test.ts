import { expect, test } from "bun:test";
import { expandPermissionEntry } from "./manifest";

const owner = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const network = `urn:tinycloud:encryption:${owner}:default`;
const scope = "secrets/scoped/tinychat-bot-history";
const key = `${network}/${scope}/bot-history`;
const permissions = (path: string, actions = ["decrypt", "key.create"]) =>
  expandPermissionEntry({ service: "tinycloud.encryption", path, actions });

test("the bot-history key grants just decrypt and create on that exact key", () => {
  expect(permissions(key.replace(owner, owner.toLowerCase()))).toEqual([expect.objectContaining({
    path: key,
    actions: ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"],
  })]);
});

test.each([
  `${network}/${scope}/`, `${network}/${scope}/other`, `${network}/secrets/scoped/other/bot-history`,
  `urn:tinycloud:encryption:${owner}:other/${scope}/bot-history`,
])("refuses a bot-history grant outside the reserved key: %s", (path) => {
  expect(() => permissions(path)).toThrow();
});

test.each(["key.block", "key.delete", "network.create"])("does not grant %s on bot history", (action) => {
  expect(() => permissions(key, [action])).toThrow();
});
