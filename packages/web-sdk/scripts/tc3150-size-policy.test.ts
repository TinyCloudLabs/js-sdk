import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3150GiveBackRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3150GiveBackRootTransition,
} from "./replica-size-policy";

test("TC-3150 records the exact canonical CI root bytes of #1049 at the amended size ruling", () => {
  validateLedger(ledger);
  const row = ledger.tc3150GiveBackRoot;
  const predecessor = ledger.tc2944VaultPathClassifierRoot;
  expect(row).toEqual(approvedTc3150GiveBackRoot);
  expect(row.base).toBe("78bae2491801a06bc0daa8e0d0eea8d106235f2a");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44543546508",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44543546508/job/135627930773",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44543546508/job/135627931693",
    ],
  });
  expect(row.sourceCommits).toEqual(["99a8bdf1a956d69ec7cc53a7c6a110737d4f75e8"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1530243, "index.cjs": 1463187 });
  expect(row.root.delta).toEqual({ "index.mjs": 618, "index.cjs": 574 });
  expect(row.ruling).toContain("Size ruling amended: cjs allowance up to +574 B over tc2944 (CI-measured 1463187), mjs +618 (within +700).");

  // Amended ruling: up to +700 B (mjs) and +574 B (cjs) over the then-newest ceiling.
  const cap = { "index.mjs": 700, "index.cjs": 574 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3150GiveBackRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3150GiveBackRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3150 refuses mutation, removal, or a missing TC-2944 predecessor", () => {
  const row = ledger.tc3150GiveBackRoot;
  validateTc3150GiveBackRootTransition(undefined, row);
  validateTc3150GiveBackRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3150GiveBackRootTransition(undefined, changed)).toThrow("TC-3150");
    expect(() => validateLedger({ ...ledger, tc3150GiveBackRoot: changed })).toThrow("TC-3150");
  }

  expect(() => validateTc3150GiveBackRootTransition(row, undefined)).toThrow("TC-3150");
  expect(() => validateLedger({ ...ledger, tc2944VaultPathClassifierRoot: undefined })).toThrow("TC-3150");
});
