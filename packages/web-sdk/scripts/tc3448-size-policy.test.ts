import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3448OnBehalfPromptRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3448OnBehalfPromptRootTransition,
} from "./replica-size-policy";

test("TC-3448 records the exact canonical CI root bytes of #1095 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3448OnBehalfPromptRoot;
  const predecessor = ledger.tc2944VaultPathClassifierRoot;
  expect(row).toEqual(approvedTc3448OnBehalfPromptRoot);
  expect(row.base).toBe("c2f4cc7692286a9c84ac709bf22a5f148493c6cb");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44558524675",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44558524675/job/135681081190",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44558524675/job/135681081827",
    ],
  });
  expect(row.sourceCommits).toEqual(["8bfd1d1b8b996ecec278ef151c3ac0dab7c8e684"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1529672, "index.cjs": 1462669 });
  expect(row.root.delta).toEqual({ "index.mjs": 47, "index.cjs": 56 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor({ ...ledger, tc2490OneApprovalRoot: undefined, tc3704OpenKeyPromptRoot: undefined }, format)).toEqual({ row: "tc3448OnBehalfPromptRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3448OnBehalfPromptRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3448 refuses mutation, removal, or a missing TC-2944 predecessor", () => {
  const row = ledger.tc3448OnBehalfPromptRoot;
  validateTc3448OnBehalfPromptRootTransition(undefined, row);
  validateTc3448OnBehalfPromptRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3448OnBehalfPromptRootTransition(undefined, changed)).toThrow("TC-3448");
    expect(() => validateLedger({ ...ledger, tc3448OnBehalfPromptRoot: changed })).toThrow("TC-3448");
  }

  expect(() => validateTc3448OnBehalfPromptRootTransition(row, undefined)).toThrow("TC-3448");
  expect(() => validateLedger({ ...ledger, tc2944VaultPathClassifierRoot: undefined })).toThrow("TC-3448");
});
