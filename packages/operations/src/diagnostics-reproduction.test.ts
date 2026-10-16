import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { reproduceDiagnosticFixture } from "./diagnostics-reproduction.js";

test("reviewed synthetic mismatch survives the real apps write and independent read path", async () => {
  const fixture = { schema_version: 1, kind: "wrong_units", fixture_id: randomUUID(), reviewed: true, synthetic: true, expected: { value: 12, unit: "U1" }, observed: { value: 12, unit: "U2" } };
  const report = await reproduceDiagnosticFixture(fixture);
  expect(report).toMatchObject({ fixture_id: fixture.fixture_id, recipe: "tc_apps_write_independent_read", expected: { value: 12, unit: "U1" }, observed: { value: 12, unit: "U2" }, write_outcome: "ok", read_outcome: "ok", independent_read_back: true, semantic_match: false, finding: "wrong_units", production_replay: false });
  await expect(reproduceDiagnosticFixture({ ...fixture, endpoint: "http://127.0.0.1" })).rejects.toThrow("diagnostics: invalid_input");
});
