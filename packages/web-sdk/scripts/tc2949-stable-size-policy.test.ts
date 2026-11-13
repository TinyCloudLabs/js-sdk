import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2949StablePanelChunkRecoveryRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc2949StablePanelChunkRecoveryRootTransition,
} from "./replica-size-policy";

test("stable TC-2949 records the exact canonical CI root bytes within its 150-byte caps", () => {
  validateLedger(ledger);
  const row = ledger.tc2949StablePanelChunkRecoveryRoot;
  const predecessor = ledger.tc2934RequestedAccountRoot;
  expect(row).toEqual(approvedTc2949StablePanelChunkRecoveryRoot);
  expect(row.base).toBe("5cd06026a61810cfd920054af17b577602440839");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43467496377",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43467496377/job/132030409774",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/43467496377/job/132030410128",
    ],
  });
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.ceiling[format] - predecessor.root.ceiling[format];
    expect(row.root.delta[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(150);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc2949StablePanelChunkRecoveryRoot", ceiling: row.root.ceiling[format] });
  }
  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc2949StablePanelChunkRecoveryRoot",
    pin: row.sourceCommits[0],
  });
  expect(Object.keys(row).sort()).toEqual(["base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits"]);
});

test("stable TC-2949 refuses mutation, removal, or a missing TC-2934 predecessor", () => {
  const row = ledger.tc2949StablePanelChunkRecoveryRoot;
  validateTc2949StablePanelChunkRecoveryRootTransition(undefined, row);
  validateTc2949StablePanelChunkRecoveryRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2949StablePanelChunkRecoveryRootTransition(undefined, changed)).toThrow("stable TC-2949");
    expect(() => validateLedger({ ...ledger, tc2949StablePanelChunkRecoveryRoot: changed })).toThrow("stable TC-2949");
  }

  expect(() => validateTc2949StablePanelChunkRecoveryRootTransition(row, undefined)).toThrow("stable TC-2949");
  expect(() => validateLedger({ ...ledger, tc2934RequestedAccountRoot: undefined })).toThrow("stable TC-2949");
});
