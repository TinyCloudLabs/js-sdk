import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3168V1DefaultNodeRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3168V1DefaultNodeRootTransition,
} from "./replica-size-policy";

test("TC-3168 records the exact canonical CI root bytes of #1024 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3168V1DefaultNodeRoot;
  const predecessor = ledger.tc3076ChildExpiryRoot;
  expect(row).toEqual(approvedTc3168V1DefaultNodeRoot);
  expect(row.base).toBe("d8f2d10a36fb4ebe201ae33d27b21ff39cbc24e5");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44135735800",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44135735800/job/134224638801",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44135735800/job/134224638829",
    ],
  });
  expect(row.sourceCommits).toEqual(["47ea08a52142a303152d38c290f2361f763f3e8e"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1526090, "index.cjs": 1460517 });
  expect(row.root.delta).toEqual({ "index.mjs": 124, "index.cjs": 198 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor({ ...ledger, tc3172DelegateNotBeforeRoot: undefined, tc3194NativeShareLinksRoot: undefined }, format)).toEqual({ row: "tc3168V1DefaultNodeRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3168V1DefaultNodeRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3168 refuses mutation, removal, or a missing TC-3076 predecessor", () => {
  const row = ledger.tc3168V1DefaultNodeRoot;
  validateTc3168V1DefaultNodeRootTransition(undefined, row);
  validateTc3168V1DefaultNodeRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3168V1DefaultNodeRootTransition(undefined, changed)).toThrow("TC-3168");
    expect(() => validateLedger({ ...ledger, tc3168V1DefaultNodeRoot: changed })).toThrow("TC-3168");
  }

  expect(() => validateTc3168V1DefaultNodeRootTransition(row, undefined)).toThrow("TC-3168");
  expect(() => validateLedger({ ...ledger, tc3076ChildExpiryRoot: undefined })).toThrow("TC-3168");
});
