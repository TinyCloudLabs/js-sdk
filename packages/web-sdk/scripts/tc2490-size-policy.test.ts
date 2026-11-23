import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc2490OneApprovalRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc2490OneApprovalRootTransition,
} from "./replica-size-policy";

test("TC-2490 records the exact canonical CI root bytes of #1060 within the 700-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc2490OneApprovalRoot;
  const predecessor = ledger.tc3448OnBehalfPromptRoot;
  expect(row).toEqual(approvedTc2490OneApprovalRoot);
  expect(row.base).toBe("c5a7f854291974630f3595aa1ef45466beca67c6");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44600709897",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44600709897/job/135831028234",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44600709897/job/135831028201",
    ],
  });
  expect(row.sourceCommits).toEqual(["53e4dc7884c2e5336e57d8c6e901619896a3ddc0"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1529858, "index.cjs": 1462849 });
  expect(row.root.delta).toEqual({ "index.mjs": 186, "index.cjs": 180 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(700);
    expect(rootCeilingFor({ ...ledger, tc3661ShareLinkHostRoot: undefined, tc3522LeaseAskRoot: undefined, tc3443GenericManifestRoot: undefined, tc3688AccountIndexGuardRoot: undefined, tc3443SessionRetireRoot: undefined, tc3443PortFolderRoot: undefined, tc3704OpenKeyPromptRoot: undefined, tc3731ManifestOwnerRoot: undefined, tc3443AppIdLineBreakRoot: undefined, tc3549KeptApprovalsRoot: undefined, tc3617HostedMcpLeaseRoot: undefined, tc3947ReplicaRevokeRoot: undefined, tc3801NamedKeysRoot: undefined, tc3969SecretKeyCoverageRoot: undefined, tc3823BotHistoryKeyRoot: undefined, tc3802SecretKeyCapRoot: undefined, tc3862ExplorerOriginRoot: undefined, tc3522InvocationRefusalRoot: undefined, tc3810ReaderRoot: undefined }, format)).toEqual({ row: "tc2490OneApprovalRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc2490OneApprovalRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-2490 refuses mutation, removal, or a missing TC-3448 predecessor", () => {
  const row = ledger.tc2490OneApprovalRoot;
  validateTc2490OneApprovalRootTransition(undefined, row);
  validateTc2490OneApprovalRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc2490OneApprovalRootTransition(undefined, changed)).toThrow("TC-2490");
    expect(() => validateLedger({ ...ledger, tc2490OneApprovalRoot: changed })).toThrow("TC-2490");
  }

  expect(() => validateTc2490OneApprovalRootTransition(row, undefined)).toThrow("TC-2490");
  expect(() => validateLedger({ ...ledger, tc3448OnBehalfPromptRoot: undefined })).toThrow("TC-2490");
});
