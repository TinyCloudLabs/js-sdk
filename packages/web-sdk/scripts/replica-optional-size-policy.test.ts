import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  correctedOptionalAllowance, validateOptionalEntryTransition, validateOptionalLedger, type OptionalLedger,
} from "./replica-optional-size-policy";

const current = JSON.parse(readFileSync(resolve(import.meta.dir, "replica-optional-size-ledger.json"), "utf8")) as OptionalLedger;
const copy = () => structuredClone(current);
const observed = { "replica.mjs": 51791, "replica.cjs": 67009, "activation.mjs": 23071, "activation.cjs": 24650 };

describe("TC-858 optional loaded-byte policy", () => {
  it("accepts the exact approved first-import, activation and refused-admission ledger", () => {
    expect(() => validateOptionalLedger(current, true, true)).not.toThrow();
    const beforeFix = copy();
    beforeFix.allowance = correctedOptionalAllowance;
    beforeFix.entries = [];
    delete beforeFix.fixRequired;
    expect(() => validateOptionalLedger(beforeFix)).not.toThrow();
  });

  it("rejects one extra first-import ESM byte", () => {
    const changed = copy();
    changed.allowance["replica.mjs"]++;
    expect(() => validateOptionalLedger(changed, true, true)).toThrow();
  });

  it("rejects one extra deferred activation CJS byte", () => {
    const changed = copy();
    changed.allowance["activation.cjs"]++;
    expect(() => validateOptionalLedger(changed, true, true)).toThrow();
  });

  it("rejects the old local first-import and activation readings as canonical allowances", () => {
    const oldLocal = copy();
    oldLocal.allowance["replica.mjs"] = 51786;
    oldLocal.allowance["activation.mjs"] = 23073;
    oldLocal.allowance["activation.cjs"] = 24653;
    expect(() => validateOptionalLedger(oldLocal, true, true)).toThrow();
    expect(() => validateOptionalEntryTransition([], [{
      ...current.entries[0],
      "replica.mjs": 51786,
      "activation.mjs": 23073,
      "activation.cjs": 24653,
    }], observed, "#548")).toThrow();
  });

  it("rejects a changed measurement correction witness", () => {
    const changed = copy();
    (changed.measurementCorrection as { ciJob: string }).ciJob = "unreviewed job";
    expect(() => validateOptionalLedger(changed, true, true)).toThrow();
  });

  it("rejects removing the canonical toolchain measurement correction", () => {
    const changed = copy();
    delete changed.measurementCorrection;
    expect(() => validateOptionalLedger(changed, true, true)).toThrow();
  });

  it("rejects a mutated paired root-to-optional relocation", () => {
    const changed = copy();
    (changed.relocations as Array<{ "replica.mjs"?: number }>)[1]["replica.mjs"]!++;
    expect(() => validateOptionalLedger(changed, true, true)).toThrow();
  });
});

describe("TC-858 merge-base optional ledger prefix", () => {
  const merged = { ...current.entries[0], pr: "#550", note: "Already merged and immutable" };

  it("accepts the exact observed #548 row following unchanged merged rows", () => {
    expect(() => validateOptionalEntryTransition([merged], [merged, current.entries[0]], observed, "#548")).not.toThrow();
    expect(() => validateOptionalEntryTransition([], [current.entries[0]], observed, "#548")).not.toThrow();
  });

  it("rejects edits to a merged row's bytes or metadata", () => {
    const altered = { ...merged, "replica.mjs": merged["replica.mjs"] + 1 };
    expect(() => validateOptionalEntryTransition([merged], [altered, current.entries[0]], observed, "#548")).toThrow();
    expect(() => validateOptionalEntryTransition([merged], [{ ...merged, note: "Reclassified" }, current.entries[0]], observed, "#548")).toThrow();
  });

  it("rejects a stale, missing or duplicate unmerged #548 measurement", () => {
    const stale = { ...current.entries[0], "activation.cjs": 24651 };
    expect(() => validateOptionalEntryTransition([], [stale], observed, "#548")).toThrow();
    expect(() => validateOptionalEntryTransition([], [], observed, "#548")).toThrow();
    expect(() => validateOptionalEntryTransition([], [current.entries[0], current.entries[0]], observed, "#548")).toThrow();
  });
  it("rejects a measured row assigned to another PR number", () => {
    const wrongPr = { ...current.entries[0], pr: "#999" };
    expect(() => validateOptionalEntryTransition([], [wrongPr], observed, "#548")).toThrow();
  });

  it("rejects appending a second #548 after a merged #548 prefix row", () => {
    expect(() => validateOptionalEntryTransition(
      [current.entries[0]], [current.entries[0], current.entries[0]], observed, "#548",
    )).toThrow();
  });
});

