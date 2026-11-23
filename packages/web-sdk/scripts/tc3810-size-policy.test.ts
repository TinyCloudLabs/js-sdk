import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3810DelegationModeRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3810DelegationModeRootTransition,
} from "./replica-size-policy";

test("TC-3810 records the exact canonical CI root bytes of #1140 within Naomi's 06:36Z size ruling", () => {
  validateLedger(ledger);
  const row = ledger.tc3810DelegationModeRoot;
  const predecessor = ledger.tc3947ReplicaRevokeRoot;
  expect(row).toEqual(approvedTc3810DelegationModeRoot);
  expect(row.base).toBe("7f6a8871de0759b95f16e3acfc377331df3b0fbb");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45123859871",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45123859871/job/137523596428",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45123859871/job/137523596694",
    ],
  });
  expect(row.sourceCommits).toEqual(["ee1b448de9b925641f6e68325b2af025ced7981a"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1536776, "index.cjs": 1468911 });
  expect(row.root.delta).toEqual({ "index.mjs": 1230, "index.cjs": 1958 });

  const cap = { "index.mjs": 2500, "index.cjs": 2500 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3810DelegationModeRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3810DelegationModeRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3810 refuses mutation, removal, or a missing TC-3947 predecessor", () => {
  const row = ledger.tc3810DelegationModeRoot;
  validateTc3810DelegationModeRootTransition(undefined, row);
  validateTc3810DelegationModeRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3810DelegationModeRootTransition(undefined, changed)).toThrow("TC-3810");
    expect(() => validateLedger({ ...ledger, tc3810DelegationModeRoot: changed })).toThrow("TC-3810");
  }

  expect(() => validateTc3810DelegationModeRootTransition(row, undefined)).toThrow("TC-3810");
  expect(() => validateLedger({ ...ledger, tc3947ReplicaRevokeRoot: undefined })).toThrow("TC-3810");
});
