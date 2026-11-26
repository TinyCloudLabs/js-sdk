import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3969SecretKeyCoverageRootTransition,
} from "./replica-size-policy";

test("the secrets permission fixes use their exact measured Web SDK root ceilings", () => {
  validateLedger(ledger);
  const row = ledger.tc3969SecretKeyCoverageRoot;
  const prior = ledger.tc3801NamedKeysRoot;
  expect(row.base).toBe("bc48358291cd70d37566a85b6d50d62357ccdbb3");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45143940197",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45143940197/job/137588595331",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45143940197/job/137588595402",
    ],
  });
  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3969SecretKeyCoverageRoot", pin: "c302d7ce91aa00fa0df1f0edb85e5296010fc23d",
  });
  expect(row.root.ceiling).toEqual({ "index.mjs": 1539389, "index.cjs": 1471374 });
  expect(row.root.delta).toEqual({ "index.mjs": 21, "index.cjs": 30 });
  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(rootCeilingFor({ ...ledger, tc3823BotHistoryKeyRoot: undefined, tc3802SecretKeyCapRoot: undefined, tc3862ExplorerOriginRoot: undefined, tc3522InvocationRefusalRoot: undefined, tc3810ReaderRoot: undefined, tc3975NamedKeyWarningRoot: undefined, tc4082HostedOwnerRoot: undefined, tc3891OwnerRegistryRecordRoot: undefined, tc4222PermissionLineRoot: undefined, tc4322ReservedKeyRoot: undefined, tc4329ActivationCauseRoot: undefined }, format)).toEqual({ row: "tc3969SecretKeyCoverageRoot", ceiling: prior.root.ceiling[format] + row.root.delta[format] });
  }
});

test("the secrets permission size ruling cannot change, disappear or replace another bucket", () => {
  const row = ledger.tc3969SecretKeyCoverageRoot;
  validateTc3969SecretKeyCoverageRootTransition(undefined, row);
  validateTc3969SecretKeyCoverageRootTransition(row, structuredClone(row));
  const changed = structuredClone(row);
  changed.root.ceiling["index.cjs"]++;
  expect(() => validateLedger({ ...ledger, tc3969SecretKeyCoverageRoot: changed })).toThrow("TC-3969");
  expect(() => validateLedger({ ...ledger, tc3801NamedKeysRoot: undefined })).toThrow("TC-3969");
  expect(() => validateTc3969SecretKeyCoverageRootTransition(row, undefined)).toThrow("TC-3969");
  const worker = { delta: 1, ceiling: 781192 };
  const expanded = { ...row, worker };
  expect(() => validateLedger({ ...ledger, tc3969SecretKeyCoverageRoot: expanded })).toThrow("TC-3969");
});
