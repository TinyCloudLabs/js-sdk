import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3285SecretTypesRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3285SecretTypesRootTransition,
} from "./replica-size-policy";

test("TC-3285 records the exact canonical CI root bytes of #1042 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3285SecretTypesRoot;
  const predecessor = ledger.tc3243SdkOwnsBusyRetryRoot;
  expect(row).toEqual(approvedTc3285SecretTypesRoot);
  expect(row.base).toBe("b758e712acf147bc3b2f801418b78c3bea4bf917");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44376412165",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44376412165/job/135056649418",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44376412165/job/135056650074",
    ],
  });
  expect(row.sourceCommits).toEqual(["342ac278df3699db027e0ab54ae2340d3d05f3b5"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1528836, "index.cjs": 1462292 });
  expect(row.root.delta).toEqual({ "index.mjs": 227, "index.cjs": 219 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor({ ...ledger, tc3286ShareNoDelegationActionsRoot: undefined, tc2944VaultPathClassifierRoot: undefined, tc3448OnBehalfPromptRoot: undefined, tc2490OneApprovalRoot: undefined, tc3731ManifestOwnerRoot: undefined }, format)).toEqual({ row: "tc3285SecretTypesRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3285SecretTypesRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3285 refuses mutation, removal, or a missing TC-3243 predecessor", () => {
  const row = ledger.tc3285SecretTypesRoot;
  validateTc3285SecretTypesRootTransition(undefined, row);
  validateTc3285SecretTypesRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3285SecretTypesRootTransition(undefined, changed)).toThrow("TC-3285");
    expect(() => validateLedger({ ...ledger, tc3285SecretTypesRoot: changed })).toThrow("TC-3285");
  }

  expect(() => validateTc3285SecretTypesRootTransition(row, undefined)).toThrow("TC-3285");
  expect(() => validateLedger({ ...ledger, tc3243SdkOwnsBusyRetryRoot: undefined })).toThrow("TC-3285");
});
