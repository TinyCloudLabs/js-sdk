import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3150GiveBackRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3150GiveBackRootTransition,
} from "./replica-size-policy";

test("TC-3150 records the exact canonical CI root bytes of #1049 within the 700-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3150GiveBackRoot;
  const predecessor = ledger.tc2490OneApprovalRoot;
  expect(row).toEqual(approvedTc3150GiveBackRoot);
  expect(row.base).toBe("228c94daa11841bdd6300ab924e0769d5d9db65c");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44613079923",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44613079923/job/135874476843",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44613079923/job/135874476632",
    ],
  });
  expect(row.sourceCommits).toEqual(["1306efc7eedd483827142a661921e42814e3d7c5"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1530477, "index.cjs": 1463393 });
  expect(row.root.delta).toEqual({ "index.mjs": 619, "index.cjs": 544 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(700);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3150GiveBackRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3150GiveBackRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3150 refuses mutation, removal, or a missing TC-2490 predecessor", () => {
  const row = ledger.tc3150GiveBackRoot;
  validateTc3150GiveBackRootTransition(undefined, row);
  validateTc3150GiveBackRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3150GiveBackRootTransition(undefined, changed)).toThrow("TC-3150");
    expect(() => validateLedger({ ...ledger, tc3150GiveBackRoot: changed })).toThrow("TC-3150");
  }

  expect(() => validateTc3150GiveBackRootTransition(row, undefined)).toThrow("TC-3150");
  expect(() => validateLedger({ ...ledger, tc2490OneApprovalRoot: undefined })).toThrow("TC-3150");
});
