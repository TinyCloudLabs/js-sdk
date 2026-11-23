import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3802SecretKeyCapRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3802SecretKeyCapRootTransition,
} from "./replica-size-policy";

test("TC-3802 records the exact canonical CI root bytes of #1133", () => {
  validateLedger(ledger);
  const row = ledger.tc3802SecretKeyCapRoot;
  const predecessor = ledger.tc3801NamedKeysRoot;
  expect(row).toEqual(approvedTc3802SecretKeyCapRoot);
  expect(row.base).toBe("171a7b391cff57591aad20ab827660cad6673c06");
  expect(row.canonicalCI).toEqual({
    run: "PLACEHOLDER: replaced by the canonical CI run of this head",
    jobs: ["PLACEHOLDER: sqlite Replica job", "PLACEHOLDER: postgres Replica job"],
  });
  expect(row.sourceCommits).toEqual(["fd14fa023d84e17436150e11fc198cfce3d09d18"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1539377, "index.cjs": 1471348 });
  expect(row.root.delta).toEqual({ "index.mjs": 9, "index.cjs": 4 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3802SecretKeyCapRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3802SecretKeyCapRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3802 refuses mutation, removal, or a missing TC-3801 predecessor", () => {
  const row = ledger.tc3802SecretKeyCapRoot;
  validateTc3802SecretKeyCapRootTransition(undefined, row);
  validateTc3802SecretKeyCapRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3802SecretKeyCapRootTransition(undefined, changed)).toThrow("TC-3802");
    expect(() => validateLedger({ ...ledger, tc3802SecretKeyCapRoot: changed })).toThrow("TC-3802");
  }

  expect(() => validateTc3802SecretKeyCapRootTransition(row, undefined)).toThrow("TC-3802");
  expect(() => validateLedger({ ...ledger, tc3801NamedKeysRoot: undefined })).toThrow("TC-3802");
});
