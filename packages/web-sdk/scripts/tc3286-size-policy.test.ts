import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3286ShareNoDelegationActionsRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3286ShareNoDelegationActionsRootTransition,
} from "./replica-size-policy";

test("TC-3286 records the exact canonical CI root bytes of #1043 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3286ShareNoDelegationActionsRoot;
  const predecessor = ledger.tc3285SecretTypesRoot;
  expect(row).toEqual(approvedTc3286ShareNoDelegationActionsRoot);
  expect(row.base).toBe("400cf7f1652d079abb5c8382736f9c2ba8c4cb6a");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44392278215",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44392278215/job/135112809282",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44392278215/job/135112809572",
    ],
  });
  expect(row.sourceCommits).toEqual(["800a57fbd0239558c5783d77c761b3132de2da31"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1528939, "index.cjs": 1462340 });
  expect(row.root.delta).toEqual({ "index.mjs": 103, "index.cjs": 48 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor({ ...ledger, tc2944VaultPathClassifierRoot: undefined, tc3448OnBehalfPromptRoot: undefined, tc2490OneApprovalRoot: undefined, tc3661ShareLinkHostRoot: undefined }, format)).toEqual({ row: "tc3286ShareNoDelegationActionsRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3286ShareNoDelegationActionsRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3286 refuses mutation, removal, or a missing TC-3285 predecessor", () => {
  const row = ledger.tc3286ShareNoDelegationActionsRoot;
  validateTc3286ShareNoDelegationActionsRootTransition(undefined, row);
  validateTc3286ShareNoDelegationActionsRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3286ShareNoDelegationActionsRootTransition(undefined, changed)).toThrow("TC-3286");
    expect(() => validateLedger({ ...ledger, tc3286ShareNoDelegationActionsRoot: changed })).toThrow("TC-3286");
  }

  expect(() => validateTc3286ShareNoDelegationActionsRootTransition(row, undefined)).toThrow("TC-3286");
  expect(() => validateLedger({ ...ledger, tc3285SecretTypesRoot: undefined })).toThrow("TC-3286");
});
