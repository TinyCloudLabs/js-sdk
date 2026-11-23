import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  ancestryPins,
  rootCeilingFor,
  validateLedger,
} from "./replica-size-policy";

test("the bot-history key uses its exact measured Web SDK root ceilings", () => {
  expect(rootCeilingFor({ ...ledger, tc3802SecretKeyCapRoot: undefined, tc3862ExplorerOriginRoot: undefined, tc3522InvocationRefusalRoot: undefined, tc3810ReaderRoot: undefined }, "index.mjs")).toEqual({ row: "tc3823BotHistoryKeyRoot", ceiling: 1539508 });
  expect(rootCeilingFor({ ...ledger, tc3802SecretKeyCapRoot: undefined, tc3862ExplorerOriginRoot: undefined, tc3522InvocationRefusalRoot: undefined, tc3810ReaderRoot: undefined }, "index.cjs")).toEqual({ row: "tc3823BotHistoryKeyRoot", ceiling: 1471446 });
  validateLedger(ledger);
  const row = ledger.tc3823BotHistoryKeyRoot;
  const prior = ledger.tc3969SecretKeyCoverageRoot;
  expect(row.base).toBe("a974542e479c6f3c5d4fab10784a330a6003983d");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45153655976",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45153655976/job/137621049279",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45153655976/job/137621049305",
    ],
  });
  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3823BotHistoryKeyRoot", pin: "a8692311198e3b4643eb6018255c9013bf19c7bd",
  });
  expect(row.root.delta).toEqual({ "index.mjs": 119, "index.cjs": 72 });
  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format]).toBe(prior.root.ceiling[format] + row.root.delta[format]);
  }
});

test("the bot-history size ruling requires its predecessor and refuses a different ceiling or bucket", () => {
  expect(() => validateLedger({ ...ledger, tc3969SecretKeyCoverageRoot: undefined })).toThrow("TC-3823");
  const row = ledger.tc3823BotHistoryKeyRoot;
  const changed = structuredClone(row);
  changed.root.ceiling["index.cjs"]++;
  expect(() => validateLedger({ ...ledger, tc3823BotHistoryKeyRoot: changed })).toThrow("TC-3823");
  const expanded = { ...row, worker: { delta: 1, ceiling: 781192 } };
  expect(() => validateLedger({ ...ledger, tc3823BotHistoryKeyRoot: expanded })).toThrow("TC-3823");
});
