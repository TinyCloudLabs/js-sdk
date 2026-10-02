import { expect, test } from "bun:test";
import * as records from "./applicationRecords";

const key = "applications/notes";
const manifest = { app_id: "notes", name: "Notes", knowledge: true };

function prepare(value: unknown) {
  expect(typeof records.prepareLegacyApplicationRecord).toBe("function");
  return records.prepareLegacyApplicationRecord(key, value);
}

test("explicit legacy preparation validates the manifest and preserves unknown fields without mutation", () => {
  const original = {
    app_id: "notes",
    manifest,
    custom: { preserve: "exact" },
    updated_at: "2026-10-01T12:00:00Z",
  };
  const result = prepare(JSON.stringify(original));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data.original).toEqual(original);
  expect(result.data.record).toEqual({
    app_id: "notes",
    manifests: [manifest],
    custom: original.custom,
    updated_at: original.updated_at,
    manifest_hash: records.hashApplicationManifests([manifest]),
  });
  expect(result.data.application.manifests).toEqual([manifest]);
  expect(original).toHaveProperty("manifest");
});

test("unrecognized legacy shapes and conflicting hashes remain explicit errors", () => {
  for (const original of [
    null,
    { manifest: [] },
    { manifest: { name: "No identity" } },
    { manifest: { ...manifest, app_id: "other" } },
    { manifests: [manifest], manifest },
    { manifest, manifest_hash: "unverifiable" },
  ]) {
    expect(prepare(original).ok).toBe(false);
  }
});
