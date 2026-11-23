import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3443SessionRetireRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3443SessionRetireRootTransition,
} from "./replica-size-policy";
import { MAX_REPLICA_WORKER_GZIP_BYTES, MAX_WORKER_GZIP_BYTES } from "../../replica/scripts/check-worker-size";

test("TC-3443 records the exact canonical CI root and worker bytes of #1118 within the ruled caps", () => {
  validateLedger(ledger);
  const row = ledger.tc3443SessionRetireRoot;
  const predecessor = ledger.tc3688AccountIndexGuardRoot;
  expect(row).toEqual(approvedTc3443SessionRetireRoot);
  expect(row.base).toBe("7d438ee4050498859d23ff3bb2f9022908b85b4c");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45067208416",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45067208416/job/137345926164",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45067208416/job/137345926173",
    ],
  });
  expect(row.sourceCommits).toEqual(["6ca3c9118bc045d731ae383523289a2c1e832741"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1531668, "index.cjs": 1464420 });
  expect(row.root.delta).toEqual({ "index.mjs": 1065, "index.cjs": 1083 });
  expect(row.worker).toEqual({ delta: 54, ceiling: 780957 });
  expect(row.replicaWorker).toEqual({ delta: 121, ceiling: 774682 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(row.root.delta[format]).toBeLessThanOrEqual(1100);
    expect(rootCeilingFor({ ...ledger, tc3443PortFolderRoot: undefined, tc3704OpenKeyPromptRoot: undefined, tc3731ManifestOwnerRoot: undefined, tc3443AppIdLineBreakRoot: undefined, tc3549KeptApprovalsRoot: undefined, tc3617HostedMcpLeaseRoot: undefined, tc3947ReplicaRevokeRoot: undefined, tc3801NamedKeysRoot: undefined }, format)).toEqual({ row: "tc3443SessionRetireRoot", ceiling: row.root.ceiling[format] });
  }
  expect(row.worker.ceiling - ledger.tc2931BootstrapScope.worker.ceiling).toBe(row.worker.delta);
  expect(row.replicaWorker.ceiling - ledger.tc2931BootstrapScope.replicaWorker.ceiling).toBe(row.replicaWorker.delta);
  expect(row.worker.delta).toBeLessThanOrEqual(250);
  expect(row.replicaWorker.delta).toBeLessThanOrEqual(250);
  expect(MAX_WORKER_GZIP_BYTES).toBe(ledger.tc3947ReplicaRevokeRoot.worker.ceiling);
  expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(ledger.tc3947ReplicaRevokeRoot.replicaWorker.ceiling);

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3443SessionRetireRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "replicaWorker", "root", "ruling", "sourceCommits", "worker",
  ]);
});

test("TC-3443 refuses mutation, removal, or a missing TC-3688 predecessor", () => {
  const row = ledger.tc3443SessionRetireRoot;
  validateTc3443SessionRetireRootTransition(undefined, row);
  validateTc3443SessionRetireRootTransition(row, structuredClone(row));

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
    expect(() => validateTc3443SessionRetireRootTransition(undefined, changed)).toThrow("TC-3443");
    expect(() => validateLedger({ ...ledger, tc3443SessionRetireRoot: changed })).toThrow("TC-3443");
  }

  expect(() => validateTc3443SessionRetireRootTransition(row, undefined)).toThrow("TC-3443");
  expect(() => validateLedger({ ...ledger, tc3688AccountIndexGuardRoot: undefined })).toThrow("TC-3443");
});
