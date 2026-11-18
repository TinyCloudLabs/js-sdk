import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3243SdkOwnsBusyRetryRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3243SdkOwnsBusyRetryRootTransition,
} from "./replica-size-policy";

test("TC-3243 records the exact canonical CI root bytes of #1038 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3243SdkOwnsBusyRetryRoot;
  const predecessor = ledger.tc3172DelegateNotBeforeRoot;
  expect(row).toEqual(approvedTc3243SdkOwnsBusyRetryRoot);
  expect(row.base).toBe("0b5a6bc84b7c3e3fdbd9f392d009ca1e08e42d1f");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44205168251",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44205168251/job/134469120955",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44205168251/job/134469121387",
    ],
  });
  expect(row.sourceCommits).toEqual(["c858367f361bd777ee154cb084114956bbf68729"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1526387, "index.cjs": 1460789 });
  expect(row.root.delta).toEqual({ "index.mjs": 124, "index.cjs": 112 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3243SdkOwnsBusyRetryRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3243SdkOwnsBusyRetryRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3243 refuses mutation, removal, or a missing TC-3172 predecessor", () => {
  const row = ledger.tc3243SdkOwnsBusyRetryRoot;
  validateTc3243SdkOwnsBusyRetryRootTransition(undefined, row);
  validateTc3243SdkOwnsBusyRetryRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3243SdkOwnsBusyRetryRootTransition(undefined, changed)).toThrow("TC-3243");
    expect(() => validateLedger({ ...ledger, tc3243SdkOwnsBusyRetryRoot: changed })).toThrow("TC-3243");
  }

  expect(() => validateTc3243SdkOwnsBusyRetryRootTransition(row, undefined)).toThrow("TC-3243");
  expect(() => validateLedger({ ...ledger, tc3172DelegateNotBeforeRoot: undefined })).toThrow("TC-3243");
});
