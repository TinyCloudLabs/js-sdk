import { describe, expect, it } from "bun:test";

import {
  MAX_SECRET_NAME_LENGTH,
  MAX_SECRET_SCOPE_LENGTH,
  SECRET_SCOPE_RE,
  TC832_RESERVED_SCOPES,
  appSecretScope,
  canonicalizeSecretScope,
  parseSecretCatalogKey,
  parseSecretKeyPath,
  resolveSecretPath,
  secretKeyPath,
} from "./index";

describe("appSecretScope", () => {
  it("maps app ids to canonical scopes", () => {
    expect(appSecretScope("xyz.tinycloud.feed-workflows")).toBe("xyz-tinycloud-feed-workflows");
    expect(appSecretScope("com.listen.app")).toBe("com-listen-app");
    expect(appSecretScope("  My__App  ")).toBe("my-app");
  });

  it("accepts 64 characters and rejects 65", () => {
    expect(MAX_SECRET_SCOPE_LENGTH).toBe(64);
    expect(appSecretScope("a".repeat(64))).toBe("a".repeat(64));
    expect(() => appSecretScope("a".repeat(65))).toThrow();
  });

  it("rejects empty and separator-only ids", () => {
    for (const appId of ["", "   ", "...", "___"]) {
      expect(() => appSecretScope(appId)).toThrow();
    }
  });

  it("rejects ids that derive a reserved scope", () => {
    expect(TC832_RESERVED_SCOPES).toEqual(["default", "global", "scoped"]);
    for (const appId of ["Default", "global", "SCOPED"]) {
      expect(() => appSecretScope(appId)).toThrow();
    }
  });

  it("returns fixed points of canonicalizeSecretScope that match the scope grammar", () => {
    for (const appId of [
      "xyz.tinycloud.feed-workflows",
      "com.listen.app",
      "  My__App  ",
      "A--B..C",
      "-x-",
      "a".repeat(64),
    ]) {
      const scope = appSecretScope(appId);
      expect(canonicalizeSecretScope(scope)).toBe(scope);
      expect(SECRET_SCOPE_RE.test(scope)).toBe(true);
    }
  });
});

// TC-3801: a secret is sealed to its own key, one node key segment of at most
// 64 bytes per name and scope; a longer one is refused, never given the network.
describe("resolveSecretPath name and scope limits", () => {
  const longest = `A${"B".repeat(MAX_SECRET_NAME_LENGTH - 1)}`;

  it("resolves a 64-character name and scope to their own key", () => {
    expect(resolveSecretPath(longest, { scope: "a".repeat(MAX_SECRET_SCOPE_LENGTH) }).keyPath)
      .toBe(`secrets/scoped/${"a".repeat(64)}/${longest.toLowerCase()}`);
  });

  it("refuses a 65-character name or scope with the limit in the message", () => {
    expect(() => resolveSecretPath(`${longest}C`)).toThrow("is longer than 64 characters");
    expect(() => resolveSecretPath("API_KEY", { scope: "a".repeat(65) })).toThrow("is longer than 64 characters");
    expect(() => canonicalizeSecretScope("a".repeat(65))).toThrow("is longer than 64 characters");
  });

  it("lists no catalog entry it could not read", () => {
    expect(parseSecretCatalogKey(longest)).toEqual({ name: longest });
    expect(parseSecretCatalogKey(`${longest}C`)).toBeUndefined();
    expect(parseSecretCatalogKey(`scoped/food/${longest}C`)).toBeUndefined();
    expect(parseSecretCatalogKey(`scoped/${"a".repeat(65)}/API_KEY`)).toBeUndefined();
  });
});

describe("the key of the unscoped name SCOPED", () => {
  it("is refused: secrets/scoped is the parent of every scoped key", () => {
    expect(() => secretKeyPath("SCOPED")).toThrow("is reserved");
    expect(() => resolveSecretPath("SCOPED")).toThrow("is reserved");
    expect(parseSecretKeyPath("secrets/scoped")).toBeUndefined();
  });

  it("is a name like any other inside a scope, and no other key path is affected", () => {
    expect(secretKeyPath("SCOPED", "food")).toBe("secrets/scoped/food/scoped");
    expect(parseSecretKeyPath("secrets/scoped/food/scoped")).toEqual({ name: "SCOPED", scope: "food" });
    expect(secretKeyPath("SCOPED_KEY")).toBe("secrets/scoped_key");
    expect(parseSecretKeyPath("secrets/scoped_key")).toEqual({ name: "SCOPED_KEY" });
  });
});
