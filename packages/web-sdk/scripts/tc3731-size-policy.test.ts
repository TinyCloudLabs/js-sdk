import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3731ManifestOwnerRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3731ManifestOwnerRootTransition,
} from "./replica-size-policy";

test("TC-3731 records the exact canonical CI root bytes of #1121 within the ruled +600/+500 cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3731ManifestOwnerRoot;
  const predecessor = ledger.tc2490OneApprovalRoot;
  expect(row).toEqual(approvedTc3731ManifestOwnerRoot);
  expect(row.base).toBe("cb3edeab4f66ae2fc7f84243c7b8fdc3a15fc812");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44959865721",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44959865721/job/137016147784",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44959865721/job/137016147621",
    ],
  });
  expect(row.sourceCommits).toEqual(["a877975473564b71c9999c885b353e10220a2924"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1530438, "index.cjs": 1463337 });
  expect(row.root.delta).toEqual({ "index.mjs": 580, "index.cjs": 488 });

  const cap = { "index.mjs": 600, "index.cjs": 500 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3731ManifestOwnerRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3731ManifestOwnerRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3731 refuses mutation, removal, or a missing TC-2490 predecessor", () => {
  const row = ledger.tc3731ManifestOwnerRoot;
  validateTc3731ManifestOwnerRootTransition(undefined, row);
  validateTc3731ManifestOwnerRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3731ManifestOwnerRootTransition(undefined, changed)).toThrow("TC-3731");
    expect(() => validateLedger({ ...ledger, tc3731ManifestOwnerRoot: changed })).toThrow("TC-3731");
  }

  expect(() => validateTc3731ManifestOwnerRootTransition(row, undefined)).toThrow("TC-3731");
  expect(() => validateLedger({ ...ledger, tc2490OneApprovalRoot: undefined })).toThrow("TC-3731");
});
