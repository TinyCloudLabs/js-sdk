import { expect, test } from "bun:test";
import root from "./replica-size-ledger.json";
import optional from "./replica-optional-size-ledger.json";
import { approvedTc3947Optional, evaluateOptionalBudget, optionalFormats, optionalSourcePins, validateOptionalEntryTransition, validateOptionalLedger, validateTc3947OptionalTransition, type OptionalLedger } from "./replica-optional-size-policy";

const validate = (value: OptionalLedger) => validateOptionalLedger(value, true, true, true, true, true, true, true, true, true, true, true, true, true, root.tc2481OfflineReplicaTransport, root.tc2931BootstrapScope, root.tc3947ReplicaRevokeRoot);

test("TC-3947 optional admission keeps exact accounting and the mandatory direct gate", () => {
  validate(optional);
  expect(optional.tc3947).toEqual(approvedTc3947Optional);
  const row = optional.tc3947;
  expect(row.base).toBe(root.tc3947ReplicaRevokeRoot.base);
  expect(row.sourceCommits).toEqual(root.tc3947ReplicaRevokeRoot.sourceCommits);
  expect(row.canonicalCI.run).toBe(root.tc3947ReplicaRevokeRoot.canonicalCI.run);
  for (const format of ["replica.mjs", "replica.cjs"] as const) {
    expect(row.firstImport.delta[format]).toBe(row.canonicalCI.after[format] - row.canonicalCI.before[format]);
    expect(row.firstImport.delta[format]).toBeLessThanOrEqual(150);
    expect(row.firstImport.ceiling[format]).toBeGreaterThanOrEqual(row.canonicalCI.after[format]);
  }
  expect(row.firstImport.ceiling["replica.cjs"]).toBe(row.canonicalCI.after["replica.cjs"]);
  const readings = evaluateOptionalBudget(optional, root, row.canonicalCI.after);
  expect(readings.every((reading) => !reading.exceeded)).toBe(true);
  const cjs = readings.find((reading) => reading.format === "replica.cjs")!;
  expect(cjs.raw - cjs.effective).toBe(4);
  for (const format of ["replica.mjs", "replica.cjs"] as const) {
    const extraByte = { ...row.canonicalCI.after, [format]: optional.allowance[format] + 1 };
    expect(evaluateOptionalBudget(optional, root, extraByte).find((reading) => reading.format === format)?.exceeded).toBe(true);
  }
  validateOptionalEntryTransition(optional.entries.slice(0, -1), optional.entries, row.canonicalCI.delta, "#1138");
  expect(optionalSourcePins(optional)).toContainEqual({ row: "tc3947", pin: row.sourceCommits[0] });
});

test("TC-3947 optional admission refuses mutation, missing accounting and later removal", () => {
  validateTc3947OptionalTransition(undefined, optional.tc3947);
  for (const format of optionalFormats) {
    const changed = structuredClone(optional);
    changed.allowance[format]++;
    expect(() => validate(changed)).toThrow();
  }
  const record = structuredClone(optional.tc3947);
  record.canonicalCI.jobs[0] = "unreviewed";
  expect(() => validateTc3947OptionalTransition(undefined, record)).toThrow("TC-3947");
  expect(() => validate({ ...optional, tc3947: record })).toThrow();
  expect(() => validateTc3947OptionalTransition(optional.tc3947, undefined)).toThrow("TC-3947");
  expect(() => validate({ ...optional, tc3947: undefined })).toThrow();
  expect(() => validate({ ...optional, entries: optional.entries.slice(0, -1) })).toThrow();
});
