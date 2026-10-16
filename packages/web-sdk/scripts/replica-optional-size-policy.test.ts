import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  correctedOptionalAllowance, validateOptionalEntryTransition, validateOptionalLedger, type OptionalLedger,
} from "./replica-optional-size-policy";

const current = JSON.parse(readFileSync(resolve(import.meta.dir, "replica-optional-size-ledger.json"), "utf8")) as OptionalLedger;
const copy = () => structuredClone(current);
const observed = { "replica.mjs": 51785, "replica.cjs": 66995, "activation.mjs": 23071, "activation.cjs": 24650 };

describe("TC-858 optional loaded-byte policy", () => {
  it("accepts the exact approved first-import, activation and refused-admission ledger", () => {
    expect(() => validateOptionalLedger(current, true)).not.toThrow();
    const beforeFix = copy();
    beforeFix.allowance = correctedOptionalAllowance;
    expect(() => validateOptionalLedger(beforeFix)).not.toThrow();
  });

  it("rejects one extra first-import ESM byte", () => {
    const changed = copy();
    changed.allowance["replica.mjs"]++;
    expect(() => validateOptionalLedger(changed, true)).toThrow();
  });

  it("rejects one extra deferred activation CJS byte", () => {
    const changed = copy();
    changed.allowance["activation.cjs"]++;
    expect(() => validateOptionalLedger(changed, true)).toThrow();
  });

  it("rejects a changed measurement correction witness", () => {
    const changed = copy();
    (changed.measurementCorrection as { ciJob: string }).ciJob = "unreviewed job";
    expect(() => validateOptionalLedger(changed, true)).toThrow();
  });

  it("rejects removing the canonical toolchain measurement correction", () => {
    const changed = copy();
    delete changed.measurementCorrection;
    expect(() => validateOptionalLedger(changed, true)).toThrow();
  });

  it("rejects a mutated paired root-to-optional relocation", () => {
    const changed = copy();
    (changed.relocations as Array<{ "replica.mjs"?: number }>)[1]["replica.mjs"]!++;
    expect(() => validateOptionalLedger(changed, true)).toThrow();
  });
});

describe("TC-858 merge-base optional ledger prefix", () => {
  const merged = { ...current.entries[0], pr: "#550", note: "Already merged and immutable" };

  it("accepts the exact observed #548 row following unchanged merged rows", () => {
    expect(() => validateOptionalEntryTransition([merged], [merged, current.entries[0]], observed)).not.toThrow();
    expect(() => validateOptionalEntryTransition([], [current.entries[0]], observed)).not.toThrow();
  });

  it("rejects edits to a merged row's bytes or metadata", () => {
    const altered = { ...merged, "replica.mjs": merged["replica.mjs"] + 1 };
    expect(() => validateOptionalEntryTransition([merged], [altered, current.entries[0]], observed)).toThrow();
    expect(() => validateOptionalEntryTransition([merged], [{ ...merged, note: "Reclassified" }, current.entries[0]], observed)).toThrow();
  });

  it("rejects a stale, missing or duplicate unmerged #548 measurement", () => {
    const stale = { ...current.entries[0], "activation.cjs": 24654 };
    expect(() => validateOptionalEntryTransition([], [stale], observed)).toThrow();
    expect(() => validateOptionalEntryTransition([], [], observed)).toThrow();
    expect(() => validateOptionalEntryTransition([], [current.entries[0], current.entries[0]], observed)).toThrow();
  });
});
