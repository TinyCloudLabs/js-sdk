import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3617ScopedGrantLeaseRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3617ScopedGrantLeaseRootTransition,
} from "./replica-size-policy";

test("TC-3617 scoped grant lease records the exact canonical CI root bytes of #1125 within the ruled +600/+450 cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3617ScopedGrantLeaseRoot;
  const predecessor = ledger.tc3617HostedMcpLeaseRoot;
  expect(row).toEqual(approvedTc3617ScopedGrantLeaseRoot);
  expect(row.base).toBe("cb3edeab4f66ae2fc7f84243c7b8fdc3a15fc812");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44981511729",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44981511729/job/137082806081",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44981511729/job/137082806076",
    ],
  });
  expect(row.sourceCommits).toEqual(["65212d5121b49af93b85938ed9aa6d423017875d"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1530404, "index.cjs": 1463216 });
  expect(row.root.delta).toEqual({ "index.mjs": 484, "index.cjs": 352 });

  const cap = { "index.mjs": 600, "index.cjs": 450 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3617ScopedGrantLeaseRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3617ScopedGrantLeaseRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3617 scoped grant lease refuses mutation, removal, or a missing TC-3617 hosted MCP lease predecessor", () => {
  const row = ledger.tc3617ScopedGrantLeaseRoot;
  validateTc3617ScopedGrantLeaseRootTransition(undefined, row);
  validateTc3617ScopedGrantLeaseRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3617ScopedGrantLeaseRootTransition(undefined, changed)).toThrow("TC-3617 scoped grant lease");
    expect(() => validateLedger({ ...ledger, tc3617ScopedGrantLeaseRoot: changed })).toThrow("TC-3617 scoped grant lease");
  }

  expect(() => validateTc3617ScopedGrantLeaseRootTransition(row, undefined)).toThrow("TC-3617 scoped grant lease");
  expect(() => validateLedger({ ...ledger, tc3617HostedMcpLeaseRoot: undefined })).toThrow("TC-3617 scoped grant lease");
});
