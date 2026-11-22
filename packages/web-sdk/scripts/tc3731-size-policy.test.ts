import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3731ManifestOwnerRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3731ManifestOwnerRootTransition,
} from "./replica-size-policy";

test("TC-3731 records the exact canonical CI root bytes of #1121 within the ruled +615/+511 cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3731ManifestOwnerRoot;
  const predecessor = ledger.tc3704OpenKeyPromptRoot;
  expect(row).toEqual(approvedTc3731ManifestOwnerRoot);
  expect(row.base).toBe("895bfdc72d6d4e70f5bac72f39b373e2195e7dcd");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45078405861",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45078405861/job/137380725081",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45078405861/job/137380725327",
    ],
  });
  expect(row.sourceCommits).toEqual(["a877975473564b71c9999c885b353e10220a2924"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1534530, "index.cjs": 1466077 });
  expect(row.root.delta).toEqual({ "index.mjs": 615, "index.cjs": 511 });

  const cap = { "index.mjs": 615, "index.cjs": 511 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor({ ...ledger, tc3443AppIdLineBreakRoot: undefined }, format)).toEqual({ row: "tc3731ManifestOwnerRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3731ManifestOwnerRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3731 refuses mutation, removal, or a missing TC-3704 predecessor", () => {
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
  expect(() => validateLedger({ ...ledger, tc3704OpenKeyPromptRoot: undefined })).toThrow("TC-3731");
});
