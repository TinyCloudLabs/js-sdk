import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3114StatusSchemaRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3114StatusSchemaRootTransition,
} from "./replica-size-policy";

test("stable TC-3114 records the exact canonical CI root bytes of the status-schema patch within a 150-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3114StatusSchemaRoot;
  const predecessor = ledger.tc2949StablePanelChunkRecoveryRoot;
  expect(row).toEqual(approvedTc3114StatusSchemaRoot);
  expect(row.base).toBe("3b8fad5e6004ccde79d0e0f3e9369c2e5f59460c");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43902342085",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43902342085/job/133422005409",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43902342085/job/133422006018",
    ],
  });
  expect(row.sourceCommits).toEqual(["1a4ebaf7de1e805187b3020d3efc1e5ae55deb82"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1479872, "index.cjs": 1424085 });
  expect(row.root.delta).toEqual({ "index.mjs": 116, "index.cjs": 77 });
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.ceiling[format] - predecessor.root.ceiling[format];
    expect(row.root.delta[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(150);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3114StatusSchemaRoot", ceiling: row.root.ceiling[format] });
  }
  expect(ancestryPins(ledger, false)).toContainEqual({ row: "tc3114StatusSchemaRoot", pin: row.sourceCommits[0] });
  expect(Object.keys(row).sort()).toEqual(["base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits"]);
});

test("stable TC-3114 refuses mutation, removal, or a missing TC-2949 predecessor", () => {
  const row = ledger.tc3114StatusSchemaRoot;
  validateTc3114StatusSchemaRootTransition(undefined, row);
  validateTc3114StatusSchemaRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3114StatusSchemaRootTransition(undefined, changed)).toThrow("stable TC-3114");
    expect(() => validateLedger({ ...ledger, tc3114StatusSchemaRoot: changed })).toThrow("stable TC-3114");
  }

  expect(() => validateTc3114StatusSchemaRootTransition(row, undefined)).toThrow("stable TC-3114");
  expect(() => validateLedger({ ...ledger, tc2949StablePanelChunkRecoveryRoot: undefined })).toThrow("stable TC-3114");
});
