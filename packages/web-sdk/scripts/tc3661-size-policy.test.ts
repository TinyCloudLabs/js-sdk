import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3661ShareLinkHostRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3661ShareLinkHostRootTransition,
} from "./replica-size-policy";

test("TC-3661 records the exact canonical CI root bytes of #1114 within the ruled +350/+300 cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3661ShareLinkHostRoot;
  const predecessor = ledger.tc2490OneApprovalRoot;
  expect(row).toEqual(approvedTc3661ShareLinkHostRoot);
  expect(row.base).toBe("cb3edeab4f66ae2fc7f84243c7b8fdc3a15fc812");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44919854667",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44919854667/job/136893305938",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44919854667/job/136893305988",
    ],
  });
  expect(row.sourceCommits).toEqual(["d648dd280c96c43dee992e6339cf153f64fa5c34"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1530053, "index.cjs": 1462997 });
  expect(row.root.delta).toEqual({ "index.mjs": 195, "index.cjs": 148 });

  const cap = { "index.mjs": 350, "index.cjs": 300 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor({ ...ledger, tc3522LeaseAskRoot: undefined, tc3443GenericManifestRoot: undefined, tc3688AccountIndexGuardRoot: undefined, tc3443SessionRetireRoot: undefined, tc3443PortFolderRoot: undefined, tc3704OpenKeyPromptRoot: undefined, tc3731ManifestOwnerRoot: undefined, tc3443AppIdLineBreakRoot: undefined, tc3549KeptApprovalsRoot: undefined, tc3617HostedMcpLeaseRoot: undefined, tc3947ReplicaRevokeRoot: undefined, tc3801NamedKeysRoot: undefined, tc3969SecretKeyCoverageRoot: undefined, tc3823BotHistoryKeyRoot: undefined, tc3802SecretKeyCapRoot: undefined, tc3862ExplorerOriginRoot: undefined, tc3522InvocationRefusalRoot: undefined, tc3810ReaderRoot: undefined, tc4082HostedOwnerRoot: undefined }, format)).toEqual({ row: "tc3661ShareLinkHostRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3661ShareLinkHostRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3661 refuses mutation, removal, or a missing TC-2490 predecessor", () => {
  const row = ledger.tc3661ShareLinkHostRoot;
  validateTc3661ShareLinkHostRootTransition(undefined, row);
  validateTc3661ShareLinkHostRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3661ShareLinkHostRootTransition(undefined, changed)).toThrow("TC-3661");
    expect(() => validateLedger({ ...ledger, tc3661ShareLinkHostRoot: changed })).toThrow("TC-3661");
  }

  expect(() => validateTc3661ShareLinkHostRootTransition(row, undefined)).toThrow("TC-3661");
  expect(() => validateLedger({ ...ledger, tc2490OneApprovalRoot: undefined })).toThrow("TC-3661");
});
