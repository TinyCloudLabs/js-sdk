import { expect, test } from "bun:test";
import { invitationKeyFromGrant } from "./invitation-key-grant.js";

const owner = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const network = `urn:tinycloud:encryption:${owner}:default`;
const ID = "a1".repeat(16);
const now = Date.parse("2026-11-11T12:00:00.000Z");
const accept = new Date(now + 3_600_000).toISOString();
const inHour = new Date(now + 3_000_000).toISOString();
const entry = (path: string, actions: string[], extra: Record<string, unknown> = {}) => ({ service: "tinycloud.encryption", space: "encryption", path, actions, ...extra });
const both = ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"];
const read = (permissions: unknown[], expiresAt = inHour) => invitationKeyFromGrant(permissions as never, { ownerDid: owner, expiresAt, acceptanceExpiresAt: accept, now });

test("one key.create + decrypt pair on one canonical key yields its id, whichever space it is reported under", () => {
  expect(read([entry(`${network}/share/${ID}`, both)])).toBe(ID);
  expect(read([{ ...entry(`${network}/share/${ID}`, [both[0]!]), space: "" }, entry(`${network}/share/${ID}`, [both[1]!])])).toBe(ID);
});

test.each([
  ["half a pair", [entry(`${network}/share/${ID}`, [both[1]!])]],
  ["the share prefix", [entry(`${network}/share/`, both)]],
  ["an upper-case id", [entry(`${network}/share/${ID.toUpperCase()}`, both)]],
  ["a short id", [entry(`${network}/share/${ID.slice(2)}`, both)]],
  ["another network", [entry(`urn:tinycloud:encryption:${owner}:other/share/${ID}`, both)]],
  ["another owner", [entry(`urn:tinycloud:encryption:did:pkh:eip155:1:0x${"2".repeat(40)}:default/share/${ID}`, both)]],
  ["two keys", [entry(`${network}/share/${ID}`, both), entry(`${network}/share/${"b2".repeat(16)}`, both)]],
  ["another service beside the key", [entry(`${network}/share/${ID}`, both), { service: "tinycloud.kv", space: "default", path: "", actions: ["tinycloud.kv/get"] }]],
  ["an extra action", [entry(`${network}/share/${ID}`, [...both, "tinycloud.encryption/delete"])]],
  ["a caveat", [entry(`${network}/share/${ID}`, both, { caveats: [{ any: true }] })]],
  ["nothing", []],
])("refuses %s", (_name, permissions) => {
  expect(() => read(permissions)).toThrow(/invitation/);
});

test("refuses an approval that has expired, runs past the acceptance window, or lasts more than a day", () => {
  const key = [entry(`${network}/share/${ID}`, both)];
  expect(() => read(key, new Date(now - 1000).toISOString())).toThrow(/expired/);
  expect(() => read(key, new Date(now + 3_600_000 + 6 * 60_000).toISOString())).toThrow(/longer than the invitation/);
  expect(() => invitationKeyFromGrant(key as never, { ownerDid: owner, expiresAt: new Date(now + 2 * 86_400_000).toISOString(), acceptanceExpiresAt: new Date(now + 3 * 86_400_000).toISOString(), now }))
    .toThrow(/longer than the invitation/);
});
