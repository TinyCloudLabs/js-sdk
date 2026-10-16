import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { approvedGatedOnlyRatchet, validateGatedOnlyRatchet, validateLedger, type Ledger } from "./replica-size-policy";

const current = JSON.parse(readFileSync(resolve(import.meta.dir, "replica-size-ledger.json"), "utf8")) as Ledger;
const historical: Ledger = {
  ...current,
  phase2Ratchet: {
    ...current.phase2Ratchet!,
    toolchain: "Bun 1.4.3; production webpack; gzip -9 -c",
  },
};

const copy = (ledger: Ledger) => structuredClone(ledger);

describe("TC-858 canonical size ratchet transition", () => {
  it("accepts the former Bun 1.4.3 parent only as the historical base and the Bun 1.3.14 ledger as current", () => {
    expect(() => validateLedger(historical, true)).not.toThrow();
    expect(() => validateLedger(historical)).toThrow();
    expect(() => validateLedger(current)).not.toThrow();
  });

  it("rejects any other base toolchain and all later toolchain changes", () => {
    const wrongBase = copy(historical);
    wrongBase.phase2Ratchet!.toolchain = "Bun 1.4.4; production webpack; gzip -9 -c";
    expect(() => validateLedger(wrongBase, true)).toThrow();
    const wrongCurrent = copy(current);
    wrongCurrent.phase2Ratchet!.toolchain = "Bun 1.4.3; production webpack; gzip -9 -c";
    expect(() => validateLedger(wrongCurrent)).toThrow();
  });

  it("keeps the exact historical allowance and root baseline, delta, and absolute ceilings on both sides", () => {
    for (const base of [historical, current]) {
      const invalidCeiling = copy(base);
      invalidCeiling.phase2Ratchet!.ceiling["index.mjs"]++;
      expect(() => validateLedger(invalidCeiling, base === historical)).toThrow();
      const invalidBaseline = copy(base);
      invalidBaseline.phase2Ratchet!.baseline["index.cjs"]++;
      expect(() => validateLedger(invalidBaseline, base === historical)).toThrow();
      const invalidAllowance = copy(base);
      invalidAllowance.allowance["index.mjs"]++;
      expect(() => validateLedger(invalidAllowance, base === historical)).toThrow();
    }
  });
});

describe("TC-858 deferred refused-admission artifact", () => {
  it("allows only the exact first ratchet, with no base-row change", () => {
    expect(() => validateGatedOnlyRatchet(approvedGatedOnlyRatchet)).not.toThrow();
    expect(() => validateGatedOnlyRatchet(approvedGatedOnlyRatchet, approvedGatedOnlyRatchet)).not.toThrow();
    expect(() => validateGatedOnlyRatchet(undefined, approvedGatedOnlyRatchet)).toThrow();
  });

  it("rejects later cap, trigger, source or toolchain changes", () => {
    const changed = structuredClone(approvedGatedOnlyRatchet);
    changed.ceiling["replica-gated.mjs"]++;
    expect(() => validateGatedOnlyRatchet(changed, approvedGatedOnlyRatchet)).toThrow();
    changed.ceiling["replica-gated.mjs"]--;
    changed.ceiling["replica-gated.cjs"]++;
    expect(() => validateGatedOnlyRatchet(changed)).toThrow();
    changed.ceiling["replica-gated.cjs"]--;
    changed.trigger = "Every opt-in client loads the observer";
    expect(() => validateGatedOnlyRatchet(changed)).toThrow();
    changed.trigger = approvedGatedOnlyRatchet.trigger;
    changed.sourceCommit = "unreviewed source";
    expect(() => validateGatedOnlyRatchet(changed)).toThrow();
    changed.sourceCommit = approvedGatedOnlyRatchet.sourceCommit;
    changed.toolchain = "Bun 1.4.3";
    expect(() => validateGatedOnlyRatchet(changed)).toThrow();
  });
});
