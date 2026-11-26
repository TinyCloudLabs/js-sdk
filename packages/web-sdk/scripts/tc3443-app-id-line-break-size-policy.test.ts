import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3443AppIdLineBreakRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3443AppIdLineBreakRootTransition,
} from "./replica-size-policy";

test("TC-3443 records the exact canonical CI root bytes of #1135 within the ruled +16 B per format", () => {
  validateLedger(ledger);
  const row = ledger.tc3443AppIdLineBreakRoot;
  const predecessor = ledger.tc3731ManifestOwnerRoot;
  expect(row).toEqual(approvedTc3443AppIdLineBreakRoot);
  expect(row.base).toBe("5cc591102a9aef7d90d880e97671a2261f0f5b41");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45082592488",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45082592488/job/137393874380",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45082592488/job/137393874698",
    ],
  });
  expect(row.sourceCommits).toEqual(["3d2ff8abd3e5a5562803d6e28aa83540333e5c46"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1534531, "index.cjs": 1466079 });
  expect(row.root.delta).toEqual({ "index.mjs": 1, "index.cjs": 2 });

  const cap = { "index.mjs": 16, "index.cjs": 16 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor({ ...ledger, tc3549KeptApprovalsRoot: undefined, tc3617HostedMcpLeaseRoot: undefined, tc3947ReplicaRevokeRoot: undefined, tc3801NamedKeysRoot: undefined, tc3969SecretKeyCoverageRoot: undefined, tc3823BotHistoryKeyRoot: undefined, tc3802SecretKeyCapRoot: undefined, tc3862ExplorerOriginRoot: undefined, tc3522InvocationRefusalRoot: undefined, tc3810ReaderRoot: undefined, tc3975NamedKeyWarningRoot: undefined, tc4082HostedOwnerRoot: undefined, tc3891OwnerRegistryRecordRoot: undefined, tc4222PermissionLineRoot: undefined, tc4322ReservedKeyRoot: undefined, tc4329ActivationCauseRoot: undefined }, format)).toEqual({ row: "tc3443AppIdLineBreakRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3443AppIdLineBreakRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3443 line-break row refuses mutation, removal, or a missing TC-3731 predecessor", () => {
  const row = ledger.tc3443AppIdLineBreakRoot;
  validateTc3443AppIdLineBreakRootTransition(undefined, row);
  validateTc3443AppIdLineBreakRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.cjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3443AppIdLineBreakRootTransition(undefined, changed)).toThrow("TC-3443");
    expect(() => validateLedger({ ...ledger, tc3443AppIdLineBreakRoot: changed })).toThrow("TC-3443");
  }

  expect(() => validateTc3443AppIdLineBreakRootTransition(row, undefined)).toThrow("TC-3443");
  expect(() => validateLedger({ ...ledger, tc3731ManifestOwnerRoot: undefined })).toThrow("TC-3443");
});
