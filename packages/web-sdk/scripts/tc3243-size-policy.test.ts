import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3243SdkOwnsBusyRetryRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3243SdkOwnsBusyRetryRootTransition,
} from "./replica-size-policy";

test("TC-3243 records the exact canonical CI root bytes of #1038 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3243SdkOwnsBusyRetryRoot;
  const predecessor = ledger.tc3194NativeShareLinksRoot;
  expect(row).toEqual(approvedTc3243SdkOwnsBusyRetryRoot);
  expect(row.base).toBe("23953408e6724fa5f488e67e6c418c50bca83fb3");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44226922450",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44226922450/job/134542228469",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44226922450/job/134542228412",
    ],
  });
  expect(row.sourceCommits).toEqual(["42eeab4a2f342a2c6213cc69340eb8c87413147d"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1528609, "index.cjs": 1462073 });
  expect(row.root.delta).toEqual({ "index.mjs": 150, "index.cjs": 108 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor({ ...ledger, tc3285SecretTypesRoot: undefined, tc3286ShareNoDelegationActionsRoot: undefined, tc2944VaultPathClassifierRoot: undefined, tc3448OnBehalfPromptRoot: undefined, tc2490OneApprovalRoot: undefined, tc3661ShareLinkHostRoot: undefined, tc3522LeaseAskRoot: undefined, tc3443GenericManifestRoot: undefined, tc3688AccountIndexGuardRoot: undefined, tc3443SessionRetireRoot: undefined, tc3443PortFolderRoot: undefined, tc3704OpenKeyPromptRoot: undefined, tc3731ManifestOwnerRoot: undefined, tc3443AppIdLineBreakRoot: undefined, tc3549KeptApprovalsRoot: undefined, tc3617HostedMcpLeaseRoot: undefined, tc3947ReplicaRevokeRoot: undefined, tc3801NamedKeysRoot: undefined, tc3969SecretKeyCoverageRoot: undefined, tc3823BotHistoryKeyRoot: undefined, tc3802SecretKeyCapRoot: undefined, tc3862ExplorerOriginRoot: undefined, tc3522InvocationRefusalRoot: undefined, tc3810ReaderRoot: undefined, tc3975NamedKeyWarningRoot: undefined }, format)).toEqual({ row: "tc3243SdkOwnsBusyRetryRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3243SdkOwnsBusyRetryRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3243 refuses mutation, removal, or a missing TC-3194 predecessor", () => {
  const row = ledger.tc3243SdkOwnsBusyRetryRoot;
  validateTc3243SdkOwnsBusyRetryRootTransition(undefined, row);
  validateTc3243SdkOwnsBusyRetryRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3243SdkOwnsBusyRetryRootTransition(undefined, changed)).toThrow("TC-3243");
    expect(() => validateLedger({ ...ledger, tc3243SdkOwnsBusyRetryRoot: changed })).toThrow("TC-3243");
  }

  expect(() => validateTc3243SdkOwnsBusyRetryRootTransition(row, undefined)).toThrow("TC-3243");
  expect(() => validateLedger({ ...ledger, tc3194NativeShareLinksRoot: undefined })).toThrow("TC-3243");
});
