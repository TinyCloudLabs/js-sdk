import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3443PortFolderRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3443PortFolderRootTransition,
} from "./replica-size-policy";

test("TC-3443 records the exact canonical CI root bytes of #1134 within the ruled +1914/+865 cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3443PortFolderRoot;
  const predecessor = ledger.tc3443SessionRetireRoot;
  expect(row).toEqual(approvedTc3443PortFolderRoot);
  expect(row.base).toBe("d382af88a04cfe10c04ad70f82ffdc3c6cf3aa15");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45071400680",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45071400680/job/137358939899",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45071400680/job/137358940187",
    ],
  });
  expect(row.sourceCommits).toEqual(["3bb106314aa21a3c29d2d42cd1daa74cf1d3211b"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1533582, "index.cjs": 1465285 });
  expect(row.root.delta).toEqual({ "index.mjs": 1914, "index.cjs": 865 });

  const cap = { "index.mjs": 1914, "index.cjs": 865 } as const;
  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(cap[format]);
    expect(rootCeilingFor({ ...ledger, tc3704OpenKeyPromptRoot: undefined, tc3731ManifestOwnerRoot: undefined, tc3443AppIdLineBreakRoot: undefined, tc3549KeptApprovalsRoot: undefined, tc3617HostedMcpLeaseRoot: undefined, tc3947ReplicaRevokeRoot: undefined, tc3801NamedKeysRoot: undefined, tc3969SecretKeyCoverageRoot: undefined, tc3823BotHistoryKeyRoot: undefined, tc3802SecretKeyCapRoot: undefined, tc3862ExplorerOriginRoot: undefined, tc3522InvocationRefusalRoot: undefined }, format)).toEqual({ row: "tc3443PortFolderRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3443PortFolderRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3443 port-folder row refuses mutation, removal, or a missing session-retire predecessor", () => {
  const row = ledger.tc3443PortFolderRoot;
  validateTc3443PortFolderRootTransition(undefined, row);
  validateTc3443PortFolderRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3443PortFolderRootTransition(undefined, changed)).toThrow("port-folder");
    expect(() => validateLedger({ ...ledger, tc3443PortFolderRoot: changed })).toThrow("port-folder");
  }

  expect(() => validateTc3443PortFolderRootTransition(row, undefined)).toThrow("port-folder");
  expect(() => validateLedger({ ...ledger, tc3443SessionRetireRoot: undefined })).toThrow("TC-3443");
});
