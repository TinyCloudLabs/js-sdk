import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3704OpenKeyPromptRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3704OpenKeyPromptRootTransition,
} from "./replica-size-policy";

test("TC-3704 records the exact canonical CI root bytes of #1117 within the ruled +400/+350 cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3704OpenKeyPromptRoot;
  const predecessor = ledger.tc3443PortFolderRoot;
  expect(row).toEqual(approvedTc3704OpenKeyPromptRoot);
  expect(row.base).toBe("fbdbaa7ba8e66fb0fc91d2815df2a5eb90299c94");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45074741963",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45074741963/job/137369362680",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45074741963/job/137369362946",
    ],
  });
  expect(row.sourceCommits).toEqual(["ac08001eab851e5e4965a855f3179c791831fd00"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1533915, "index.cjs": 1465566 });
  expect(row.root.delta).toEqual({ "index.mjs": 333, "index.cjs": 281 });

  const cap = { "index.mjs": 400, "index.cjs": 350 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor({ ...ledger, tc3731ManifestOwnerRoot: undefined, tc3443AppIdLineBreakRoot: undefined, tc3549KeptApprovalsRoot: undefined, tc3617HostedMcpLeaseRoot: undefined, tc3947ReplicaRevokeRoot: undefined, tc3801NamedKeysRoot: undefined, tc3969SecretKeyCoverageRoot: undefined }, format)).toEqual({ row: "tc3704OpenKeyPromptRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3704OpenKeyPromptRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3704 refuses mutation, removal, or a missing TC-3443 port-folder predecessor", () => {
  const row = ledger.tc3704OpenKeyPromptRoot;
  validateTc3704OpenKeyPromptRootTransition(undefined, row);
  validateTc3704OpenKeyPromptRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3704OpenKeyPromptRootTransition(undefined, changed)).toThrow("TC-3704");
    expect(() => validateLedger({ ...ledger, tc3704OpenKeyPromptRoot: changed })).toThrow("TC-3704");
  }

  expect(() => validateTc3704OpenKeyPromptRootTransition(row, undefined)).toThrow("TC-3704");
  expect(() => validateLedger({ ...ledger, tc3443PortFolderRoot: undefined })).toThrow("TC-3704");
});
