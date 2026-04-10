/**
 * Unit tests for the manifest module.
 *
 * Exercises validation, default tiers, prefix inheritance, duration
 * parsing, expiry overrides, and delegation resolution.
 */

import { describe, expect, it } from "bun:test";

import {
  DEFAULT_EXPIRY,
  ManifestValidationError,
  applyPrefix,
  expandActionShortNames,
  normalizeDefaults,
  parseExpiry,
  resolveManifest,
  validateManifest,
  type Manifest,
  type PermissionEntry,
  type ResourceCapability,
} from "./manifest";

// ---------------------------------------------------------------------------
// parseExpiry
// ---------------------------------------------------------------------------

describe("parseExpiry", () => {
  it("parses ms-format duration strings", () => {
    expect(parseExpiry("30d")).toBe(30 * 24 * 60 * 60 * 1000);
    expect(parseExpiry("2h")).toBe(2 * 60 * 60 * 1000);
    expect(parseExpiry("90m")).toBe(90 * 60 * 1000);
    expect(parseExpiry("45s")).toBe(45 * 1000);
  });

  it("throws on empty string", () => {
    expect(() => parseExpiry("")).toThrow(ManifestValidationError);
  });

  it("throws on garbage input", () => {
    expect(() => parseExpiry("not-a-duration")).toThrow(
      ManifestValidationError
    );
  });

  it("throws on zero or negative durations", () => {
    expect(() => parseExpiry("0s")).toThrow(ManifestValidationError);
  });
});

// ---------------------------------------------------------------------------
// expandActionShortNames
// ---------------------------------------------------------------------------

describe("expandActionShortNames", () => {
  it("prefixes short names with the service", () => {
    expect(expandActionShortNames("tinycloud.kv", ["get", "put"])).toEqual([
      "tinycloud.kv/get",
      "tinycloud.kv/put",
    ]);
  });

  it("passes already-expanded URNs through unchanged", () => {
    expect(
      expandActionShortNames("tinycloud.kv", ["tinycloud.kv/get", "list"])
    ).toEqual(["tinycloud.kv/get", "tinycloud.kv/list"]);
  });

  it("handles arbitrary services", () => {
    expect(
      expandActionShortNames("tinycloud.sql", ["read", "ddl"])
    ).toEqual(["tinycloud.sql/read", "tinycloud.sql/ddl"]);
  });
});

// ---------------------------------------------------------------------------
// applyPrefix
// ---------------------------------------------------------------------------

describe("applyPrefix", () => {
  it("joins prefix and path with a slash when path has no leading slash", () => {
    expect(applyPrefix("com.listen.app", "data.sqlite", false)).toBe(
      "com.listen.app/data.sqlite"
    );
  });

  it("keeps the leading slash when path starts with /", () => {
    expect(applyPrefix("com.listen.app", "/", false)).toBe("com.listen.app/");
    expect(applyPrefix("com.listen.app", "/nested/", false)).toBe(
      "com.listen.app/nested/"
    );
  });

  it("returns the path unchanged when skipPrefix is true", () => {
    expect(applyPrefix("com.listen.app", "global/", true)).toBe("global/");
  });

  it("returns the path unchanged when the prefix is empty", () => {
    expect(applyPrefix("", "anything/", false)).toBe("anything/");
  });
});

// ---------------------------------------------------------------------------
// normalizeDefaults
// ---------------------------------------------------------------------------

