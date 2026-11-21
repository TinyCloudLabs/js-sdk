import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3194NativeShareLinksRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3194NativeShareLinksRootTransition,
} from "./replica-size-policy";

// Naomi's TC-3194 policy review approved about 2.2 KB of root growth per format for native share links.
const APPROVED_GROWTH = 2200;

test("TC-3194 records the exact canonical CI root bytes of #1033 within the approved growth", () => {
  validateLedger(ledger);
  const row = ledger.tc3194NativeShareLinksRoot;
  const predecessor = ledger.tc3172DelegateNotBeforeRoot;
  expect(row).toEqual(approvedTc3194NativeShareLinksRoot);
  expect(row.base).toBe("0b5a6bc84b7c3e3fdbd9f392d009ca1e08e42d1f");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44203379707",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44203379707/job/134462959549",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44203379707/job/134462959979",
    ],
  });
  expect(row.sourceCommits).toEqual(["ffa4b6a082609de3b57cedf4d747fad2e2f5d253"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1528459, "index.cjs": 1461965 });
  expect(row.root.delta).toEqual({ "index.mjs": 2196, "index.cjs": 1288 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(APPROVED_GROWTH);
    expect(rootCeilingFor({ ...ledger, tc3243SdkOwnsBusyRetryRoot: undefined, tc3285SecretTypesRoot: undefined, tc3286ShareNoDelegationActionsRoot: undefined, tc2944VaultPathClassifierRoot: undefined, tc3448OnBehalfPromptRoot: undefined, tc2490OneApprovalRoot: undefined, tc3688AccountIndexGuardRoot: undefined }, format)).toEqual({ row: "tc3194NativeShareLinksRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3194NativeShareLinksRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3194 refuses mutation, removal, or a missing TC-3172 predecessor", () => {
  const row = ledger.tc3194NativeShareLinksRoot;
  validateTc3194NativeShareLinksRootTransition(undefined, row);
  validateTc3194NativeShareLinksRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.mjs"]++; },
    (value: typeof row) => { value.root.delta["index.cjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[1] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3194NativeShareLinksRootTransition(undefined, changed)).toThrow("TC-3194");
    expect(() => validateLedger({ ...ledger, tc3194NativeShareLinksRoot: changed })).toThrow("TC-3194");
  }

  expect(() => validateTc3194NativeShareLinksRootTransition(row, undefined)).toThrow("TC-3194");
  expect(() => validateLedger({ ...ledger, tc3172DelegateNotBeforeRoot: undefined })).toThrow("TC-3194");
});
