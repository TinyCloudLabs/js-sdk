import { describe, expect, test } from "bun:test";

import {
  extractSiweExpiration,
  legacyParamsToPermissionEntries,
  resolveExpiryMs,
} from "./delegateToHelpers";

describe("legacyParamsToPermissionEntries", () => {
  test("groups actions by tinycloud.<service> prefix", () => {
    const entries = legacyParamsToPermissionEntries(
      [
        "tinycloud.kv/get",
        "tinycloud.kv/put",
        "tinycloud.sql/read",
      ],
      "items/",
      undefined,
    );
    // One entry per service, preserving the original action list order per
    // service. Iteration order is insertion order on Map.
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      service: "tinycloud.kv",
      space: "default",
      path: "items/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    });
    expect(entries[1]).toEqual({
      service: "tinycloud.sql",
      space: "default",
      path: "items/",
      actions: ["tinycloud.sql/read"],
    });
  });

  test("uses spaceIdOverride when provided", () => {
    const entries = legacyParamsToPermissionEntries(
      ["tinycloud.kv/get"],
      "/",
      "space://custom",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].space).toBe("space://custom");
  });

  test("drops action URNs without a slash", () => {
    // Malformed URNs (no /) should be silently dropped to match how the
    // wallet path also ignores unrecognised prefixes.
    const entries = legacyParamsToPermissionEntries(
      ["tinycloud.kv", "tinycloud.kv/get"],
      "/",
      undefined,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].actions).toEqual(["tinycloud.kv/get"]);
  });

  test("drops action URNs whose prefix is not tinycloud.*", () => {
    const entries = legacyParamsToPermissionEntries(
      ["other.ns/foo", "tinycloud.kv/get"],
      "/",
      undefined,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("tinycloud.kv");
  });

  test("empty actions returns empty array", () => {
    expect(legacyParamsToPermissionEntries([], "/", undefined)).toEqual([]);
  });
});

describe("resolveExpiryMs", () => {
  test("undefined → 1 hour default", () => {
    expect(resolveExpiryMs(undefined)).toBe(60 * 60 * 1000);
  });

  test("positive number passes through unchanged", () => {
    expect(resolveExpiryMs(5000)).toBe(5000);
    expect(resolveExpiryMs(7 * 24 * 60 * 60 * 1000)).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
  });

  test("zero number throws", () => {
    expect(() => resolveExpiryMs(0)).toThrow(/positive finite/);
  });

  test("negative number throws", () => {
    expect(() => resolveExpiryMs(-1)).toThrow(/positive finite/);
  });

  test("NaN throws", () => {
    expect(() => resolveExpiryMs(Number.NaN)).toThrow(/positive finite/);
  });

  test("ms-format string parses correctly", () => {
    expect(resolveExpiryMs("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(resolveExpiryMs("1h")).toBe(60 * 60 * 1000);
    expect(resolveExpiryMs("30m")).toBe(30 * 60 * 1000);
  });

  test("invalid duration string throws", () => {
    expect(() => resolveExpiryMs("not-a-duration")).toThrow();
  });
});

describe("extractSiweExpiration", () => {
  // A minimal valid SIWE message. We build it by hand rather than using
  // the `siwe` library's formatter so the tests don't depend on the
  // formatter's exact output.
  function buildSiwe(expirationTime: string | null): string {
    const lines = [
      "example.com wants you to sign in with your Ethereum account:",
      "0x0000000000000000000000000000000000000001",
      "",
      "Sign-in statement",
      "",
      "URI: https://example.com",
      "Version: 1",
      "Chain ID: 1",
      "Nonce: abcdefghij",
      "Issued At: 2024-01-01T00:00:00.000Z",
    ];
    if (expirationTime !== null) {
      lines.push(`Expiration Time: ${expirationTime}`);
    }
    return lines.join("\n");
  }

  test("returns the expiration as a Date when present", () => {
    const result = extractSiweExpiration(buildSiwe("2025-01-01T00:00:00.000Z"));
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  test("returns undefined when the SIWE has no Expiration Time line", () => {
    const result = extractSiweExpiration(buildSiwe(null));
    expect(result).toBeUndefined();
  });

  test("propagates parse errors for malformed SIWE", () => {
    // A completely unparseable SIWE should throw (from inside SiweMessage)
    // rather than silently returning undefined — a corrupted session is
    // a bug we want to surface.
    expect(() => extractSiweExpiration("garbage not-siwe")).toThrow();
  });
});
