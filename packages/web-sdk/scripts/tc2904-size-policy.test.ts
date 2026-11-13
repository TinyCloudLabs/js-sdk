import { describe, expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import { approvedTc2904OwnerDirectProofRoot, rootCeilingFor, validateLedger, validateTc2904OwnerDirectProofRootTransition } from "./replica-size-policy";

describe("TC-2904 exact proof-parser allowance", () => {
  test("admits the exact residual above TC-2872 and selects its ceiling", () => {
    validateLedger(ledger);
    expect(ledger.tc2904OwnerDirectProofRoot).toEqual(approvedTc2904OwnerDirectProofRoot);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      const row = ledger.tc2904OwnerDirectProofRoot;
      expect(row.root.ceiling[format] - ledger.tc2872RenewalRoot.root.ceiling[format]).toBe(row.root.delta[format]);
      expect(rootCeilingFor({ ...ledger, tc2924NodeAliasesRoot: undefined, tc2934RequestedAccountRoot: undefined }, format)).toMatchObject({ row: "tc2904OwnerDirectProofRoot", ceiling: row.root.ceiling[format] });
    }
  });
  test("refuses changed, removed, or unstacked allowances", () => {
    const row = ledger.tc2904OwnerDirectProofRoot;
    validateTc2904OwnerDirectProofRootTransition(undefined, row);
    const changed = structuredClone(row);
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2904OwnerDirectProofRootTransition(undefined, changed)).toThrow("TC-2904");
    expect(() => validateTc2904OwnerDirectProofRootTransition(row, undefined)).toThrow("TC-2904");
    expect(() => validateLedger({ ...ledger, tc2872RenewalRoot: undefined, tc2872RenewalKvWorker: undefined, tc2872RenewalReplicaWorker: undefined })).toThrow("TC-2904");
  });
});
