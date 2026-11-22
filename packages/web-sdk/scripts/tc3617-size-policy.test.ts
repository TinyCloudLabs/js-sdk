import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3617HostedMcpLeaseRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3617HostedMcpLeaseRootTransition,
} from "./replica-size-policy";

test("TC-3617 records the exact canonical CI root bytes of #1122 within the ruled +100/+100 cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3617HostedMcpLeaseRoot;
  const predecessor = ledger.tc2490OneApprovalRoot;
  expect(row).toEqual(approvedTc3617HostedMcpLeaseRoot);
  expect(row.base).toBe("cb3edeab4f66ae2fc7f84243c7b8fdc3a15fc812");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44978134650",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44978134650/job/137072507863",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44978134650/job/137072507943",
    ],
  });
  expect(row.sourceCommits).toEqual(["1ab6415b039523393580e9c40af71e466fd90959"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1529920, "index.cjs": 1462864 });
  expect(row.root.delta).toEqual({ "index.mjs": 62, "index.cjs": 15 });

  const cap = { "index.mjs": 100, "index.cjs": 100 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor({ ...ledger, tc3617SliceCRoot: undefined }, format)).toEqual({ row: "tc3617HostedMcpLeaseRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3617HostedMcpLeaseRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3617 refuses mutation, removal, or a missing TC-2490 predecessor", () => {
  const row = ledger.tc3617HostedMcpLeaseRoot;
  validateTc3617HostedMcpLeaseRootTransition(undefined, row);
  validateTc3617HostedMcpLeaseRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3617HostedMcpLeaseRootTransition(undefined, changed)).toThrow("TC-3617");
    expect(() => validateLedger({ ...ledger, tc3617HostedMcpLeaseRoot: changed })).toThrow("TC-3617");
  }

  expect(() => validateTc3617HostedMcpLeaseRootTransition(row, undefined)).toThrow("TC-3617");
  expect(() => validateLedger({ ...ledger, tc2490OneApprovalRoot: undefined })).toThrow("TC-3617");
});
