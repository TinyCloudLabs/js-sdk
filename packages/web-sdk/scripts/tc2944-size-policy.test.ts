import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2944VaultPathClassifierRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc2944VaultPathClassifierRootTransition,
} from "./replica-size-policy";

test("TC-2944 records the exact canonical CI root bytes of #1069 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc2944VaultPathClassifierRoot;
  const predecessor = ledger.tc3286ShareNoDelegationActionsRoot;
  expect(row).toEqual(approvedTc2944VaultPathClassifierRoot);
  expect(row.base).toBe("e7e5d47bf76ea6c5a851c57bec470c108725299b");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44533528238",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44533528238/job/135592824606",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44533528238/job/135592824800",
    ],
  });
  expect(row.sourceCommits).toEqual(["f5259377681da055a78d5a4508176f939b4eaa35"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1529625, "index.cjs": 1462613 });
  expect(row.root.delta).toEqual({ "index.mjs": 686, "index.cjs": 273 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor({ ...ledger, tc3448OnBehalfPromptRoot: undefined, tc2490OneApprovalRoot: undefined, tc3661ShareLinkHostRoot: undefined, tc3522LeaseAskRoot: undefined, tc3443GenericManifestRoot: undefined, tc3688AccountIndexGuardRoot: undefined, tc3443SessionRetireRoot: undefined, tc3443PortFolderRoot: undefined, tc3704OpenKeyPromptRoot: undefined, tc3731ManifestOwnerRoot: undefined, tc3443AppIdLineBreakRoot: undefined, tc3549KeptApprovalsRoot: undefined, tc3617HostedMcpLeaseRoot: undefined, tc3947ReplicaRevokeRoot: undefined, tc3801NamedKeysRoot: undefined, tc3969SecretKeyCoverageRoot: undefined }, format)).toEqual({ row: "tc2944VaultPathClassifierRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc2944VaultPathClassifierRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-2944 refuses mutation, removal, or a missing TC-3286 predecessor", () => {
  const row = ledger.tc2944VaultPathClassifierRoot;
  validateTc2944VaultPathClassifierRootTransition(undefined, row);
  validateTc2944VaultPathClassifierRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2944VaultPathClassifierRootTransition(undefined, changed)).toThrow("TC-2944");
    expect(() => validateLedger({ ...ledger, tc2944VaultPathClassifierRoot: changed })).toThrow("TC-2944");
  }

  expect(() => validateTc2944VaultPathClassifierRootTransition(row, undefined)).toThrow("TC-2944");
  expect(() => validateLedger({ ...ledger, tc3286ShareNoDelegationActionsRoot: undefined })).toThrow("TC-2944");
});
