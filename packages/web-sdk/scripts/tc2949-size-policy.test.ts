import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2949PanelChunkRecoveryRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc2949PanelChunkRecoveryRootTransition,
} from "./replica-size-policy";

test("TC-2949 records the exact canonical CI root bytes within its 150-byte caps", () => {
  validateLedger(ledger);
  const row = ledger.tc2949PanelChunkRecoveryRoot;
  const predecessor = ledger.tc2936RestoreCommitRoot;
  expect(row).toEqual(approvedTc2949PanelChunkRecoveryRoot);
  expect(row.canonicalCI).toEqual({
    run: "43431216924",
    jobs: ["131904909994", "131904909601"],
  });
  expect(row.base).toBe("c85d10f17dfce15fddb1a7ad8544487467dbb2db");
  expect(row.sourceCommits).toEqual(["810d13f02e104b9cc50affa64faed9870e36b876"]);

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(150);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc2949PanelChunkRecoveryRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc2949PanelChunkRecoveryRoot",
    pin: row.sourceCommits[0],
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-2949 refuses mutation, removal, or a missing TC-2934 predecessor", () => {
  const row = ledger.tc2949PanelChunkRecoveryRoot;
  validateTc2949PanelChunkRecoveryRootTransition(undefined, row);
  validateTc2949PanelChunkRecoveryRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2949PanelChunkRecoveryRootTransition(undefined, changed)).toThrow("TC-2949");
    expect(() => validateLedger({ ...ledger, tc2949PanelChunkRecoveryRoot: changed })).toThrow("TC-2949");
  }

  expect(() => validateTc2949PanelChunkRecoveryRootTransition(row, undefined)).toThrow("TC-2949");
  expect(() => validateLedger({ ...ledger, tc2936RestoreCommitRoot: undefined })).toThrow("TC-2949");
});
