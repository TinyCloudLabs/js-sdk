import { describe, expect, test } from "bun:test";

import { assertValidReplicationConfig } from "./authority";

const DAY = 24 * 60 * 60 * 1000;
const storage = {};

describe("grantTtlMs config (§6)", () => {
  test("accepts omitted grantTtlMs and values up to the 7-day ceiling", () => {
    expect(() => assertValidReplicationConfig({ enabled: true, storage, prefixes: ["notes/"] })).not.toThrow();
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: ["notes/"], grantTtlMs: 7 * DAY }),
    ).not.toThrow();
  });

  test("rejects grantTtlMs above 7 days", () => {
    expect(() =>
      assertValidReplicationConfig({ enabled: true, storage, prefixes: ["notes/"], grantTtlMs: 7 * DAY + 1 }),
    ).toThrow(TypeError);
  });

  test("rejects non-positive or non-finite grantTtlMs", () => {
    for (const grantTtlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        assertValidReplicationConfig({ enabled: true, storage, prefixes: ["notes/"], grantTtlMs }),
      ).toThrow(TypeError);
    }
  });
});
