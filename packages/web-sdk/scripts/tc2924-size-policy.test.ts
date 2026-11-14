import { describe, expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import { approvedTc2924NodeAliasesRoot, rootCeilingFor, validateLedger, validateTc2924NodeAliasesRootTransition } from "./replica-size-policy";

describe("TC-2924 exact node-alias allowance", () => {
  test("admits the exact residual above TC-2904 and selects its ceiling", () => {
    validateLedger(ledger);
    expect(ledger.tc2924NodeAliasesRoot).toEqual(approvedTc2924NodeAliasesRoot);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      const row = ledger.tc2924NodeAliasesRoot;
      expect(row.root.ceiling[format] - ledger.tc2904OwnerDirectProofRoot.root.ceiling[format]).toBe(row.root.delta[format]);
      expect(rootCeilingFor({ ...ledger, tc2934RequestedAccountRoot: undefined, tc2936RestoreCommitRoot: undefined, tc2931BootstrapScope: undefined, tc2923EncryptionTeeOriginRoot: undefined, tc2949PanelChunkRecoveryRoot: undefined, tc2970RegistryVerdictCacheRoot: undefined, tc2913OpenKeyContinuationRoot: undefined, tc2987RegistryAbsentReadsRoot: undefined, tc2937SharePlacementRoot: undefined }, format)).toMatchObject({ row: "tc2924NodeAliasesRoot", ceiling: row.root.ceiling[format] });
    }
  });
  test("refuses changed, removed, or unstacked allowances", () => {
    const row = ledger.tc2924NodeAliasesRoot;
    validateTc2924NodeAliasesRootTransition(undefined, row);
    const changed = structuredClone(row);
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2924NodeAliasesRootTransition(undefined, changed)).toThrow("TC-2924");
    expect(() => validateTc2924NodeAliasesRootTransition(row, undefined)).toThrow("TC-2924");
    expect(() => validateLedger({ ...ledger, tc2904OwnerDirectProofRoot: undefined })).toThrow("TC-2924");
  });
});
