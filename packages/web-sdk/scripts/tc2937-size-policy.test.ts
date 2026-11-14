import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2937SharePlacementRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc2937SharePlacementRootTransition,
} from "./replica-size-policy";

test("TC-2937 records the exact canonical CI root bytes within its 800-byte caps", () => {
  validateLedger(ledger);
  const row = ledger.tc2937SharePlacementRoot;
  const predecessor = ledger.tc2987RegistryAbsentReadsRoot;
  expect(row).toEqual(approvedTc2937SharePlacementRoot);
  expect(row.base).toBe("d4949e8c02990c0f1bb67da6b8879b0fe93cdadd");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43531110930",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43531110930/job/132248767179",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43531110930/job/132248766860",
    ],
  });
  expect(row.sourceCommits).toEqual(["5a99f8b8437e83593ba562f330a18ae32e5fd23a"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1525878, "index.cjs": 1460319 });
  expect(row.root.delta).toEqual({ "index.mjs": 703, "index.cjs": 690 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc2937SharePlacementRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc2937SharePlacementRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-2937 refuses mutation, removal, or a missing TC-2987 predecessor", () => {
  const row = ledger.tc2937SharePlacementRoot;
  validateTc2937SharePlacementRootTransition(undefined, row);
  validateTc2937SharePlacementRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2937SharePlacementRootTransition(undefined, changed)).toThrow("TC-2937");
    expect(() => validateLedger({ ...ledger, tc2937SharePlacementRoot: changed })).toThrow("TC-2937");
  }

  expect(() => validateTc2937SharePlacementRootTransition(row, undefined)).toThrow("TC-2937");
  expect(() => validateLedger({ ...ledger, tc2987RegistryAbsentReadsRoot: undefined })).toThrow("TC-2937");
});
