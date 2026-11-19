import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2923TeeDefaultRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc2923TeeDefaultRootTransition,
} from "./replica-size-policy";

test("TC-2923 records the exact canonical CI root bytes of #1094 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc2923TeeDefaultRoot;
  const predecessor = ledger.tc2944VaultPathClassifierRoot;
  expect(row).toEqual(approvedTc2923TeeDefaultRoot);
  expect(row.base).toBe("c2f4cc7692286a9c84ac709bf22a5f148493c6cb");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44558226823",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44558226823/job/135680024564",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44558226823/job/135680024583",
    ],
  });
  expect(row.sourceCommits).toEqual(["66af525c34419e75cf08cf721d6ed20cd1ea1e41"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1529638, "index.cjs": 1462613 });
  expect(row.root.delta).toEqual({ "index.mjs": 13, "index.cjs": 0 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc2923TeeDefaultRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc2923TeeDefaultRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-2923 refuses mutation, removal, or a missing TC-2944 predecessor", () => {
  const row = ledger.tc2923TeeDefaultRoot;
  validateTc2923TeeDefaultRootTransition(undefined, row);
  validateTc2923TeeDefaultRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.mjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2923TeeDefaultRootTransition(undefined, changed)).toThrow("TC-2923");
    expect(() => validateLedger({ ...ledger, tc2923TeeDefaultRoot: changed })).toThrow("TC-2923");
  }

  expect(() => validateTc2923TeeDefaultRootTransition(row, undefined)).toThrow("TC-2923");
  expect(() => validateLedger({ ...ledger, tc2944VaultPathClassifierRoot: undefined })).toThrow("TC-2923");
});
