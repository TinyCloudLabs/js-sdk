import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2927ShareApprovalRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc2927ShareApprovalRootTransition,
} from "./replica-size-policy";

// Naomi's TC-2927 ruling: exact canonical CI bytes, at most +2800 B ESM and +1900 B CJS over the newest root row.
const CAPS = { "index.mjs": 2800, "index.cjs": 1900 } as const;

test("TC-2927 records the exact canonical CI root bytes within its per-format caps", () => {
  validateLedger(ledger);
  const row = ledger.tc2927ShareApprovalRoot;
  const predecessor = ledger.tc2937SharePlacementRoot;
  expect(row).toEqual(approvedTc2927ShareApprovalRoot);
  expect(row.base).toBe("37d930ec31806b28ff83f0801bd35308d73a9e6d");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43544682854",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43544682854/job/132293112748",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43544682854/job/132293112388",
    ],
  });
  expect(row.sourceCommits).toEqual(["91fc7f21b1ce672022616150ea88e8fba2f0f055"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1528635, "index.cjs": 1462091 });
  expect(row.root.delta).toEqual({ "index.mjs": 2757, "index.cjs": 1772 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(CAPS[format]);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc2927ShareApprovalRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc2927ShareApprovalRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-2927 refuses mutation, removal, or a missing TC-2937 predecessor", () => {
  const row = ledger.tc2927ShareApprovalRoot;
  validateTc2927ShareApprovalRootTransition(undefined, row);
  validateTc2927ShareApprovalRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.mjs"]++; },
    (value: typeof row) => { value.root.delta["index.cjs"]++; },
    (value: typeof row) => { value.base = "0".repeat(40); },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2927ShareApprovalRootTransition(undefined, changed)).toThrow("TC-2927");
    expect(() => validateLedger({ ...ledger, tc2927ShareApprovalRoot: changed })).toThrow("TC-2927");
  }

  expect(() => validateTc2927ShareApprovalRootTransition(row, undefined)).toThrow("TC-2927");
  expect(() => validateLedger({ ...ledger, tc2937SharePlacementRoot: undefined })).toThrow("TC-2927");
});
