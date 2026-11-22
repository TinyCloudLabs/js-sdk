import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3841TeeVerifyRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3841TeeVerifyRootTransition,
} from "./replica-size-policy";

test("TC-3841 records the exact canonical CI root bytes of #1132: index.cjs only, mjs ceiling unchanged", () => {
  validateLedger(ledger);
  const row = ledger.tc3841TeeVerifyRoot;
  const predecessor = ledger.tc2490OneApprovalRoot;
  expect(row).toEqual(approvedTc3841TeeVerifyRoot);
  expect(row.base).toBe("cb3edeab4f66ae2fc7f84243c7b8fdc3a15fc812");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45028752915",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45028752915/job/137228088791",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/45028752915/job/137228088695",
    ],
  });
  expect(row.sourceCommits).toEqual(["7e76617192c07168a955658ae3faf59a5c2d302a"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1529858, "index.cjs": 1463391 });
  expect(row.root.delta).toEqual({ "index.mjs": 0, "index.cjs": 542 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(row.root.delta[format]);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3841TeeVerifyRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3841TeeVerifyRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3841 refuses mutation, removal, or a missing TC-2490 predecessor", () => {
  const row = ledger.tc3841TeeVerifyRoot;
  validateTc3841TeeVerifyRootTransition(undefined, row);
  validateTc3841TeeVerifyRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.ceiling["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.run = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3841TeeVerifyRootTransition(undefined, changed)).toThrow("TC-3841");
    expect(() => validateLedger({ ...ledger, tc3841TeeVerifyRoot: changed })).toThrow("TC-3841");
  }

  expect(() => validateTc3841TeeVerifyRootTransition(row, undefined)).toThrow("TC-3841");
  expect(() => validateLedger({ ...ledger, tc2490OneApprovalRoot: undefined })).toThrow("TC-3841");
});
