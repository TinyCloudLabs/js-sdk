import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3801NamedKeysRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3801NamedKeysRootTransition,
} from "./replica-size-policy";

test("TC-3801 records the exact canonical CI root bytes of #1131", () => {
  validateLedger(ledger);
  const row = ledger.tc3801NamedKeysRoot;
  const predecessor = ledger.tc3947ReplicaRevokeRoot;
  expect(row).toEqual(approvedTc3801NamedKeysRoot);
  expect(row.base).toBe("979145a429cbc0fb1c107da4e211dbabeb9afb81");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45128664935",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45128664935/job/137538818194",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45128664935/job/137538818578",
    ],
  });
  expect(row.sourceCommits).toEqual(["f9fd4d997b3b3d42093650e10b3c175c238d486d"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1539368, "index.cjs": 1471344 });
  expect(row.root.delta).toEqual({ "index.mjs": 3822, "index.cjs": 4391 });

  // The ruling lifts the per-row byte cap for this row: the delta is exactly CI's.
  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(rootCeilingFor({ ...ledger, tc3969SecretKeyCoverageRoot: undefined, tc3823BotHistoryKeyRoot: undefined, tc3802SecretKeyCapRoot: undefined, tc3862ExplorerOriginRoot: undefined }, format)).toEqual({ row: "tc3801NamedKeysRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3801NamedKeysRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3801 refuses mutation, removal, or a missing TC-3947 predecessor", () => {
  const row = ledger.tc3801NamedKeysRoot;
  validateTc3801NamedKeysRootTransition(undefined, row);
  validateTc3801NamedKeysRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3801NamedKeysRootTransition(undefined, changed)).toThrow("TC-3801");
    expect(() => validateLedger({ ...ledger, tc3801NamedKeysRoot: changed })).toThrow("TC-3801");
  }

  expect(() => validateTc3801NamedKeysRootTransition(row, undefined)).toThrow("TC-3801");
  expect(() => validateLedger({ ...ledger, tc3947ReplicaRevokeRoot: undefined })).toThrow("TC-3801");
});
