import { describe, expect, test } from "bun:test";
import { recapCaveatsEqual } from "@tinycloud/sdk-core";
import { assertNoCaveatLimits, hasCaveatLimit } from "./caveat-refusal.js";

// Values the shared comparison cannot canonicalize (it throws); each counts as a limit.
const uncanonicalizable: Array<[string, unknown]> = [
  ["a non-plain object", [new Map()]],
  ["a non-finite number", [{ n: Number.NaN }]],
  ["an undefined member", [{ a: undefined }]],
  ["a function", [() => 1]],
];

describe("caveat refusal", () => {
  test.each(uncanonicalizable)("refuses caveats holding %s, which the shared comparison cannot canonicalize", (_name, caveats) => {
    expect(() => recapCaveatsEqual(caveats as Record<string, unknown>[], undefined)).toThrow();
    expect(hasCaveatLimit(caveats)).toBe(true);
    expect(() => assertNoCaveatLimits([{ service: "tinycloud.kv", path: "notes", actions: ["tinycloud.kv/get"], caveats }]))
      .toThrow(expect.objectContaining({ code: "CAVEATS_UNSUPPORTED", exitCode: 2 }));
  });

  test("allows only absent, [] and a lone [{}]", () => {
    for (const caveats of [undefined, [], [{}]]) expect(hasCaveatLimit(caveats)).toBe(false);
    for (const caveats of [[{}, {}], [{ tenant: "alpha" }], null, "tenant", {}]) expect(hasCaveatLimit(caveats)).toBe(true);
  });
});
