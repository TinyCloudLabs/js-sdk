import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3549KeptApprovalsRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3549KeptApprovalsRootTransition,
} from "./replica-size-policy";

test("TC-3549 records the exact canonical CI root bytes of #1102 within the ruled allowance", () => {
  validateLedger(ledger);
  const row = ledger.tc3549KeptApprovalsRoot;
  const predecessor = ledger.tc3443AppIdLineBreakRoot;
  expect(row).toEqual(approvedTc3549KeptApprovalsRoot);
  expect(row.base).toBe("6e4d8ab69d787f25723038728ee56da11d03657f");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45085618316",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45085618316/job/137403426242",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45085618316/job/137403426480",
    ],
  });
  expect(row.sourceCommits).toEqual(["39b0fd671d1865b7708a149055576a8f2d99816a"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1535425, "index.cjs": 1466887 });
  expect(row.root.delta).toEqual({ "index.mjs": 894, "index.cjs": 808 });
  expect(row.ruling).toContain("size-ruling: TC-3549 (2026-11-23)");

  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(rootCeilingFor({ ...ledger, tc3617HostedMcpLeaseRoot: undefined, tc3947ReplicaRevokeRoot: undefined, tc3801NamedKeysRoot: undefined, tc3969SecretKeyCoverageRoot: undefined, tc3823BotHistoryKeyRoot: undefined, tc3802SecretKeyCapRoot: undefined, tc3862ExplorerOriginRoot: undefined, tc3522InvocationRefusalRoot: undefined, tc3810ReaderRoot: undefined, tc3975NamedKeyWarningRoot: undefined, tc4082HostedOwnerRoot: undefined, tc3891OwnerRegistryRecordRoot: undefined, tc4222PermissionLineRoot: undefined, tc4322ReservedKeyRoot: undefined, tc4329ActivationCauseRoot: undefined, tc4344OpenKeyAccountSetupRoot: undefined, tc4344HostedOwnerSetupOfferRoot: undefined }, format)).toEqual({ row: "tc3549KeptApprovalsRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3549KeptApprovalsRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3549 refuses mutation, removal, or a missing TC-3443 line-break predecessor", () => {
  const row = ledger.tc3549KeptApprovalsRoot;
  validateTc3549KeptApprovalsRootTransition(undefined, row);
  validateTc3549KeptApprovalsRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3549KeptApprovalsRootTransition(undefined, changed)).toThrow("TC-3549");
    expect(() => validateLedger({ ...ledger, tc3549KeptApprovalsRoot: changed })).toThrow("TC-3549");
  }

  expect(() => validateTc3549KeptApprovalsRootTransition(row, undefined)).toThrow("TC-3549");
  expect(() => validateLedger({ ...ledger, tc3443AppIdLineBreakRoot: undefined })).toThrow("TC-3549");
});
