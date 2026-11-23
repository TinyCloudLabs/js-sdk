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
  const predecessor = ledger.tc3823BotHistoryKeyRoot;
  expect(row).toEqual(approvedTc3802SecretKeyCapRoot);
  expect(row.base).toBe("67f965e446d1ea6a0e6d8688228b1e2d8dada833");
  expect(row.canonicalCI).toEqual({
    run: "45163202497",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45163202497/job/137653511265",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45163202497/job/137653512203",
    ],
  });
  expect(row.sourceCommits).toEqual(["d09e029c3a20e1213760360afa7dc16c3ff0fc33"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1539516, "index.cjs": 1471453 });
  expect(row.root.delta).toEqual({ "index.mjs": 8, "index.cjs": 7 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(rootCeilingFor({ ...ledger, tc3862ExplorerOriginRoot: undefined, tc3522InvocationRefusalRoot: undefined, tc3810ReaderRoot: undefined }, format)).toEqual({ row: "tc3802SecretKeyCapRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3802SecretKeyCapRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3802 refuses mutation, removal, or a missing TC-3823 predecessor", () => {
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
  expect(() => validateLedger({ ...ledger, tc3823BotHistoryKeyRoot: undefined })).toThrow("TC-3802");
});
