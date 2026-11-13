import { expect, test } from "bun:test";
import { FIRST_PARTY_ORIGINS, FIRST_PARTY_PAGES_SUBDOMAINS, isFirstPartyOrigin } from "./first-party-origins";
import openkey from "../test-fixtures/openkey-first-party-origins.json";

test("the SDK exports match OpenKey's pinned first-party origin contract", () => {
  expect([...FIRST_PARTY_ORIGINS]).toEqual(openkey.origins);
  expect(FIRST_PARTY_PAGES_SUBDOMAINS).toEqual(openkey.pagesProjects);
});

for (const origin of openkey.origins) test(`accepts exact first-party origin ${origin}`, () => {
  expect(isFirstPartyOrigin(origin)).toBe(true);
});
for (const project of openkey.pagesProjects) test(`accepts only the owned ${project} Pages host and one preview label`, () => {
  expect(isFirstPartyOrigin(`https://${project}.pages.dev`)).toBe(true);
  expect(isFirstPartyOrigin(`https://branch-123.${project}.pages.dev`)).toBe(true);
  expect(isFirstPartyOrigin(`https://a.b.${project}.pages.dev`)).toBe(false);
});
for (const origin of [undefined, null, "", "http://localhost:3000", "http://127.0.0.1:3000", "https://notes.example", "https://tinycloud.chat.evil", "https://home.tinycloud.xyz:8443", "http://home.tinycloud.xyz", "https://home.tinycloud.xyz/", "https://unowned.pages.dev"]) test(`does not trust ${String(origin)}`, () => {
  expect(isFirstPartyOrigin(origin)).toBe(false);
});

for (const origin of ["https://HOME.tinycloud.xyz", "HTTPS://home.tinycloud.xyz", "https://Branch.tinychat-4jq.pages.dev"]) test(`requires exact origin casing for ${origin}`, () => {
  expect(isFirstPartyOrigin(origin)).toBe(false);
});
