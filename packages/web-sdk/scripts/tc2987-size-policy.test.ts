import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2987RegistryAbsentReadsRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc2987RegistryAbsentReadsRootTransition,
} from "./replica-size-policy";

test("TC-2987 records the exact canonical CI root bytes within its 250-byte caps", () => {
  validateLedger(ledger);
  const row = ledger.tc2987RegistryAbsentReadsRoot;
  const predecessor = ledger.tc2913OpenKeyContinuationRoot;
  expect(row).toEqual(approvedTc2987RegistryAbsentReadsRoot);
  expect(row.base).toBe("d681e85871e34840720e2474d9091544fca4618e");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43495495915",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43495495915/job/132127386304",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43495495915/job/132127386521",
    ],
  });
  expect(row.sourceCommits).toEqual(["f6d8a996585de94ee708e6b838b2ce8b7e74b34e"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1525175, "index.cjs": 1459629 });
  expect(row.root.delta).toEqual({ "index.mjs": 115, "index.cjs": 211 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(250);
    expect(rootCeilingFor({ ...ledger, tc2937SharePlacementRoot: undefined, tc2927ShareApprovalRoot: undefined }, format)).toEqual({ row: "tc2987RegistryAbsentReadsRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc2987RegistryAbsentReadsRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-2987 refuses mutation, removal, or a missing TC-2913 predecessor", () => {
  const row = ledger.tc2987RegistryAbsentReadsRoot;
  validateTc2987RegistryAbsentReadsRootTransition(undefined, row);
  validateTc2987RegistryAbsentReadsRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2987RegistryAbsentReadsRootTransition(undefined, changed)).toThrow("TC-2987");
    expect(() => validateLedger({ ...ledger, tc2987RegistryAbsentReadsRoot: changed })).toThrow("TC-2987");
  }

  expect(() => validateTc2987RegistryAbsentReadsRootTransition(row, undefined)).toThrow("TC-2987");
  expect(() => validateLedger({ ...ledger, tc2913OpenKeyContinuationRoot: undefined })).toThrow("TC-2987");
});
