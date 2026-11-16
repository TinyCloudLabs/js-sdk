import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3076ChildExpiryRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3076ChildExpiryRootTransition,
} from "./replica-size-policy";

test("TC-3076 records the exact canonical CI root bytes of #993 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3076ChildExpiryRoot;
  const predecessor = ledger.tc3030FirstPartyOriginsRoot;
  expect(row).toEqual(approvedTc3076ChildExpiryRoot);
  expect(row.base).toBe("ef1c9d3b4c628ad6214e3e10e3ed18d21f90bda2");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43780256449",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43780256449/job/133015588807",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43780256449/job/133015588980",
    ],
  });
  expect(row.sourceCommits).toEqual(["711903b39d7ac6ba79b35bb788603d51c7f1d71b"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1525966, "index.cjs": 1460319 });
  expect(row.root.delta).toEqual({ "index.mjs": 76, "index.cjs": 0 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3076ChildExpiryRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3076ChildExpiryRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3076 refuses mutation, removal, or a missing TC-3030 predecessor", () => {
  const row = ledger.tc3076ChildExpiryRoot;
  validateTc3076ChildExpiryRootTransition(undefined, row);
  validateTc3076ChildExpiryRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3076ChildExpiryRootTransition(undefined, changed)).toThrow("TC-3076");
    expect(() => validateLedger({ ...ledger, tc3076ChildExpiryRoot: changed })).toThrow("TC-3076");
  }

  expect(() => validateTc3076ChildExpiryRootTransition(row, undefined)).toThrow("TC-3076");
  expect(() => validateLedger({ ...ledger, tc3030FirstPartyOriginsRoot: undefined })).toThrow("TC-3076");
});
