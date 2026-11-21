import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3172DelegateNotBeforeRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3172DelegateNotBeforeRootTransition,
} from "./replica-size-policy";

test("TC-3172 records the exact canonical CI root bytes of #1025 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3172DelegateNotBeforeRoot;
  const predecessor = ledger.tc3168V1DefaultNodeRoot;
  expect(row).toEqual(approvedTc3172DelegateNotBeforeRoot);
  expect(row.base).toBe("875e26acdc1444d4f1c144efbf692d68c8ba2cb8");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44165332811",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44165332811/job/134329745596",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44165332811/job/134329747802",
    ],
  });
  expect(row.sourceCommits).toEqual(["0fab85aac8cf09b4bace5c3460b0788c1d6de980"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1526263, "index.cjs": 1460677 });
  expect(row.root.delta).toEqual({ "index.mjs": 173, "index.cjs": 160 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor({ ...ledger, tc3194NativeShareLinksRoot: undefined, tc3243SdkOwnsBusyRetryRoot: undefined, tc3285SecretTypesRoot: undefined, tc3286ShareNoDelegationActionsRoot: undefined, tc2944VaultPathClassifierRoot: undefined, tc3448OnBehalfPromptRoot: undefined, tc2490OneApprovalRoot: undefined, tc3704OpenKeyPromptRoot: undefined }, format)).toEqual({ row: "tc3172DelegateNotBeforeRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3172DelegateNotBeforeRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3172 refuses mutation, removal, or a missing TC-3168 predecessor", () => {
  const row = ledger.tc3172DelegateNotBeforeRoot;
  validateTc3172DelegateNotBeforeRootTransition(undefined, row);
  validateTc3172DelegateNotBeforeRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3172DelegateNotBeforeRootTransition(undefined, changed)).toThrow("TC-3172");
    expect(() => validateLedger({ ...ledger, tc3172DelegateNotBeforeRoot: changed })).toThrow("TC-3172");
  }

  expect(() => validateTc3172DelegateNotBeforeRootTransition(row, undefined)).toThrow("TC-3172");
  expect(() => validateLedger({ ...ledger, tc3168V1DefaultNodeRoot: undefined })).toThrow("TC-3172");
});