describe("normalizeDefaults", () => {
  it("defaults undefined to true", () => {
    expect(normalizeDefaults(undefined)).toBe(true);
  });

  it("passes true and false through", () => {
    expect(normalizeDefaults(true)).toBe(true);
    expect(normalizeDefaults(false)).toBe(false);
  });

  it("recognizes admin and all after normalization", () => {
    expect(normalizeDefaults("admin")).toBe("admin");
    expect(normalizeDefaults("ADMIN")).toBe("admin");
    expect(normalizeDefaults("  Admin  ")).toBe("admin");
    expect(normalizeDefaults("all")).toBe("all");
  });

  it("falls back to true on unknown strings", () => {
    expect(normalizeDefaults("super-admin")).toBe(true);
    expect(normalizeDefaults("root")).toBe(true);
    expect(normalizeDefaults("")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

describe("validateManifest", () => {
  it("accepts a minimum-shape manifest", () => {
    const m: Manifest = { id: "com.listen.app", name: "Listen" };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws on missing id", () => {
    expect(() => validateManifest({ name: "Listen" })).toThrow(
      ManifestValidationError
    );
  });

  it("throws on missing name", () => {
    expect(() => validateManifest({ id: "com.listen.app" })).toThrow(
      ManifestValidationError
    );
  });

  it("throws on invalid top-level expiry", () => {
    expect(() =>
      validateManifest({ id: "a.b.c", name: "x", expiry: "forever" })
    ).toThrow(ManifestValidationError);
  });

  it("throws on permission entry with empty actions", () => {
    expect(() =>
      validateManifest({
        id: "a.b.c",
        name: "x",
        permissions: [
          { service: "tinycloud.kv", space: "default", path: "/", actions: [] },
        ],
      })
    ).toThrow(ManifestValidationError);
  });

  it("throws on delegation with missing `to`", () => {
    expect(() =>
      validateManifest({
        id: "a.b.c",
        name: "x",
        delegations: [{ permissions: [] }] as unknown,
      } as Manifest)
    ).toThrow(ManifestValidationError);
  });
});

// ---------------------------------------------------------------------------
// resolveManifest — defaults
// ---------------------------------------------------------------------------

describe("resolveManifest — minimum manifest with defaults=true", () => {
  const resolved = resolveManifest({ id: "com.listen.app", name: "Listen" });

  it("copies the id", () => {
    expect(resolved.id).toBe("com.listen.app");
  });

  it("defaults expiry to 30 days", () => {
    expect(resolved.expiryMs).toBe(parseExpiry(DEFAULT_EXPIRY));
  });

  it("defaults includePublicSpace to true", () => {
    expect(resolved.includePublicSpace).toBe(true);
  });

  it("includes the three standard default entries (kv, sql, capabilities)", () => {
    const services = new Set(resolved.resources.map((r) => r.service));
    expect(services.has("tinycloud.kv")).toBe(true);
    expect(services.has("tinycloud.sql")).toBe(true);
    expect(services.has("tinycloud.capabilities")).toBe(true);
    // DuckDB must NOT be included in the standard tier.
    expect(services.has("tinycloud.duckdb")).toBe(false);
  });

  it("applies the id as the default prefix", () => {
    const kv = resolved.resources.find((r) => r.service === "tinycloud.kv");
    expect(kv).toBeDefined();
    expect(kv?.path).toBe("com.listen.app/");
  });

  it("expands action short names to full URNs", () => {
    const kv = resolved.resources.find((r) => r.service === "tinycloud.kv");
    expect(kv?.actions).toEqual([
      "tinycloud.kv/get",
      "tinycloud.kv/put",
      "tinycloud.kv/del",
      "tinycloud.kv/list",
      "tinycloud.kv/metadata",
    ]);
  });

  it("always includes capabilities:read in any non-false default", () => {
    const caps = resolved.resources.find(
      (r) => r.service === "tinycloud.capabilities"
    );
    expect(caps?.actions).toContain("tinycloud.capabilities/read");
  });
});

describe("resolveManifest — defaults tiers", () => {
  it("false produces no default resources", () => {
    const resolved = resolveManifest({
      id: "a.b.c",
      name: "x",
      defaults: false,
    });
    expect(resolved.resources).toEqual([]);
  });

  it("admin includes sql/ddl and capabilities/admin", () => {
    const resolved = resolveManifest({
      id: "a.b.c",
      name: "x",
      defaults: "admin",
    });
    const sql = resolved.resources.find((r) => r.service === "tinycloud.sql");
    expect(sql?.actions).toContain("tinycloud.sql/ddl");
    const caps = resolved.resources.find(
      (r) => r.service === "tinycloud.capabilities"
    );
    expect(caps?.actions).toContain("tinycloud.capabilities/admin");
    // DuckDB still opt-in.
    expect(
      resolved.resources.find((r) => r.service === "tinycloud.duckdb")
    ).toBeUndefined();
  });

  it("all includes DuckDB", () => {
    const resolved = resolveManifest({
      id: "a.b.c",
      name: "x",
      defaults: "all",
    });
    const duckdb = resolved.resources.find(
      (r) => r.service === "tinycloud.duckdb"
    );
    expect(duckdb).toBeDefined();
    expect(duckdb?.actions).toEqual([
      "tinycloud.duckdb/read",
      "tinycloud.duckdb/write",
    ]);
  });

  it("unknown defaults string silently falls back to true without throwing", () => {
    const resolved = resolveManifest({
      id: "a.b.c",
      name: "x",
      defaults: "super-admin" as unknown as Manifest["defaults"],
    });
    // Standard tier, not admin or all.
    const sql = resolved.resources.find((r) => r.service === "tinycloud.sql");
    expect(sql?.actions).not.toContain("tinycloud.sql/ddl");
  });
});

// ---------------------------------------------------------------------------
// resolveManifest — prefix semantics
// ---------------------------------------------------------------------------

describe("resolveManifest — prefix semantics", () => {
  it("skipPrefix: true leaves the path untouched", () => {
    const resolved = resolveManifest({
      id: "com.listen.app",
      name: "x",
      defaults: false,
      permissions: [
        {
          service: "tinycloud.kv",
          space: "default",
          path: "shared/images/",
          actions: ["get"],
          skipPrefix: true,
        },
      ],
    });
    expect(resolved.resources[0]?.path).toBe("shared/images/");
  });

  it('prefix: "" disables prefix application globally', () => {
    const resolved = resolveManifest({
      id: "com.listen.app",
      name: "x",
      prefix: "",
      defaults: false,
      permissions: [
        {
          service: "tinycloud.kv",
          space: "default",
          path: "foo/",
          actions: ["get"],
        },
      ],
    });
    expect(resolved.resources[0]?.path).toBe("foo/");
  });

  it("explicit prefix overrides the id", () => {
    const resolved = resolveManifest({
      id: "com.listen.app",
      name: "x",
      prefix: "other.prefix",
      defaults: false,
      permissions: [
        {
          service: "tinycloud.kv",
          space: "default",
          path: "data/",
          actions: ["get"],
        },
      ],
    });
    expect(resolved.resources[0]?.path).toBe("other.prefix/data/");
  });

  it("delegations inherit prefix just like top-level permissions", () => {
    const resolved = resolveManifest({
      id: "com.listen.app",
      name: "x",
      defaults: false,
      delegations: [
        {
          to: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
          permissions: [
            {
              service: "tinycloud.sql",
              space: "default",
              path: "data.sqlite",
              actions: ["read"],
            },
          ],
        },
      ],
    });
    expect(resolved.additionalDelegates).toHaveLength(1);
    const delegate = resolved.additionalDelegates[0]!;
    expect(delegate.permissions[0]?.path).toBe("com.listen.app/data.sqlite");
  });

  it("delegations honor skipPrefix on individual permission entries", () => {
    const resolved = resolveManifest({
      id: "com.listen.app",
      name: "x",
      defaults: false,
      delegations: [
        {
          to: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
          permissions: [
            {
              service: "tinycloud.kv",
              space: "default",
              path: "shared/",
              actions: ["get"],
              skipPrefix: true,
            },
          ],
        },
      ],
    });
    expect(resolved.additionalDelegates[0]?.permissions[0]?.path).toBe(
      "shared/"
    );
  });
});

// ---------------------------------------------------------------------------
// resolveManifest — expiry inheritance
// ---------------------------------------------------------------------------

describe("resolveManifest — expiry inheritance", () => {
  it("uses manifest expiry as the session default", () => {
    const resolved = resolveManifest({
      id: "a.b.c",
      name: "x",
      expiry: "7d",
      defaults: false,
    });
    expect(resolved.expiryMs).toBe(parseExpiry("7d"));
  });

  it("per-permission expiry overrides manifest expiry", () => {
    const resolved = resolveManifest({
      id: "a.b.c",
      name: "x",
      expiry: "7d",
      defaults: false,
      permissions: [
        {
          service: "tinycloud.kv",
          space: "default",
          path: "/",
          actions: ["get"],
          expiry: "1h",
        },
      ],
    });
    expect(resolved.resources[0]?.expiryMs).toBe(parseExpiry("1h"));
  });

  it("delegation expiry overrides manifest expiry and is inherited by its permissions", () => {
    const resolved = resolveManifest({
      id: "a.b.c",
      name: "x",
      expiry: "30d",
      defaults: false,
      delegations: [
        {
          to: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
          expiry: "1h",
          permissions: [
            {
              service: "tinycloud.kv",
              space: "default",
              path: "/",
              actions: ["get"],
            },
          ],
        },
      ],
    });
    const delegate = resolved.additionalDelegates[0]!;
    expect(delegate.expiryMs).toBe(parseExpiry("1h"));
  });
});

// ---------------------------------------------------------------------------
// Composition example — backend addendum
// ---------------------------------------------------------------------------

describe("resolveManifest — end-to-end composition", () => {
  it("matches the spec composition example", () => {
    const appManifest: Manifest = {
      id: "com.listen.app",
      name: "Listen",
      defaults: false,
      permissions: [
        {
          service: "tinycloud.sql",
          space: "default",
          path: "data.sqlite",
          actions: ["read", "write"],
        },
      ],
    };
    const composed: Manifest = {
      ...appManifest,
      delegations: [
        {
          to: "did:pkh:eip155:1:0x000000000000000000000000000000000000dead",
          name: "backend",
          expiry: "7d",
          permissions: [
            {
              service: "tinycloud.sql",
              space: "default",
              path: "data.sqlite",
              actions: ["read", "write"],
            },
          ],
        },
      ],
    };

    const resolved = resolveManifest(composed);
    expect(resolved.resources).toHaveLength(1);
    expect(resolved.resources[0]?.path).toBe("com.listen.app/data.sqlite");

    expect(resolved.additionalDelegates).toHaveLength(1);
    const delegate = resolved.additionalDelegates[0]!;
    expect(delegate.did).toBe(
      "did:pkh:eip155:1:0x000000000000000000000000000000000000dead"
    );
    expect(delegate.expiryMs).toBe(parseExpiry("7d"));
    expect(delegate.permissions[0]?.path).toBe("com.listen.app/data.sqlite");
    expect(delegate.permissions[0]?.actions).toEqual([
      "tinycloud.sql/read",
      "tinycloud.sql/write",
    ]);
  });
});
