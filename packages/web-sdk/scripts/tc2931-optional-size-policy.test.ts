import { expect, test } from "bun:test";
import rootWithTc2927 from "./replica-size-ledger.json";
const root = structuredClone(rootWithTc2927);
delete root.tc2927ShareApprovalRoot;
import optional from "./replica-optional-size-ledger.json";
import { approvedTc2931Optional, evaluateOptionalBudget, optionalFormats, optionalSourcePins, validateOptionalEntryTransition, validateOptionalLedger, validateTc2931OptionalTransition, type OptionalLedger } from "./replica-optional-size-policy";

const validate = (value: OptionalLedger) => validateOptionalLedger(value, true, true, true, true, true, true, true, true, true, true, true, true, true, root.tc2481OfflineReplicaTransport, root.tc2931BootstrapScope);

test("TC-2931 optional admission keeps exact accounting and the mandatory direct gate", () => {
  validate(optional);
  expect(optional.tc2931).toEqual(approvedTc2931Optional);
  const row = optional.tc2931;
  expect(row.base).toBe(root.tc2931BootstrapScope.base);
  expect(row.sourceCommits).toEqual(root.tc2931BootstrapScope.sourceCommits);
  expect(row.canonicalCI.run).toBe(root.tc2931BootstrapScope.canonicalCI.run);
  for (const format of ["replica.mjs", "replica.cjs"] as const) {
    expect(row.firstImport.delta[format]).toBe(row.canonicalCI.after[format] - row.canonicalCI.before[format]);
    expect(row.firstImport.delta[format]).toBeLessThanOrEqual(150);
    expect(row.firstImport.ceiling[format]).toBe(row.canonicalCI.after[format]);
  }
  const readings = evaluateOptionalBudget(optional, root, row.canonicalCI.after);
  expect(readings.every((reading) => !reading.exceeded)).toBe(true);
  const cjs = readings.find((reading) => reading.format === "replica.cjs")!;
  expect(cjs.raw - cjs.effective).toBe(4);
  for (const format of ["replica.mjs", "replica.cjs"] as const) {
    const extraByte = { ...row.canonicalCI.after, [format]: optional.allowance[format] + 1 };
    expect(evaluateOptionalBudget(optional, root, extraByte).find((reading) => reading.format === format)?.exceeded).toBe(true);
  }
  validateOptionalEntryTransition(optional.entries.slice(0, -1), optional.entries, row.canonicalCI.delta, "#945");
  expect(optionalSourcePins(optional)).toContainEqual({ row: "tc2931", pin: row.sourceCommits[0] });
});

test("TC-2931 optional admission refuses mutation, missing accounting and later removal", () => {
  validateTc2931OptionalTransition(undefined, optional.tc2931);
  for (const format of optionalFormats) {
    const changed = structuredClone(optional);
    changed.allowance[format]++;
    expect(() => validate(changed)).toThrow();
  }
  const record = structuredClone(optional.tc2931);
  record.canonicalCI.jobs[0] = "unreviewed";
  expect(() => validateTc2931OptionalTransition(undefined, record)).toThrow("TC-2931");
  expect(() => validate({ ...optional, tc2931: record })).toThrow();
  expect(() => validateTc2931OptionalTransition(optional.tc2931, undefined)).toThrow("TC-2931");
  expect(() => validate({ ...optional, tc2931: undefined })).toThrow();
  expect(() => validate({ ...optional, entries: optional.entries.slice(0, -1) })).toThrow();
});
