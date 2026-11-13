import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import { approvedTc2931BootstrapScope, ancestryPins, rootCeilingFor, validateLedger, validateTc2931BootstrapScopeTransition } from "./replica-size-policy";
import { MAX_REPLICA_WORKER_GZIP_BYTES, MAX_WORKER_GZIP_BYTES } from "../../replica/scripts/check-worker-size";

test("TC-2931 admits exact combined-head CI root and worker bytes within its ticket caps", () => {
  validateLedger(ledger);
  const row = ledger.tc2931BootstrapScope;
  expect(row).toEqual(approvedTc2931BootstrapScope);
  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - ledger.tc2936RestoreCommitRoot.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(row.root.delta[format]).toBeLessThanOrEqual(700);
    expect(rootCeilingFor({ ...ledger, tc2923EncryptionTeeOriginRoot: undefined, tc2949PanelChunkRecoveryRoot: undefined, tc2970RegistryVerdictCacheRoot: undefined }, format)).toEqual({ row: "tc2931BootstrapScope", ceiling: row.root.ceiling[format] });
  }
  expect(row.worker.ceiling - ledger.tc2872RenewalKvWorker.worker.ceiling).toBe(row.worker.delta);
  expect(row.replicaWorker.ceiling - ledger.tc2872RenewalReplicaWorker.replicaWorker.ceiling).toBe(row.replicaWorker.delta);
  expect(row.worker.delta).toBeLessThanOrEqual(250);
  expect(row.replicaWorker.delta).toBeLessThanOrEqual(250);
  expect(MAX_WORKER_GZIP_BYTES).toBe(row.worker.ceiling);
  expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(row.replicaWorker.ceiling);
  expect(ancestryPins(ledger, false)).toContainEqual({ row: "tc2931BootstrapScope", pin: row.sourceCommits[0] });
});

test("TC-2931 refuses mutation, removal and missing predecessor rows", () => {
  const row = ledger.tc2931BootstrapScope;
  validateTc2931BootstrapScopeTransition(undefined, row);
  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.mjs"]++; },
    (value: typeof row) => { value.root.delta["index.cjs"]++; },
    (value: typeof row) => { value.worker.ceiling++; },
    (value: typeof row) => { value.replicaWorker.delta++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2931BootstrapScopeTransition(undefined, changed)).toThrow("TC-2931");
    expect(() => validateLedger({ ...ledger, tc2931BootstrapScope: changed })).toThrow("TC-2931");
  }
  expect(() => validateTc2931BootstrapScopeTransition(row, undefined)).toThrow("TC-2931");
  for (const predecessor of ["tc2936RestoreCommitRoot", "tc2872RenewalKvWorker", "tc2872RenewalReplicaWorker"] as const) {
    expect(() => validateLedger({ ...ledger, [predecessor]: undefined })).toThrow();
  }
});
