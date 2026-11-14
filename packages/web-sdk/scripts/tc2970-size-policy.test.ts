import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2970RegistryVerdictCacheRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc2970RegistryVerdictCacheRootTransition,
} from "./replica-size-policy";

test("TC-2970 records the exact canonical CI root bytes within its 150-byte caps", () => {
  validateLedger(ledger);
  const row = ledger.tc2970RegistryVerdictCacheRoot;
  const predecessor = ledger.tc2949PanelChunkRecoveryRoot;
  expect(row).toEqual(approvedTc2970RegistryVerdictCacheRoot);
  expect(row.base).toBe("efb14e603ba4a49c4bb70690a4c501295e2292cf");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43469342097",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43469342097/job/132036794375",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43469342097/job/132036794928",
    ],
  });
  expect(row.sourceCommits).toEqual(["e04620cbd235645a02b55cf077efcaa2e7381fdf"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1524295, "index.cjs": 1458732 });
  expect(row.root.delta).toEqual({ "index.mjs": 127, "index.cjs": 86 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(150);
    expect(rootCeilingFor({ ...ledger, tc2913OpenKeyContinuationRoot: undefined, tc2987RegistryAbsentReadsRoot: undefined, tc2937SharePlacementRoot: undefined, tc2927ShareApprovalRoot: undefined }, format)).toEqual({ row: "tc2970RegistryVerdictCacheRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc2970RegistryVerdictCacheRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-2970 refuses mutation, removal, or a missing TC-2949 predecessor", () => {
  const row = ledger.tc2970RegistryVerdictCacheRoot;
  validateTc2970RegistryVerdictCacheRootTransition(undefined, row);
  validateTc2970RegistryVerdictCacheRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2970RegistryVerdictCacheRootTransition(undefined, changed)).toThrow("TC-2970");
    expect(() => validateLedger({ ...ledger, tc2970RegistryVerdictCacheRoot: changed })).toThrow("TC-2970");
  }

  expect(() => validateTc2970RegistryVerdictCacheRootTransition(row, undefined)).toThrow("TC-2970");
  expect(() => validateLedger({ ...ledger, tc2949PanelChunkRecoveryRoot: undefined })).toThrow("TC-2970");
});
