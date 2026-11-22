import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3443GenericManifestRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3443GenericManifestRootTransition,
} from "./replica-size-policy";

test("TC-3443 records the exact canonical CI root bytes of #1099 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3443GenericManifestRoot;
  const predecessor = ledger.tc3661ShareLinkHostRoot;
  expect(row).toEqual(approvedTc3443GenericManifestRoot);
  expect(row.base).toBe("628be3c4bd1c633bb7f676f6c32c761cf8b596df");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44920526454",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44920526454/job/136895343968",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44920526454/job/136895344270",
    ],
  });
  expect(row.sourceCommits).toEqual(["db9325c21d1377ed0f6b57b3e066b7be5c51862b"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1530462, "index.cjs": 1463148 });
  expect(row.root.delta).toEqual({ "index.mjs": 409, "index.cjs": 151 });

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

test("TC-3443 refuses mutation, removal, or a missing TC-3661 predecessor", () => {
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
  expect(() => validateLedger({ ...ledger, tc3661ShareLinkHostRoot: undefined })).toThrow("TC-3443");
});
