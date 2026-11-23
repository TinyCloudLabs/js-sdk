import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3522LeaseAskRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3522LeaseAskRootTransition,
} from "./replica-size-policy";

test("TC-3522 records the exact canonical CI root bytes of #1123 within the ruled +100/+100 cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3522LeaseAskRoot;
  const predecessor = ledger.tc3661ShareLinkHostRoot;
  expect(row).toEqual(approvedTc3522LeaseAskRoot);
  expect(row.base).toBe("628be3c4bd1c633bb7f676f6c32c761cf8b596df");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45054824553",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45054824553/job/137307609390",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45054824553/job/137307609492",
    ],
  });
  expect(row.sourceCommits).toEqual(["e4913f37af9b5fef23f6874895a160bae5d08ee8"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1530103, "index.cjs": 1463084 });
  expect(row.root.delta).toEqual({ "index.mjs": 50, "index.cjs": 87 });

  const cap = { "index.mjs": 100, "index.cjs": 100 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor({ ...ledger, tc3443GenericManifestRoot: undefined, tc3688AccountIndexGuardRoot: undefined, tc3443SessionRetireRoot: undefined, tc3443PortFolderRoot: undefined, tc3704OpenKeyPromptRoot: undefined, tc3731ManifestOwnerRoot: undefined, tc3443AppIdLineBreakRoot: undefined, tc3549KeptApprovalsRoot: undefined, tc3617HostedMcpLeaseRoot: undefined, tc3947ReplicaRevokeRoot: undefined, tc3801NamedKeysRoot: undefined, tc3969SecretKeyCoverageRoot: undefined, tc3823BotHistoryKeyRoot: undefined, tc3802SecretKeyCapRoot: undefined }, format)).toEqual({ row: "tc3522LeaseAskRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3522LeaseAskRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3522 refuses mutation, removal, or a missing TC-3661 predecessor", () => {
  const row = ledger.tc3522LeaseAskRoot;
  validateTc3522LeaseAskRootTransition(undefined, row);
  validateTc3522LeaseAskRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3522LeaseAskRootTransition(undefined, changed)).toThrow("TC-3522");
    expect(() => validateLedger({ ...ledger, tc3522LeaseAskRoot: changed })).toThrow("TC-3522");
  }

  expect(() => validateTc3522LeaseAskRootTransition(row, undefined)).toThrow("TC-3522");
  expect(() => validateLedger({ ...ledger, tc3661ShareLinkHostRoot: undefined })).toThrow("TC-3522");
});
