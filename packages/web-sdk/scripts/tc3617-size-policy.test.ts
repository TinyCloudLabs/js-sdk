import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3617HostedMcpLeaseRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3617HostedMcpLeaseRootTransition,
} from "./replica-size-policy";

test("TC-3617 records the exact canonical CI root bytes of #1122 within the ruled +100/+100 cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3617HostedMcpLeaseRoot;
  const predecessor = ledger.tc3549KeptApprovalsRoot;
  expect(row).toEqual(approvedTc3617HostedMcpLeaseRoot);
  expect(row.base).toBe("d4c0cf6b3df06f79bd9acfeadc31970e9a41da86");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45089187188",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45089187188/job/137414613992",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45089187188/job/137414613915",
    ],
  });
  expect(row.sourceCommits).toEqual(["cea5dad7992f88b7bd1ee2ad1e154967f139b7bd"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1535484, "index.cjs": 1466903 });
  expect(row.root.delta).toEqual({ "index.mjs": 59, "index.cjs": 16 });

  const cap = { "index.mjs": 100, "index.cjs": 100 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor({ ...ledger, tc3947ReplicaRevokeRoot: undefined, tc3801NamedKeysRoot: undefined, tc3969SecretKeyCoverageRoot: undefined, tc3823BotHistoryKeyRoot: undefined, tc3802SecretKeyCapRoot: undefined, tc3862ExplorerOriginRoot: undefined, tc3522InvocationRefusalRoot: undefined, tc3810ReaderRoot: undefined, tc3975NamedKeyWarningRoot: undefined, tc4082HostedOwnerRoot: undefined, tc3891OwnerRegistryRecordRoot: undefined, tc4222PermissionLineRoot: undefined, tc4322ReservedKeyRoot: undefined, tc4329ActivationCauseRoot: undefined, tc4344OpenKeyAccountSetupRoot: undefined }, format)).toEqual({ row: "tc3617HostedMcpLeaseRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3617HostedMcpLeaseRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3617 refuses mutation, removal, or a missing TC-3549 kept-approvals predecessor", () => {
  const row = ledger.tc3617HostedMcpLeaseRoot;
  validateTc3617HostedMcpLeaseRootTransition(undefined, row);
  validateTc3617HostedMcpLeaseRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3617HostedMcpLeaseRootTransition(undefined, changed)).toThrow("TC-3617");
    expect(() => validateLedger({ ...ledger, tc3617HostedMcpLeaseRoot: changed })).toThrow("TC-3617");
  }

  expect(() => validateTc3617HostedMcpLeaseRootTransition(row, undefined)).toThrow("TC-3617");
  expect(() => validateLedger({ ...ledger, tc3549KeptApprovalsRoot: undefined })).toThrow("TC-3617");
});
