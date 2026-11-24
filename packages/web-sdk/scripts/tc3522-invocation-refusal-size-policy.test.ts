import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import { ancestryPins, rootCeilingFor, validateLedger, validateTc3522InvocationRefusalRootTransition } from "./replica-size-policy";

const row = ledger.tc3522InvocationRefusalRoot;

test("TC-3522 adds only its approved ESM root ceiling after TC-3862", () => {
  validateLedger(ledger);
  expect(row.root).toEqual({
    delta: { "index.mjs": 358, "index.cjs": 0 },
    ceiling: { "index.mjs": 1539880, "index.cjs": 1471461 },
  });
  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - ledger.tc3862ExplorerOriginRoot.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(rootCeilingFor({ ...ledger, tc3810ReaderRoot: undefined, tc3975NamedKeyWarningRoot: undefined, tc4082HostedOwnerRoot: undefined }, format)).toEqual({ row: "tc3522InvocationRefusalRoot", ceiling: row.root.ceiling[format] });
  }
  expect(ancestryPins(ledger, false)).toContainEqual({ row: "tc3522InvocationRefusalRoot", pin: "45cbb18e7b9c762063a4c23aac199e458df95a1d" });
});

test("TC-3522 rejects missing predecessor, removal, or unapproved increases", () => {
  const changed = structuredClone(row);
  changed.root.ceiling["index.cjs"]++;
  expect(() => validateLedger({ ...ledger, tc3862ExplorerOriginRoot: undefined })).toThrow("TC-3522");
  expect(() => validateTc3522InvocationRefusalRootTransition(row, undefined)).toThrow("TC-3522");
  expect(() => validateTc3522InvocationRefusalRootTransition(undefined, changed)).toThrow("TC-3522");
});
