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
  const predecessor = ledger.tc3243SdkOwnsBusyRetryRoot;
  expect(row).toEqual(approvedTc3286ShareNoDelegationActionsRoot);
  expect(row.base).toBe("ae9a23c95d5ca18849304cd9760041001a56e839");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44378559074",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44378559074/job/135064193515",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44378559074/job/135064193589",
    ],
  });
  expect(row.sourceCommits).toEqual(["a67014792ba4a81d5e4a5a6414403a5cec86e0f9"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1528725, "index.cjs": 1462133 });
  expect(row.root.delta).toEqual({ "index.mjs": 116, "index.cjs": 60 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3286ShareNoDelegationActionsRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3286ShareNoDelegationActionsRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3286 refuses mutation, removal, or a missing TC-3243 predecessor", () => {
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
  expect(() => validateLedger({ ...ledger, tc3243SdkOwnsBusyRetryRoot: undefined })).toThrow("TC-3286");
});
