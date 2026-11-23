import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3801NamedKeysRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3801NamedKeysRootTransition,
} from "./replica-size-policy";

test("TC-3801 records the exact canonical CI root bytes of #1131", () => {
  validateLedger(ledger);
  const row = ledger.tc3801NamedKeysRoot;
  const predecessor = ledger.tc3617HostedMcpLeaseRoot;
  expect(row).toEqual(approvedTc3801NamedKeysRoot);
  expect(row.base).toBe("3ad8bb80e3b3b1f2342f4663cfe72f0ecd881093");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45097259831",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45097259831/job/137439719432",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45097259831/job/137439719260",
    ],
  });
  expect(row.sourceCommits).toEqual(["d8948e01ba76d5cfd3081ac28704a76f15163769"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1539288, "index.cjs": 1471246 });
  expect(row.root.delta).toEqual({ "index.mjs": 3804, "index.cjs": 4343 });

  // The ruling lifts the per-row byte cap for this row: the delta is exactly CI's.
  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3801NamedKeysRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3801NamedKeysRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3801 refuses mutation, removal, or a missing TC-3617 predecessor", () => {
  const row = ledger.tc3801NamedKeysRoot;
  validateTc3801NamedKeysRootTransition(undefined, row);
  validateTc3801NamedKeysRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3801NamedKeysRootTransition(undefined, changed)).toThrow("TC-3801");
    expect(() => validateLedger({ ...ledger, tc3801NamedKeysRoot: changed })).toThrow("TC-3801");
  }

  expect(() => validateTc3801NamedKeysRootTransition(row, undefined)).toThrow("TC-3801");
  expect(() => validateLedger({ ...ledger, tc3617HostedMcpLeaseRoot: undefined })).toThrow("TC-3801");
});
