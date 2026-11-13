import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import { approvedTc2923EncryptionTeeOriginRoot, ancestryPins, rootCeilingFor, validateLedger, validateTc2923EncryptionTeeOriginRootTransition } from "./replica-size-policy";

test("TC-2923 admits only its exact canonical root bytes over TC-2931, within the ruled cap", () => {
  validateLedger(ledger);
  const row = ledger.tc2923EncryptionTeeOriginRoot;
  expect(row).toEqual(approvedTc2923EncryptionTeeOriginRoot);
  const cap = { "index.mjs": 260, "index.cjs": 200 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - ledger.tc2931BootstrapScope.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(row.root.delta[format]).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor({ ...ledger, tc2949PanelChunkRecoveryRoot: undefined, tc2970RegistryVerdictCacheRoot: undefined, tc2913OpenKeyContinuationRoot: undefined, tc2987RegistryAbsentReadsRoot: undefined }, format)).toEqual({ row: "tc2923EncryptionTeeOriginRoot", ceiling: row.root.ceiling[format] });
  }
  expect(ancestryPins(ledger, false)).toContainEqual({ row: "tc2923EncryptionTeeOriginRoot", pin: row.sourceCommits[0] });
  expect(Object.keys(row).sort()).toEqual(["base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits"]);
});

test("TC-2923 refuses mutation, removal and a missing predecessor", () => {
  const row = ledger.tc2923EncryptionTeeOriginRoot;
  validateTc2923EncryptionTeeOriginRootTransition(undefined, row);
  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.mjs"]++; },
    (value: typeof row) => { value.root.delta["index.cjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2923EncryptionTeeOriginRootTransition(undefined, changed)).toThrow("TC-2923");
    expect(() => validateLedger({ ...ledger, tc2923EncryptionTeeOriginRoot: changed })).toThrow("TC-2923");
  }
  expect(() => validateTc2923EncryptionTeeOriginRootTransition(row, undefined)).toThrow("TC-2923");
  expect(() => validateLedger({ ...ledger, tc2931BootstrapScope: undefined })).toThrow("TC-2923");
});
