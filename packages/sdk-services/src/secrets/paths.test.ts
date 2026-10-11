import { describe, expect, it } from "bun:test";

import {
  MAX_SECRET_SCOPE_LENGTH,
  SECRET_SCOPE_RE,
  TC832_RESERVED_SCOPES,
  appSecretScope,
  canonicalizeSecretScope,
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
