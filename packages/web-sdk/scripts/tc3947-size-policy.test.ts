import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3947ReplicaRevokeRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3947ReplicaRevokeRootTransition,
} from "./replica-size-policy";
import { MAX_REPLICA_WORKER_GZIP_BYTES, MAX_WORKER_GZIP_BYTES } from "../../replica/scripts/check-worker-size";

test("TC-3947 records the exact canonical CI root bytes of #1138", () => {
  validateLedger(ledger);
  const row = ledger.tc3947ReplicaRevokeRoot;
  const predecessor = ledger.tc3617HostedMcpLeaseRoot;
  expect(row).toEqual(approvedTc3947ReplicaRevokeRoot);
  expect(row.base).toBe("3ad8bb80e3b3b1f2342f4663cfe72f0ecd881093");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45102787771",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45102787771/job/137457227215",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45102787771/job/137457227567",
    ],
  });
  expect(row.sourceCommits).toEqual(["d79271d35eefa9471209446e506284b3ecbb704e"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1535546, "index.cjs": 1466953 });
  expect(row.root.delta).toEqual({ "index.mjs": 62, "index.cjs": 50 });

  // The delta is exactly CI's measured change over the predecessor.
  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(rootCeilingFor({ ...ledger, tc3801NamedKeysRoot: undefined, tc3969SecretKeyCoverageRoot: undefined, tc3823BotHistoryKeyRoot: undefined, tc3802SecretKeyCapRoot: undefined, tc3862ExplorerOriginRoot: undefined, tc3522InvocationRefusalRoot: undefined, tc3810ReaderRoot: undefined, tc4082HostedOwnerRoot: undefined }, format)).toEqual({ row: "tc3947ReplicaRevokeRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3947ReplicaRevokeRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(row.worker.ceiling - ledger.tc3443SessionRetireRoot.worker.ceiling).toBe(row.worker.delta);
  expect(row.replicaWorker.ceiling - ledger.tc3443SessionRetireRoot.replicaWorker.ceiling).toBe(row.replicaWorker.delta);
  expect(row.worker).toEqual({ delta: 234, ceiling: 781191 });
  expect(row.replicaWorker).toEqual({ delta: 238, ceiling: 774920 });
  expect(MAX_WORKER_GZIP_BYTES).toBe(ledger.tc3522InvocationRefusalKvWorker.worker.ceiling);
  expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(ledger.tc3522InvocationRefusalReplicaWorker.replicaWorker.ceiling);
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "replicaWorker", "root", "ruling", "sourceCommits", "worker",
  ]);
});

test("TC-3947 refuses mutation, removal, or a missing TC-3617 predecessor", () => {
  const row = ledger.tc3947ReplicaRevokeRoot;
  validateTc3947ReplicaRevokeRootTransition(undefined, row);
  validateTc3947ReplicaRevokeRootTransition(row, structuredClone(row));

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
    expect(() => validateTc3947ReplicaRevokeRootTransition(undefined, changed)).toThrow("TC-3947");
    expect(() => validateLedger({ ...ledger, tc3947ReplicaRevokeRoot: changed })).toThrow("TC-3947");
  }

  expect(() => validateTc3947ReplicaRevokeRootTransition(row, undefined)).toThrow("TC-3947");
  expect(() => validateLedger({ ...ledger, tc3617HostedMcpLeaseRoot: undefined })).toThrow("TC-3947");
});
