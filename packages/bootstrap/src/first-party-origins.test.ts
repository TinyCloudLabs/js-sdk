import { expect, test } from "bun:test";
import { FIRST_PARTY_ORIGINS, FIRST_PARTY_PAGES_SUBDOMAINS, isFirstPartyOrigin } from "./first-party-origins";
import openkey from "../test-fixtures/openkey-first-party-origins.json";

// OpenKey entries that the public package does not trust.
const OPENKEY_ONLY_ORIGINS = ["https://lightning-node-1.gecko-snares.ts.net:8451"];
// SDK entries OpenKey's pinned list does not have yet. tinycloud.one is added to OpenKey by
// TinyCloudLabs/openkey#502; when the pin moves to a commit that includes it, the SDK-only test
// below fails until the entry is removed here (the SDK list keeps it, in the same position).
const SDK_ONLY_ORIGINS = ["https://tinycloud.one"];
const publicOrigins = openkey.origins.filter((origin) => !OPENKEY_ONLY_ORIGINS.includes(origin));

test("the SDK exports match OpenKey's pinned first-party origin contract, less its OpenKey-only entries and plus its SDK-only entries", () => {
  expect([...FIRST_PARTY_ORIGINS].filter((origin) => !SDK_ONLY_ORIGINS.includes(origin))).toEqual(publicOrigins);
  expect(FIRST_PARTY_PAGES_SUBDOMAINS).toEqual(openkey.pagesProjects);
});

for (const origin of SDK_ONLY_ORIGINS) test(`the SDK-only origin ${origin} is trusted and not yet in OpenKey's pinned list`, () => {
  expect(FIRST_PARTY_ORIGINS.has(origin)).toBe(true);
  expect(isFirstPartyOrigin(origin)).toBe(true);
  expect(openkey.origins).not.toContain(origin);
});

for (const origin of publicOrigins) test(`accepts exact first-party origin ${origin}`, () => {
  expect(isFirstPartyOrigin(origin)).toBe(true);
});
for (const origin of OPENKEY_ONLY_ORIGINS) test(`does not trust the OpenKey-only origin ${origin}`, () => {
  expect(openkey.origins).toContain(origin);
  expect(isFirstPartyOrigin(origin)).toBe(false);
});
for (const project of openkey.pagesProjects) test(`accepts only the owned ${project} Pages host and one preview label`, () => {
  expect(isFirstPartyOrigin(`https://${project}.pages.dev`)).toBe(true);
  expect(isFirstPartyOrigin(`https://branch-123.${project}.pages.dev`)).toBe(true);
  expect(isFirstPartyOrigin(`https://a.b.${project}.pages.dev`)).toBe(false);
});
for (const origin of [undefined, null, "", "http://localhost:3000", "http://127.0.0.1:3000", "https://notes.example", "https://tinycloud.chat.evil", "https://home.tinycloud.xyz:8443", "http://home.tinycloud.xyz", "https://home.tinycloud.xyz/", "https://unowned.pages.dev", "https://www.tinycloud.one", "https://app.tinycloud.one", "https://tinycloud.one:8443", "http://tinycloud.one", "https://tinycloud.one/", "https://tinycloud.one.evil.example", "https://evil-tinycloud.one"]) test(`does not trust ${String(origin)}`, () => {
  expect(isFirstPartyOrigin(origin)).toBe(false);
});

for (const origin of ["https://HOME.tinycloud.xyz", "HTTPS://home.tinycloud.xyz", "https://TINYCLOUD.ONE", "https://Branch.tinychat-4jq.pages.dev"]) test(`requires exact origin casing for ${origin}`, () => {
  expect(isFirstPartyOrigin(origin)).toBe(false);
});
