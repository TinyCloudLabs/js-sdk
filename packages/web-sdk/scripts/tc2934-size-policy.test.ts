import { expect, test } from "bun:test";
import ledgerWithTc2927 from "./replica-size-ledger.json";
const ledger = structuredClone(ledgerWithTc2927);
delete ledger.tc2927ShareApprovalRoot;
import { approvedTc2934RequestedAccountRoot, ancestryPins, rootCeilingFor, validateLedger, validateTc2934RequestedAccountRootTransition } from "./replica-size-policy";

test("TC-2934 admits only its exact canonical root bytes with unchanged workers", () => {
  validateLedger(ledger);
  const row = ledger.tc2934RequestedAccountRoot;
  expect(row).toEqual(approvedTc2934RequestedAccountRoot);
  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - ledger.tc2924NodeAliasesRoot.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(rootCeilingFor({ ...ledger, tc2936RestoreCommitRoot: undefined, tc2931BootstrapScope: undefined }, format)).toEqual({ row: "tc2934RequestedAccountRoot", ceiling: row.root.ceiling[format] });
  }
  expect(ancestryPins(ledger, false)).toContainEqual({ row: "tc2934RequestedAccountRoot", pin: row.sourceCommits[0] });
  expect(Object.keys(row).sort()).toEqual(["base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits"]);
});

test("TC-2934 refuses mutation, removal and a missing predecessor", () => {
  const row = ledger.tc2934RequestedAccountRoot;
  validateTc2934RequestedAccountRootTransition(undefined, row);
  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2934RequestedAccountRootTransition(undefined, changed)).toThrow("TC-2934");
    expect(() => validateLedger({ ...ledger, tc2934RequestedAccountRoot: changed })).toThrow("TC-2934");
  }
  expect(() => validateTc2934RequestedAccountRootTransition(row, undefined)).toThrow("TC-2934");
  expect(() => validateLedger({ ...ledger, tc2924NodeAliasesRoot: undefined })).toThrow("TC-2934");
});
