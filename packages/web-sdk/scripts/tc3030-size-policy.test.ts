import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3030FirstPartyOriginsRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3030FirstPartyOriginsRootTransition,
} from "./replica-size-policy";

test("TC-3030 records the exact canonical CI root bytes of #987 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3030FirstPartyOriginsRoot;
  const predecessor = ledger.tc2937SharePlacementRoot;
  expect(row).toEqual(approvedTc3030FirstPartyOriginsRoot);
  expect(row.base).toBe("37d930ec31806b28ff83f0801bd35308d73a9e6d");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43575663539",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43575663539/job/132389214068",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43575663539/job/132389213878",
    ],
  });
  expect(row.sourceCommits).toEqual(["a7b59fa11333d7efa65a9993f3ebb026c47baf76"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1525890, "index.cjs": 1460319 });
  expect(row.root.delta).toEqual({ "index.mjs": 12, "index.cjs": 0 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor({ ...ledger, tc3076ChildExpiryRoot: undefined, tc3168V1DefaultNodeRoot: undefined, tc3172DelegateNotBeforeRoot: undefined, tc3194NativeShareLinksRoot: undefined, tc3243SdkOwnsBusyRetryRoot: undefined, tc3285SecretTypesRoot: undefined, tc3286ShareNoDelegationActionsRoot: undefined, tc3284PerSecretRoot: undefined }, format)).toEqual({ row: "tc3030FirstPartyOriginsRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3030FirstPartyOriginsRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3030 refuses mutation, removal, or a missing TC-2937 predecessor", () => {
  const row = ledger.tc3030FirstPartyOriginsRoot;
  validateTc3030FirstPartyOriginsRootTransition(undefined, row);
  validateTc3030FirstPartyOriginsRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3030FirstPartyOriginsRootTransition(undefined, changed)).toThrow("TC-3030");
    expect(() => validateLedger({ ...ledger, tc3030FirstPartyOriginsRoot: changed })).toThrow("TC-3030");
  }

  expect(() => validateTc3030FirstPartyOriginsRootTransition(row, undefined)).toThrow("TC-3030");
  expect(() => validateLedger({ ...ledger, tc2937SharePlacementRoot: undefined })).toThrow("TC-3030");
});
