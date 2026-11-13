import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2927ShareApprovalRoot, ancestryPins, rootCeilingFor,
  validateLedger, validateTc2927ShareApprovalRootTransition,
} from "./replica-size-policy";

test("TC-2927 admits only its exact canonical share-approval bytes within the ticket cap", () => {
  validateLedger(ledger);
  const row = ledger.tc2927ShareApprovalRoot;
  expect(row).toEqual(approvedTc2927ShareApprovalRoot);
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const preceding = rootCeilingFor({ ...ledger, tc2927ShareApprovalRoot: undefined }, format);
    expect(row.root.ceiling[format] - preceding.ceiling).toBe(row.root.delta[format]);
    expect(row.root.delta[format]).toBeGreaterThanOrEqual(0);
    expect(row.root.delta[format]).toBeLessThanOrEqual(1900);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc2927ShareApprovalRoot", ceiling: row.root.ceiling[format] });
  }
  expect(ancestryPins(ledger, false)).toContainEqual({ row: "tc2927ShareApprovalRoot", pin: row.sourceCommits.at(-1)! });
});

test("TC-2927 refuses changed measurements, source provenance, removal and missing predecessors", () => {
  const row = ledger.tc2927ShareApprovalRoot;
  validateTc2927ShareApprovalRootTransition(undefined, row);
  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.mjs"]++; },
    (value: typeof row) => { value.root.delta["index.cjs"]++; },
    (value: typeof row) => { value.base = "0".repeat(40); },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2927ShareApprovalRootTransition(undefined, changed)).toThrow("TC-2927");
    expect(() => validateLedger({ ...ledger, tc2927ShareApprovalRoot: changed })).toThrow("TC-2927");
  }
  expect(() => validateTc2927ShareApprovalRootTransition(row, undefined)).toThrow("TC-2927");
  expect(() => validateLedger({ ...ledger, tc2931BootstrapScope: undefined })).toThrow();
});
