import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3688AccountIndexGuardRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3688AccountIndexGuardRootTransition,
} from "./replica-size-policy";

test("TC-3688 records the exact canonical CI root bytes of #1116 within the ruled +150/+150 cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3688AccountIndexGuardRoot;
  const predecessor = ledger.tc3443GenericManifestRoot;
  expect(row).toEqual(approvedTc3688AccountIndexGuardRoot);
  expect(row.base).toBe("2cb453f6523219d12bce66489fc2625782e970fa");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45063241608",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45063241608/job/137333621784",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45063241608/job/137333621819",
    ],
  });
  expect(row.sourceCommits).toEqual(["13fe661a2d7535b5493e83b42efe4d288722ac1a"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1530603, "index.cjs": 1463337 });
  expect(row.root.delta).toEqual({ "index.mjs": 104, "index.cjs": 102 });

  const cap = { "index.mjs": 150, "index.cjs": 150 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor({ ...ledger, tc3443SessionRetireRoot: undefined, tc3443PortFolderRoot: undefined, tc3704OpenKeyPromptRoot: undefined, tc3731ManifestOwnerRoot: undefined, tc3443AppIdLineBreakRoot: undefined, tc3549KeptApprovalsRoot: undefined, tc3617HostedMcpLeaseRoot: undefined, tc3947ReplicaRevokeRoot: undefined, tc3801NamedKeysRoot: undefined, tc3969SecretKeyCoverageRoot: undefined, tc3823BotHistoryKeyRoot: undefined, tc3802SecretKeyCapRoot: undefined }, format)).toEqual({ row: "tc3688AccountIndexGuardRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3688AccountIndexGuardRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3688 refuses mutation, removal, or a missing TC-3443 predecessor", () => {
  const row = ledger.tc3688AccountIndexGuardRoot;
  validateTc3688AccountIndexGuardRootTransition(undefined, row);
  validateTc3688AccountIndexGuardRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3688AccountIndexGuardRootTransition(undefined, changed)).toThrow("TC-3688");
    expect(() => validateLedger({ ...ledger, tc3688AccountIndexGuardRoot: changed })).toThrow("TC-3688");
  }

  expect(() => validateTc3688AccountIndexGuardRootTransition(row, undefined)).toThrow("TC-3688");
  expect(() => validateLedger({ ...ledger, tc3443GenericManifestRoot: undefined })).toThrow("TC-3688");
});
