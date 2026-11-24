import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import { ancestryPins, rootCeilingFor, validateLedger, validateTc3862ExplorerOriginRootTransition } from "./replica-size-policy";

const row = ledger.tc3862ExplorerOriginRoot;

test("TC-3862 charges only the canonical root growth over TC-3802", () => {
  validateLedger(ledger);
  expect(row.root).toEqual({
    delta: { "index.mjs": 6, "index.cjs": 8 },
    ceiling: { "index.mjs": 1539522, "index.cjs": 1471461 },
  });
  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - ledger.tc3802SecretKeyCapRoot.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(rootCeilingFor({ ...ledger, tc3522InvocationRefusalRoot: undefined, tc3810ReaderRoot: undefined, tc3975NamedKeyWarningRoot: undefined, tc4082HostedOwnerRoot: undefined, tc3891OwnerRegistryRecordRoot: undefined, tc4222PermissionLineRoot: undefined }, format)).toEqual({ row: "tc3862ExplorerOriginRoot", ceiling: row.root.ceiling[format] });
  }
  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3862ExplorerOriginRoot", pin: "3605a389b76b778fa77bed7acce40c6047f0631b",
  });
});

test("TC-3862 rejects removal, changed evidence, and a missing predecessor", () => {
  const changed = structuredClone(row);
  changed.canonicalCI.jobs.pop();
  expect(() => validateTc3862ExplorerOriginRootTransition(undefined, changed)).toThrow("TC-3862");
  expect(() => validateTc3862ExplorerOriginRootTransition(row, undefined)).toThrow("TC-3862");
  expect(() => validateLedger({ ...ledger, tc3802SecretKeyCapRoot: undefined })).toThrow("TC-3862");
  expect(() => validateLedger({ ...ledger, tc3862ExplorerOriginRoot: changed })).toThrow("TC-3862");
});
