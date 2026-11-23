import { describe, expect, test } from "bun:test";

import { evaluateOperationAuthority } from "./authority.js";
import type { RuntimeOperationContext } from "./contract.js";
import { secretsGetOperationDefinition } from "./operations/secrets-get.js";

// A signed session reports a grant with no limits as `caveats: []` (the verified ReCap path) or `[{}]`, not as no
// `caveats` at all. A scoped login's exact-key decrypt must still stand in for the network decrypt in that shape
// (TC-3802): it was refused, so `secrets get` on such a session asked for decrypt on the whole network.
const OWNER = "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412";
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const KEY = `${NETWORK}/secrets/api_key`;
const SPACE = "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:secrets";
const DECRYPT = "tinycloud.encryption/decrypt";

const ctx = {
  summary: { profile: "owner", host: "https://node.tinycloud.test", posture: "owner-openkey", sessionDid: "did:key:session", space: SPACE },
  runtime: { node: { getEncryptionNetworkIdForSpace: () => NETWORK }, granted: [] },
} as unknown as RuntimeOperationContext;

async function missingFor(granted: Array<Record<string, unknown>>): Promise<ReadonlyArray<{ path: string; actions: readonly string[] }>> {
  const input = secretsGetOperationDefinition.input.parse({ name: "API_KEY" });
  const required = await secretsGetOperationDefinition.authority(ctx, input);
  const alternatives = await secretsGetOperationDefinition.authorityAlternatives!(ctx, input);
  // Only the encryption requirement is judged here; the kv read is granted and checked elsewhere.
  return evaluateOperationAuthority(granted as never, required as never, undefined, alternatives as never).missing
    .filter((entry) => entry.service === "tinycloud.encryption") as never;
}

const keyGrant = (extra: Record<string, unknown>) => ({ service: "tinycloud.encryption", space: "encryption", path: KEY, actions: [DECRYPT], ...extra });

describe("the secret's exact key stands in for the network decrypt", () => {
  for (const [shape, extra] of [
    ["no caveats field", {}],
    ["an empty caveat list", { caveats: [] }],
    ["one empty caveat", { caveats: [{}] }],
  ] as const) {
    test(`a grant with ${shape} satisfies it`, async () => {
      expect(await missingFor([keyGrant(extra)])).toEqual([]);
    });
  }

  test("a grant with a real caveat does not", async () => {
    const missing = await missingFor([keyGrant({ caveats: [{ tenant: "other" }] })]);
    expect(missing.map(({ path, actions }) => ({ path: path.toLowerCase(), actions }))).toEqual([{ path: NETWORK.toLowerCase(), actions: [DECRYPT] }]);
  });

  test("a real caveat beside an empty one does not", async () => {
    expect(await missingFor([keyGrant({ caveats: [{}, { tenant: "other" }] })])).toHaveLength(1);
  });

  test("another secret's key does not, with or without an empty caveat list", async () => {
    expect(await missingFor([keyGrant({ path: `${NETWORK}/secrets/other_key`, caveats: [] })])).toHaveLength(1);
  });

  test("key.create on the key is not a decrypt", async () => {
    expect(await missingFor([keyGrant({ actions: ["tinycloud.encryption/key.create"], caveats: [] })])).toHaveLength(1);
  });
});
