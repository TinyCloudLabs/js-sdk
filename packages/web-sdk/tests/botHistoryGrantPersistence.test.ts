import { expect, test } from "bun:test";
import { isSecretKeyResourceSet } from "../src/modules/runtimeGrantPersistence";

const owner = { address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", chainId: 1 };
const network = `urn:tinycloud:encryption:did:pkh:eip155:1:${owner.address}:default`;
const prefix = `${network}/secrets/scoped/tinychat-bot-history/`;
const exact = { service: "tinycloud.encryption", space: "encryption", path: `${prefix}bot-history`,
  actions: ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"] };

test("the bot-history grant persists without persisting wider authority", () => {
  expect(isSecretKeyResourceSet([exact], owner)).toBe(true);
  for (const path of [network, prefix, `${prefix}other`, `${network}/secrets/ordinary`]) {
    expect(isSecretKeyResourceSet([exact, { ...exact, path }], owner)).toBe(false);
  }
  expect(isSecretKeyResourceSet([{ ...exact, actions: ["tinycloud.encryption/key.block"] }], owner)).toBe(false);
  expect(isSecretKeyResourceSet([exact], { ...owner, chainId: 2 })).toBe(false);
});
