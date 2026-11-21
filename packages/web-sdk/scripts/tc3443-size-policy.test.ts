import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3443GenericManifestRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3443GenericManifestRootTransition,
} from "./replica-size-policy";

test("TC-3443 records the root bytes of #1099 over the TC-2490 ceilings within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3443GenericManifestRoot;
  const predecessor = ledger.tc2490OneApprovalRoot;
  expect(row).toEqual(approvedTc3443GenericManifestRoot);
  expect(row.base).toBe("cb3edeab4f66ae2fc7f84243c7b8fdc3a15fc812");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44595739813",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44595739813/job/135813379736",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44595739813/job/135813379768",
    ],
  });
  expect(row.sourceCommits).toEqual(["e3fcc84e40eb72c0fed6a716ce40c42d40d5424d"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1530264, "index.cjs": 1462998 });
  expect(row.root.delta).toEqual({ "index.mjs": 406, "index.cjs": 149 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3443GenericManifestRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3443GenericManifestRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3443 refuses mutation, removal, or a missing TC-2490 predecessor", () => {
  const row = ledger.tc3443GenericManifestRoot;
  validateTc3443GenericManifestRootTransition(undefined, row);
  validateTc3443GenericManifestRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3443GenericManifestRootTransition(undefined, changed)).toThrow("TC-3443");
    expect(() => validateLedger({ ...ledger, tc3443GenericManifestRoot: changed })).toThrow("TC-3443");
  }

  expect(() => validateTc3443GenericManifestRootTransition(row, undefined)).toThrow("TC-3443");
  expect(() => validateLedger({ ...ledger, tc2490OneApprovalRoot: undefined })).toThrow("TC-3443");
});
