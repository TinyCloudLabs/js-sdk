import { expect, test } from "bun:test";
import ledgerWithTc2927 from "./replica-size-ledger.json";
const ledger = structuredClone(ledgerWithTc2927);
delete ledger.tc2927ShareApprovalRoot;
import { approvedTc2936RestoreCommitRoot, ancestryPins, rootCeilingFor, validateLedger, validateTc2936RestoreCommitRootTransition } from "./replica-size-policy";

test("TC-2936 admits only its exact canonical root bytes over TC-2934", () => {
  validateLedger(ledger);
  const row = ledger.tc2936RestoreCommitRoot;
  expect(row).toEqual(approvedTc2936RestoreCommitRoot);
  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - ledger.tc2934RequestedAccountRoot.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(row.root.delta[format]).toBeLessThanOrEqual(100);
    expect(rootCeilingFor({ ...ledger, tc2931BootstrapScope: undefined }, format)).toEqual({ row: "tc2936RestoreCommitRoot", ceiling: row.root.ceiling[format] });
  }
  expect(ancestryPins(ledger, false)).toContainEqual({ row: "tc2936RestoreCommitRoot", pin: row.sourceCommits[0] });
  expect(Object.keys(row).sort()).toEqual(["base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits"]);
});

test("TC-2936 refuses mutation, removal and a missing predecessor", () => {
  const row = ledger.tc2936RestoreCommitRoot;
  validateTc2936RestoreCommitRootTransition(undefined, row);
  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.mjs"]++; },
    (value: typeof row) => { value.root.delta["index.cjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2936RestoreCommitRootTransition(undefined, changed)).toThrow("TC-2936");
    expect(() => validateLedger({ ...ledger, tc2936RestoreCommitRoot: changed })).toThrow("TC-2936");
  }
  expect(() => validateTc2936RestoreCommitRootTransition(row, undefined)).toThrow("TC-2936");
  expect(() => validateLedger({ ...ledger, tc2934RequestedAccountRoot: undefined })).toThrow("TC-2936");
});
