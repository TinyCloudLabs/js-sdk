import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2913OpenKeyContinuationRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc2913OpenKeyContinuationRootTransition,
} from "./replica-size-policy";

test("TC-2913 records the exact canonical CI root bytes within its 800-byte caps", () => {
  validateLedger(ledger);
  const row = ledger.tc2913OpenKeyContinuationRoot;
  const predecessor = ledger.tc2970RegistryVerdictCacheRoot;
  expect(row).toEqual(approvedTc2913OpenKeyContinuationRoot);
  expect(row.base).toBe("c8e53a9aad80758dd3492c1714e40e6bd348c61b");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43486822245",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43486822245/job/132097360178",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43486822245/job/132097360229",
    ],
  });
  expect(row.sourceCommits).toEqual(["8219765ba399cbcc85630c2057cf913bb82dcb43"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1525060, "index.cjs": 1459418 });
  expect(row.root.delta).toEqual({ "index.mjs": 765, "index.cjs": 686 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc2913OpenKeyContinuationRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc2913OpenKeyContinuationRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-2913 refuses mutation, removal, or a missing TC-2970 predecessor", () => {
  const row = ledger.tc2913OpenKeyContinuationRoot;
  validateTc2913OpenKeyContinuationRootTransition(undefined, row);
  validateTc2913OpenKeyContinuationRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2913OpenKeyContinuationRootTransition(undefined, changed)).toThrow("TC-2913");
    expect(() => validateLedger({ ...ledger, tc2913OpenKeyContinuationRoot: changed })).toThrow("TC-2913");
  }

  expect(() => validateTc2913OpenKeyContinuationRootTransition(row, undefined)).toThrow("TC-2913");
  expect(() => validateLedger({ ...ledger, tc2970RegistryVerdictCacheRoot: undefined })).toThrow("TC-2913");
});
