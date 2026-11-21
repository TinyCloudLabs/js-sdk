import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3688AccountIndexGuardRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3688AccountIndexGuardRootTransition,
} from "./replica-size-policy";

test("TC-3688 records the exact canonical CI root bytes of #1116 within the ruled +150/+150 cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3688AccountIndexGuardRoot;
  const predecessor = ledger.tc2490OneApprovalRoot;
  expect(row).toEqual(approvedTc3688AccountIndexGuardRoot);
  expect(row.base).toBe("cb3edeab4f66ae2fc7f84243c7b8fdc3a15fc812");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44934457098",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44934457098/job/136937986659",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44934457098/job/136937986698",
    ],
  });
  expect(row.sourceCommits).toEqual(["5cf63dddaa8aa4eaf98d75d01133f4e6c63f3c9f"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1529972, "index.cjs": 1462961 });
  expect(row.root.delta).toEqual({ "index.mjs": 114, "index.cjs": 112 });

  const cap = { "index.mjs": 150, "index.cjs": 150 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3688AccountIndexGuardRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3688AccountIndexGuardRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3688 refuses mutation, removal, or a missing TC-2490 predecessor", () => {
  const row = ledger.tc3688AccountIndexGuardRoot;
  validateTc3688AccountIndexGuardRootTransition(undefined, row);
  validateTc3688AccountIndexGuardRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3688AccountIndexGuardRootTransition(undefined, changed)).toThrow("TC-3688");
    expect(() => validateLedger({ ...ledger, tc3688AccountIndexGuardRoot: changed })).toThrow("TC-3688");
  }

  expect(() => validateTc3688AccountIndexGuardRootTransition(row, undefined)).toThrow("TC-3688");
  expect(() => validateLedger({ ...ledger, tc2490OneApprovalRoot: undefined })).toThrow("TC-3688");
});
