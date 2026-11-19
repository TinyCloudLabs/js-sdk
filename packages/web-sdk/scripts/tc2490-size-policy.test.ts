import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2490OneApprovalRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc2490OneApprovalRootTransition,
} from "./replica-size-policy";

test("TC-2490 records the exact canonical CI root bytes of #1060 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc2490OneApprovalRoot;
  const predecessor = ledger.tc3285SecretTypesRoot;
  expect(row).toEqual(approvedTc2490OneApprovalRoot);
  expect(row.base).toBe("991ddb560d494e0b61424bff2b2c7e28541e522b");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44427965751",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44427965751/job/135237628667",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44427965751/job/135237628914",
    ],
  });
  expect(row.sourceCommits).toEqual(["e1c984268ec5c9082ac6ab0d5830dc6a483cd712"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1529015, "index.cjs": 1462451 });
  expect(row.root.delta).toEqual({ "index.mjs": 179, "index.cjs": 159 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc2490OneApprovalRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc2490OneApprovalRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-2490 refuses mutation, removal, or a missing TC-3285 predecessor", () => {
  const row = ledger.tc2490OneApprovalRoot;
  validateTc2490OneApprovalRootTransition(undefined, row);
  validateTc2490OneApprovalRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2490OneApprovalRootTransition(undefined, changed)).toThrow("TC-2490");
    expect(() => validateLedger({ ...ledger, tc2490OneApprovalRoot: changed })).toThrow("TC-2490");
  }

  expect(() => validateTc2490OneApprovalRootTransition(row, undefined)).toThrow("TC-2490");
  expect(() => validateLedger({ ...ledger, tc3285SecretTypesRoot: undefined })).toThrow("TC-2490");
});
