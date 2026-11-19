import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ManifestValidationError, validateManifest } from "./manifest";

interface KeyVector {
  id: string;
  app_id: string;
  keys?: unknown;
  keys_generated?: { count: number; path_template: string; abilities: string[] };
  expect: "valid" | "invalid";
}

const vectors = JSON.parse(readFileSync(new URL("../test-fixtures/manifest-keys-vectors.json", import.meta.url), "utf8")) as {
  cases: KeyVector[];
};

describe("manifest keys match OpenKey's shared vectors", () => {
  for (const vector of vectors.cases) {
    test(vector.id, () => {
      const generated = vector.keys_generated;
      const keys = generated
        ? Array.from({ length: generated.count }, (_, index) => ({
            path: generated.path_template.replace("{i}", String(index)),
            abilities: generated.abilities,
          }))
        : vector.keys;
      const manifest = { app_id: vector.app_id, name: "Vector", defaults: false, keys };
      if (vector.expect === "valid") {
        expect(validateManifest(manifest)).toBe(manifest);
      } else {
        let error: unknown;
        try { validateManifest(manifest); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(ManifestValidationError);
        expect((error as Error).message).toMatch(/manifest.keys/);
        expect((error as Error).message).not.toContain("\u202e");
      }
    });
  }
});

test("keys_app_id selects the app key namespace and app_id is the default", () => {
  const entry = { path: "apps/xyz.tinycloud.healthlog/token", abilities: ["key.create", "decrypt"] };
  expect(() => validateManifest({ app_id: "xyz.tinycloud.healthlog", name: "Healthlog", keys: [entry] })).not.toThrow();
  expect(() => validateManifest({ app_id: "billing", keys_app_id: "xyz.tinycloud.healthlog", name: "Healthlog", keys: [entry] })).not.toThrow();
  expect(() => validateManifest({ app_id: "billing", keys_app_id: "xyz.tinycloud.healthlog", name: "Healthlog",
    keys: [{ path: "apps/billing/token", abilities: ["decrypt"] }] })).toThrow(ManifestValidationError);
  for (const keysAppId of [undefined, null, 42, "HealthLog", "apps/healthlog"]) {
    expect(() => validateManifest({ app_id: "billing", keys_app_id: keysAppId, name: "Healthlog",
      keys: [{ path: "apps/billing/token", abilities: ["decrypt"] }] })).toThrow(ManifestValidationError);
  }
});
