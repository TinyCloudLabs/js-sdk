import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import {
  approvedTc3443GenericManifestRoot,
  ancestryPins,
  rootCeilingFor,
  validateLedger,
  validateTc3443GenericManifestRootTransition,
} from "./replica-size-policy";

test("TC-3443 records the exact canonical CI root bytes of #1099 within the 800-byte cap", () => {
  validateLedger(ledger);
  const row = ledger.tc3443GenericManifestRoot;
  const predecessor = ledger.tc3448OnBehalfPromptRoot;
  expect(row).toEqual(approvedTc3443GenericManifestRoot);
  expect(row.base).toBe("c5a7f854291974630f3595aa1ef45466beca67c6");
  expect(row.canonicalCI).toEqual({
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44595739813",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44595739813/job/135813379736",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/44595739813/job/135813379768",
    ],
  });
  expect(row.sourceCommits).toEqual(["fbfebee0d1a134eee0f49c52261f5a53dbf65c60"]);
  expect(row.root.ceiling).toEqual({ "index.mjs": 1530082, "index.cjs": 1462839 });
  expect(row.root.delta).toEqual({ "index.mjs": 410, "index.cjs": 170 });

  for (const format of ["index.mjs", "index.cjs"] as const) {
    const delta = row.root.delta[format];
    expect(row.root.ceiling[format] - predecessor.root.ceiling[format]).toBe(delta);
    expect(delta).toBeLessThanOrEqual(800);
    expect(rootCeilingFor(ledger, format)).toEqual({ row: "tc3443GenericManifestRoot", ceiling: row.root.ceiling[format] });
  }

  expect(ancestryPins(ledger, false)).toContainEqual({
    row: "tc3443GenericManifestRoot",
    pin: row.sourceCommits.at(-1),
  });
  expect(Object.keys(row).sort()).toEqual([
    "base", "canonicalCI", "label", "reason", "root", "ruling", "sourceCommits",
  ]);
});

test("TC-3443 refuses mutation, removal, or a missing TC-3448 predecessor", () => {
  const row = ledger.tc3443GenericManifestRoot;
  validateTc3443GenericManifestRootTransition(undefined, row);
  validateTc3443GenericManifestRootTransition(row, structuredClone(row));

  for (const mutate of [
    (value: typeof row) => { value.root.ceiling["index.cjs"]++; },
    (value: typeof row) => { value.root.delta["index.mjs"]++; },
    (value: typeof row) => { value.sourceCommits[0] = "0".repeat(40); },
    (value: typeof row) => { value.canonicalCI.jobs[0] = "unreviewed"; },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    expect(() => validateTc3443GenericManifestRootTransition(undefined, changed)).toThrow("TC-3443");
    expect(() => validateLedger({ ...ledger, tc3443GenericManifestRoot: changed })).toThrow("TC-3443");
  }

  expect(() => validateTc3443GenericManifestRootTransition(row, undefined)).toThrow("TC-3443");
  expect(() => validateLedger({ ...ledger, tc3448OnBehalfPromptRoot: undefined })).toThrow("TC-3443");
});