describe("TC-858 Rust 1.99.0 optional measurement correction", () => {
  it("requires the root's exact CI correction before accepting rebuilt optional measurements", () => {
    expect(() => validateOptionalLedger(current, true)).toThrow();
  });
});

describe("TC-858 compact delegate installed-grant fix-required first import", () => {
  const authority = "packages/node-sdk/src/replication/authority.ts";
  const approved = {
    sourceCommit: "a5b1ae1fc61ff352d6ea6940a1791d6cf01f1492",
    integratedCommit: "b796dc52894524ee01a4458f640ecf45906b3040",
    ruling: "Naomi TC-858 compact delegate §3:646, 2026-10-16",
    controlledAB: {
      before: { "replica.mjs": 52355, "replica.cjs": 67328 },
      after: { "replica.mjs": 52362, "replica.cjs": 67332 },
      delta: { "replica.mjs": 7, "replica.cjs": 4 },
    },
    measuredPaths: { [authority]: "0990eecad96ebaa25a615fafe7558ec124b62c7f" },
    canonicalCI: {
      run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/38977256904",
      jobs: [
        "https://github.com/TinyCloudLabs/js-sdk/actions/runs/38977256904/job/117229580745",
        "https://github.com/TinyCloudLabs/js-sdk/actions/runs/38977256904/job/117229580982",
      ],
      before: { "replica.mjs": 51785, "replica.cjs": 66995 },
      after: { "replica.mjs": 51791, "replica.cjs": 67009 },
      delta: { "replica.mjs": 6, "replica.cjs": 14 },
      source: "Only measured-input change: approved authority.ts blob 0990eecad96ebaa25a615fafe7558ec124b62c7f",
    },
    status: "final: GitHub CI canonical, zero headroom",
  };
  const fixed = () => {
    const ledger = copy() as OptionalLedger & { fixRequired?: unknown };
    ledger.fixRequired = [structuredClone(approved)];
    ledger.allowance["replica.mjs"] = 51791;
    ledger.allowance["replica.cjs"] = 67009;
    ledger.entries[0]["replica.mjs"] = 51791;
    ledger.entries[0]["replica.cjs"] = 67009;
    return ledger;
  };

  it("admits only the signed compact fix's canonical first-import bytes", () => {
    expect(() => validateOptionalLedger(fixed(), true, true)).not.toThrow();
  });

  it("rejects another byte, another source blob, another row or activation growth", () => {
    const extraByte = fixed();
    extraByte.allowance["replica.mjs"]++;
    expect(() => validateOptionalLedger(extraByte, true, true)).toThrow();
    const changedBlob = fixed();
    (changedBlob.fixRequired as typeof approved[])[0].measuredPaths[authority] = "deadbeef";
    expect(() => validateOptionalLedger(changedBlob, true, true)).toThrow();
    const wrongCI = fixed();
    (wrongCI.fixRequired as typeof approved[])[0].canonicalCI.jobs[0] = "unreviewed job";
    expect(() => validateOptionalLedger(wrongCI, true, true)).toThrow();
    const secondRow = fixed();
    (secondRow.fixRequired as typeof approved[]).push(approved);
    expect(() => validateOptionalLedger(secondRow, true, true)).toThrow();
    const activation = fixed();
    activation.allowance["activation.cjs"]++;
    expect(() => validateOptionalLedger(activation, true, true)).toThrow();
  });
});
