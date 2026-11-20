import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3549KeptApprovalsRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3549KeptApprovalsRootTransition,
} from "./replica-size-policy";

test("TC-3549 records the exact canonical CI root bytes of #1102 within the ruled allowance", () => {
  validateLedger(ledger);
  const row = ledger.tc3549KeptApprovalsRoot;
  const predecessor = ledger.tc2490OneApprovalRoot;
  expect(row).toEqual(approvedTc3549KeptApprovalsRoot);
  expect(row.base).toBe("f7428c208ad970dac3f626788e26f7654888b7e9");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44675134152",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44675134152/job/136085053431",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44675134152/job/136085053419",
    ],
  });
  expect(row.sourceCommits).toEqual(["3a82a453f3981cf7847c2c08b9a864218324f709"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1530795, "index.cjs": 1463641 });
  expect(row.root.delta).toEqual({ "index.mjs": 937, "index.cjs": 792 });
  expect(row.ruling).toContain("size-ruling: TC-3549 (2026-11-20)");

  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3549KeptApprovalsRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3549KeptApprovalsRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3549 refuses mutation, removal, or a missing TC-2490 predecessor", () => {
  const row = ledger.tc3549KeptApprovalsRoot;
  validateTc3549KeptApprovalsRootTransition(undefined, row);
  validateTc3549KeptApprovalsRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3549KeptApprovalsRootTransition(undefined, changed)).toThrow("TC-3549");
    expect(() => validateLedger({ ...ledger, tc3549KeptApprovalsRoot: changed })).toThrow("TC-3549");
  }

  expect(() => validateTc3549KeptApprovalsRootTransition(row, undefined)).toThrow("TC-3549");
  expect(() => validateLedger({ ...ledger, tc2490OneApprovalRoot: undefined })).toThrow("TC-3549");
});
