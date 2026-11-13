import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2949PanelChunkRecoveryRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc2949PanelChunkRecoveryRootTransition,
} from "./replica-size-policy";

test("TC-2949 records the exact canonical CI root bytes within its 150-byte caps", () => {
  validateLedger(ledger);
  const row = ledger.tc2949PanelChunkRecoveryRoot;
  const predecessor = ledger.tc2923EncryptionTeeOriginRoot;
  expect(row).toEqual(approvedTc2949PanelChunkRecoveryRoot);
  expect(row.base).toBe("4ff23e8e9f2c9ccb39b5edb5dc7bdd4a97c3912d");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43456942350",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43456942350/job/131993450248",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43456942350/job/131993450694",
    ],
  });
  expect(row.sourceCommits).toEqual(["f9ccd5b8ffbe55a4dbef27e03562a777b08951e8"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1524168, "index.cjs": 1458646 });
  expect(row.root.delta).toEqual({ "index.mjs": 119, "index.cjs": 129 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(150);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc2949PanelChunkRecoveryRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc2949PanelChunkRecoveryRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-2949 refuses mutation, removal, or a missing TC-2923 predecessor", () => {
  const row = ledger.tc2949PanelChunkRecoveryRoot;
  validateTc2949PanelChunkRecoveryRootTransition(undefined, row);
  validateTc2949PanelChunkRecoveryRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2949PanelChunkRecoveryRootTransition(undefined, changed)).toThrow("TC-2949");
    expect(() => validateLedger({ ...ledger, tc2949PanelChunkRecoveryRoot: changed })).toThrow("TC-2949");
  }

  expect(() => validateTc2949PanelChunkRecoveryRootTransition(row, undefined)).toThrow("TC-2949");
  expect(() => validateLedger({ ...ledger, tc2923EncryptionTeeOriginRoot: undefined })).toThrow("TC-2949");
});
