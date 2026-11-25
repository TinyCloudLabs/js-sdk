import { expect, test } from "bun:test";
import { FIRST_PARTY_ORIGINS, isFirstPartyOrigin } from "./first-party-origins";

test("feed.tinycloud.xyz is not first-party until feed serves a strict CSP (TC-4299)", () => {
  expect(isFirstPartyOrigin("https://feed.tinycloud.xyz")).toBe(false);
  for (const origin of [
    "http://feed.tinycloud.xyz", "https://feed.tinycloud.xyz:8443", "https://feed.tinycloud.xyz/", "https://FEED.tinycloud.xyz",
    "https://feed.tinycloud.xyz.evil.example", "https://evil-feed.tinycloud.xyz", "https://www.feed.tinycloud.xyz", "https://feed.tinycloud.one",
  ]) expect(isFirstPartyOrigin(origin)).toBe(false);
});

test("the TinyChat native webview origins are not first-party: native sign-in no longer provisions for them", () => {
  for (const origin of ["https://app.tinycloud.one", "tinycloudone://app.tinycloud.one"]) {
    expect(isFirstPartyOrigin(origin)).toBe(false);
    expect(FIRST_PARTY_ORIGINS.has(origin)).toBe(false);
  }
});

test("no localhost or loopback origin is first-party", () => {
  for (const origin of ["http://localhost", "http://localhost:3000", "https://localhost", "capacitor://localhost", "http://127.0.0.1:3000"]) {
    expect(isFirstPartyOrigin(origin)).toBe(false);
  }
});
