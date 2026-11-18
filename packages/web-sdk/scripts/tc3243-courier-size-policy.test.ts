import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3243CourierSdkOwnsBusyRetryRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3243CourierSdkOwnsBusyRetryRootTransition,
} from "./replica-size-policy";
import { MAX_REPLICA_WORKER_GZIP_BYTES, MAX_WORKER_GZIP_BYTES } from "../../replica/scripts/check-worker-size";

test("TC-3243 records the exact canonical CI root and worker bytes of #1037 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3243CourierSdkOwnsBusyRetryRoot;
  const predecessor = ledger.tc3243SdkOwnsBusyRetryRoot;
  expect(row).toEqual(approvedTc3243CourierSdkOwnsBusyRetryRoot);
  expect(row.base).toBe("b758e712acf147bc3b2f801418b78c3bea4bf917");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44233448391",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44233448391/job/134563795047",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44233448391/job/134563795379",
    ],
  });
  expect(row.sourceCommits).toEqual(["7f6337a765c1807c0157477b7d4fc27721b0e76e"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1528616, "index.cjs": 1462079 });
  expect(row.root.delta).toEqual({ "index.mjs": 7, "index.cjs": 6 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3243CourierSdkOwnsBusyRetryRoot", ceiling: row.root.ceiling[format] });
  }

  // Worker deltas are measured against the TC-2931 worker ceilings, the newest before this row.
  expect(row.worker).toEqual({ delta: 14, ceiling: 780917 });
  expect(row.replicaWorker).toEqual({ delta: 14, ceiling: 774575 });
  expect(row.worker.ceiling - ledger.tc2931BootstrapScope.worker.ceiling).toBe(row.worker.delta);
  expect(row.replicaWorker.ceiling - ledger.tc2931BootstrapScope.replicaWorker.ceiling).toBe(row.replicaWorker.delta);
  expect(MAX_WORKER_GZIP_BYTES).toBe(row.worker.ceiling);
  expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(row.replicaWorker.ceiling);

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3243CourierSdkOwnsBusyRetryRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "replicaWorker", "root", "ruling", "sourceCommits", "worker",
  ]);
});

test("TC-3243 Courier row refuses mutation, removal, or a missing registry-sync predecessor", () => {
  const row = ledger.tc3243CourierSdkOwnsBusyRetryRoot;
  validateTc3243CourierSdkOwnsBusyRetryRootTransition(undefined, row);
  validateTc3243CourierSdkOwnsBusyRetryRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.worker.ceiling++; },
    (value: typeof row) => { value.replicaWorker.delta++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3243CourierSdkOwnsBusyRetryRootTransition(undefined, changed)).toThrow("TC-3243");
    expect(() => validateLedger({ ...ledger, tc3243CourierSdkOwnsBusyRetryRoot: changed })).toThrow("TC-3243");
  }

  expect(() => validateTc3243CourierSdkOwnsBusyRetryRootTransition(row, undefined)).toThrow("TC-3243");
  expect(() => validateLedger({ ...ledger, tc3243SdkOwnsBusyRetryRoot: undefined })).toThrow("TC-3243");
});
