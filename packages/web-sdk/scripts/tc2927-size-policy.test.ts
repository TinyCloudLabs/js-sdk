import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2927ShareApprovalRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc2927ShareApprovalRootTransition,
} from "./replica-size-policy";

test("TC-2927 records the exact canonical CI root bytes within its 1900-byte caps", () => {
  validateLedger(ledger);
  const row = ledger.tc2927ShareApprovalRoot;
  const predecessor = ledger.tc2970RegistryVerdictCacheRoot;
  expect(row).toEqual(approvedTc2927ShareApprovalRoot);
  expect(row.base).toBe("c8e53a9aad80758dd3492c1714e40e6bd348c61b");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43486972520",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43486972520/job/132097885469",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43486972520/job/132097885414",
    ],
  });
  expect(row.sourceCommits).toEqual(["238981e648c853c599f064bfb162d3b5153cc04b"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1526018, "index.cjs": 1460414 });
  expect(row.root.delta).toEqual({ "index.mjs": 1723, "index.cjs": 1682 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(1900);
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

test("TC-2927 refuses mutation, removal, or a missing TC-2970 predecessor", () => {
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
  expect(() => validateLedger({ ...ledger, tc2970RegistryVerdictCacheRoot: undefined })).toThrow("TC-2927");
});
