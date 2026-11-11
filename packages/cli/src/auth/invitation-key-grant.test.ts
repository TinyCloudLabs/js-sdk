import { expect, test } from "bun:test";
import { invitationKeyFromGrant } from "./invitation-key-grant.js";

const owner = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const network = `urn:tinycloud:encryption:${owner}:default`;
const ID = "a1".repeat(16);
const now = Date.parse("2026-11-11T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const accept = iso(now + 3_600_000);
const issued = iso(now - 1000);
const inHour = iso(now + 3_000_000);
const entry = (path: string, actions: string[], extra: Record<string, unknown> = {}) => ({ service: "tinycloud.encryption", space: "encryption", path, actions, ...extra });
const both = ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"];
const read = (permissions: unknown[], expiresAt = inHour, issuedAt = issued, acceptance = accept) =>
  invitationKeyFromGrant(permissions as never, { ownerDid: owner, issuedAt, expiresAt, acceptanceExpiresAt: acceptance, now });

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

const key = [entry(`${network}/share/${ID}`, both)];

test("the bounds are exact: expired, one second past the acceptance window, or lasting more than a day is refused; the window's last second is accepted", () => {
  expect(() => read(key, iso(now - 1000))).toThrow(/expired/);
  expect(read(key, accept)).toBe(ID);
  expect(() => read(key, iso(Date.parse(accept) + 1000))).toThrow(/longer than the invitation/);
  const longIssue = iso(now - 86_400_000 + 1000);
  expect(read(key, iso(now + 1000), longIssue, iso(now + 2 * 86_400_000))).toBe(ID);
  expect(() => read(key, iso(now + 2000), longIssue, iso(now + 2 * 86_400_000))).toThrow(/longer than the invitation/);
  expect(() => read(key, inHour, iso(now + 600_000))).toThrow(/future/);
});
