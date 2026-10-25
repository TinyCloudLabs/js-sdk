import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compactFixOptionalAllowance, correctedOptionalAllowance, hardeningOptionalAllowance, tc1413OptionalAllowance, tc1432OptionalAllowance, tc1475OptionalAllowance, masterDriftOptionalAllowance, tc1789OptionalAllowance, validateIntroducedOptionalSources,
  validateOptionalEntryTransition, validateOptionalLedger, type OptionalLedger,
} from "./replica-optional-size-policy";
import { approvedMasterDriftRatchet, approvedTc1432Ratchet, approvedTc1475Ratchet, approvedTc1789Ratchet, approvedTc1888PurgeLocalCopyRatchet } from "./replica-size-policy";

const shipped = JSON.parse(readFileSync(resolve(import.meta.dir, "replica-optional-size-ledger.json"), "utf8")) as OptionalLedger;
// The tests below cover the #565 hardening-era ledger; TC-1413's own allowance is tested at the end.
const current: OptionalLedger = { ...structuredClone(shipped), allowance: { ...hardeningOptionalAllowance } };
const copy = () => structuredClone(current);
const observed = { "replica.mjs": 51791, "replica.cjs": 67009, "activation.mjs": 23071, "activation.cjs": 24650 };

describe("TC-858 optional loaded-byte policy", () => {
  it("accepts the exact approved first-import, activation and refused-admission ledger", () => {
    expect(() => validateOptionalLedger(current, true, true, true)).not.toThrow();
    const beforeFix = copy();
    beforeFix.allowance = correctedOptionalAllowance;
    beforeFix.entries = [];
    delete beforeFix.fixRequired;
    expect(() => validateOptionalLedger(beforeFix)).not.toThrow();
  });

  it("rejects one extra first-import ESM byte", () => {
    const changed = copy();
    changed.allowance["replica.mjs"]++;
    expect(() => validateOptionalLedger(changed, true, true, true)).toThrow();
  });

  it("rejects one extra deferred activation CJS byte", () => {
    const changed = copy();
    changed.allowance["activation.cjs"]++;
    expect(() => validateOptionalLedger(changed, true, true, true)).toThrow();
  });

  it("rejects the old local first-import and activation readings as canonical allowances", () => {
    const oldLocal = copy();
    oldLocal.allowance["replica.mjs"] = 51786;
    oldLocal.allowance["activation.mjs"] = 23073;
    oldLocal.allowance["activation.cjs"] = 24653;
    expect(() => validateOptionalLedger(oldLocal, true, true, true)).toThrow();
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
    expect(() => validateOptionalLedger(changed, true, true, true)).toThrow();
  });

  it("rejects removing the canonical toolchain measurement correction", () => {
    const changed = copy();
    delete changed.measurementCorrection;
    expect(() => validateOptionalLedger(changed, true, true, true)).toThrow();
  });

  it("rejects a mutated paired root-to-optional relocation", () => {
    const changed = copy();
    (changed.relocations as Array<{ "replica.mjs"?: number }>)[1]["replica.mjs"]!++;
    expect(() => validateOptionalLedger(changed, true, true, true)).toThrow();
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
  // The ledger as it stood at the compact fix, before the #565 hardening ratchet.
  const fixed = () => {
    const ledger = copy() as OptionalLedger & { fixRequired?: unknown };
    ledger.fixRequired = [structuredClone(approved)];
    ledger.allowance = { ...compactFixOptionalAllowance };
    ledger.entries = ledger.entries.slice(0, 1);
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

describe("TC-858 #565 hardening optional allowance", () => {
  it("accepts exactly the canonical hardening first-import and activation ceilings", () => {
    expect(() => validateOptionalLedger(current, true, true, true)).not.toThrow();
    expect(current.allowance).toEqual(hardeningOptionalAllowance);
  });

  it("refuses one extra byte in any optional bucket, or the hardening allowance without the compact fix row", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      const changed = copy();
      changed.allowance[format]++;
      expect(() => validateOptionalLedger(changed, true, true, true)).toThrow();
    }
    const withoutCompactFix = copy();
    delete withoutCompactFix.fixRequired;
    expect(() => validateOptionalLedger(withoutCompactFix, true, true, true)).toThrow();
  });

  it("keeps the pre-hardening allowance invalid once the ratchet is present", () => {
    const stale = copy();
    stale.allowance = compactFixOptionalAllowance;
    expect(() => validateOptionalLedger(stale, true, true, true)).toThrow();
  });
});

describe("TC-858 squash-merged source commits", () => {
  // #548 was squash-merged, so its branch commits b796dc52, ce52494d and 2578c6a7 are not in master.
  it("does not require branch source commits for rows already in the merge base", () => {
    expect(() => validateIntroducedOptionalSources(current, current)).not.toThrow();
  });

  it("requires each newly introduced row's source commit in HEAD", () => {
    const withoutCompactFix = copy();
    delete withoutCompactFix.fixRequired;
    expect(() => validateIntroducedOptionalSources(withoutCompactFix, current))
      .toThrow("compact fix requires the integrated source commit");
    const withoutCorrection = copy();
    delete withoutCorrection.measurementCorrection;
    expect(() => validateIntroducedOptionalSources(withoutCorrection, current))
      .toThrow("ce52494d measurement correction requires its approved source ancestor");
    const withoutRelocations = copy();
    delete withoutRelocations.relocations;
    expect(() => validateIntroducedOptionalSources(withoutRelocations, current))
      .toThrow("approved relocation commit is not an ancestor of HEAD");
  });
});

// The ledger as TC-1413 (#574) left it: before TC-1432's allowance and entry.
const tc1413Ledger: OptionalLedger = {
  ...structuredClone(shipped),
  allowance: { ...tc1413OptionalAllowance },
  entries: structuredClone(shipped.entries.slice(0, shipped.entries.findIndex((entry) => entry.pr === "#580"))),
};

describe("TC-1413 optional allowance", () => {
  it("accepts exactly the canonical TC-1413 first-import and activation ceilings", () => {
    expect(() => validateOptionalLedger(tc1413Ledger, true, true, true, true)).not.toThrow();
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      expect(tc1413OptionalAllowance[format] - hardeningOptionalAllowance[format])
        .toBe({ "replica.mjs": 0, "replica.cjs": 1, "activation.mjs": 30, "activation.cjs": 28 }[format]);
    }
  });

  it("refuses one extra byte in any optional bucket, the TC-1413 allowance without #565's, or the old allowance after it", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      const changed = structuredClone(tc1413Ledger);
      changed.allowance[format]++;
      expect(() => validateOptionalLedger(changed, true, true, true, true)).toThrow();
    }
    expect(() => validateOptionalLedger(tc1413Ledger, true, true, false, true)).toThrow();
    expect(() => validateOptionalLedger(tc1413Ledger, true, true, true)).toThrow();
  });

  it("keeps the cumulative entries within the allowance, with this PR's row carrying the measured deltas", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      expect(tc1413Ledger.entries.reduce((sum, entry) => sum + entry[format], 0)).toBeLessThanOrEqual(tc1413Ledger.allowance[format]);
    }
    expect(tc1413Ledger.entries.at(-1)).toMatchObject({
      pr: "#574", ticket: "TC-1413", "replica.mjs": 0, "replica.cjs": 1, "activation.mjs": 30, "activation.cjs": 28,
    });
  });
});

// The ledger as TC-1432 (#580) left it: before TC-1475's allowance and entry.
const tc1432Ledger: OptionalLedger = {
  ...structuredClone(shipped),
  allowance: { ...tc1432OptionalAllowance },
  entries: structuredClone(shipped.entries.slice(0, shipped.entries.findIndex((entry) => entry.pr === "#599"))),
};

describe("TC-1432 optional allowance", () => {
  it("accepts exactly the canonical TC-1432 first-import and activation ceilings", () => {
    expect(() => validateOptionalLedger(tc1432Ledger, true, true, true, true, true)).not.toThrow();
    expect(tc1432Ledger.allowance).toEqual(tc1432OptionalAllowance);
    // TC-1413's replica.mjs ceiling (51,925) sat 1 B above the merge-base measurement (51,924), so the
    // measured +1 lands exactly on the existing ceiling; every other bucket moves by its delta.
    const headroomAtBase = { "replica.mjs": 1, "replica.cjs": 0, "activation.mjs": 0, "activation.cjs": 0 };
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      expect(tc1432OptionalAllowance[format] - tc1413OptionalAllowance[format])
        .toBe({ ...approvedTc1432Ratchet.firstImport.delta, ...approvedTc1432Ratchet.activation.delta }[format] - headroomAtBase[format]);
    }
  });

  it("refuses one extra byte in any optional bucket, the TC-1432 allowance without TC-1413's, or the old allowance after it", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      const changed = structuredClone(tc1432Ledger);
      changed.allowance[format]++;
      expect(() => validateOptionalLedger(changed, true, true, true, true, true)).toThrow();
    }
    expect(() => validateOptionalLedger(tc1432Ledger, true, true, true, false, true)).toThrow();
    expect(() => validateOptionalLedger(tc1432Ledger, true, true, true, true)).toThrow();
  });

  it("keeps the cumulative entries within the allowance, with this PR's row carrying the measured deltas", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      expect(tc1432Ledger.entries.reduce((sum, entry) => sum + entry[format], 0)).toBeLessThanOrEqual(tc1432Ledger.allowance[format]);
    }
    expect(tc1432Ledger.entries.find((entry) => entry.pr === "#580")).toMatchObject({
      pr: "#580", ticket: "TC-1432",
      ...approvedTc1432Ratchet.firstImport.delta, ...approvedTc1432Ratchet.activation.delta,
    });
  });
});

// The ledger as TC-1475 (#599) left it: before the master-drift allowance and entry.
const tc1475Ledger: OptionalLedger = {
  ...structuredClone(shipped),
  allowance: { ...tc1475OptionalAllowance },
  entries: structuredClone(shipped.entries.slice(0, shipped.entries.findIndex((entry) => entry.pr === "#608"))),
};

describe("TC-1475 optional allowance", () => {
  it("accepts exactly the canonical TC-1475 first-import and activation ceilings", () => {
    expect(() => validateOptionalLedger(tc1475Ledger, true, true, true, true, true, true)).not.toThrow();
    expect(tc1475Ledger.allowance).toEqual(tc1475OptionalAllowance);
    // The prior ceilings equal the merge-base measurements, so each bucket moves by exactly its delta.
    const fromPrior = { "replica.mjs": 0, "replica.cjs": 2, "activation.mjs": 11, "activation.cjs": 14 };
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      expect(tc1475OptionalAllowance[format] - tc1432OptionalAllowance[format]).toBe(fromPrior[format]);
    }
  });

  it("refuses one extra byte in any optional bucket, the TC-1475 allowance without TC-1432's, or the old allowance after it", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      const changed = structuredClone(tc1475Ledger);
      changed.allowance[format]++;
      expect(() => validateOptionalLedger(changed, true, true, true, true, true, true)).toThrow();
    }
    expect(() => validateOptionalLedger(tc1475Ledger, true, true, true, true, false, true)).toThrow();
    expect(() => validateOptionalLedger(tc1475Ledger, true, true, true, true, true)).toThrow();
  });

  it("keeps the cumulative entries within the allowance, with this PR's row carrying the measured deltas", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      expect(tc1475Ledger.entries.reduce((sum, entry) => sum + entry[format], 0)).toBeLessThanOrEqual(tc1475Ledger.allowance[format]);
    }
    expect(tc1475Ledger.entries.find((entry) => entry.pr === "#599")).toMatchObject({
      pr: "#599", ticket: "TC-1475",
      ...approvedTc1475Ratchet.firstImport.delta, ...approvedTc1475Ratchet.activation.delta,
    });
  });
});

// The ledger as master left it before the sdk-services 3.3.1 pin: master-drift allowance, without #667's row.
const masterDriftLedger: OptionalLedger = {
  ...structuredClone(shipped),
  allowance: { ...masterDriftOptionalAllowance },
  entries: structuredClone(shipped.entries.slice(0, shipped.entries.findIndex((entry) => entry.pr === "#667"))),
};

describe("master-drift optional allowance", () => {
  it("accepts exactly the canonical ceilings: TC-1475's plus activation.cjs +1", () => {
    expect(() => validateOptionalLedger(masterDriftLedger, true, true, true, true, true, true, true)).not.toThrow();
    expect(masterDriftLedger.allowance).toEqual(masterDriftOptionalAllowance);
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      expect(masterDriftOptionalAllowance[format] - tc1475OptionalAllowance[format])
        .toBe({ ...approvedMasterDriftRatchet.firstImport.delta, ...approvedMasterDriftRatchet.activation.delta }[format]);
    }
  });

  it("refuses one extra byte, the allowance without TC-1475's, or the old allowance after it", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      const changed = structuredClone(masterDriftLedger);
      changed.allowance[format]++;
      expect(() => validateOptionalLedger(changed, true, true, true, true, true, true, true)).toThrow();
    }
    expect(() => validateOptionalLedger(masterDriftLedger, true, true, true, true, false, true, true)).toThrow();
    expect(() => validateOptionalLedger(masterDriftLedger, true, true, true, true, true, true)).toThrow();
  });
});

const tc1789Ledger: OptionalLedger = {
  ...structuredClone(shipped),
  allowance: { ...tc1789OptionalAllowance },
  entries: structuredClone(shipped.entries.slice(0, shipped.entries.findIndex((entry) => entry.pr === "#728"))),
};

describe("sdk-services 3.3.1 pin optional allowance", () => {
  it("accepts exactly the canonical ceilings: master drift's plus replica.cjs +1", () => {
    expect(() => validateOptionalLedger(tc1789Ledger, true, true, true, true, true, true, true, true)).not.toThrow();
    expect(tc1789Ledger.allowance).toEqual(tc1789OptionalAllowance);
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      expect(tc1789OptionalAllowance[format] - masterDriftOptionalAllowance[format])
        .toBe({ ...approvedTc1789Ratchet.firstImport.delta, ...approvedTc1789Ratchet.activation.delta }[format]);
    }
  });

  it("refuses one extra byte, the allowance without master drift's, or the old allowance after it", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      const changed = structuredClone(tc1789Ledger);
      changed.allowance[format]++;
      expect(() => validateOptionalLedger(changed, true, true, true, true, true, true, true, true)).toThrow();
    }
    expect(() => validateOptionalLedger(tc1789Ledger, true, true, true, true, true, true, false, true)).toThrow();
    expect(() => validateOptionalLedger(tc1789Ledger, true, true, true, true, true, true, true)).toThrow();
    expect(() => validateOptionalLedger(masterDriftLedger, true, true, true, true, true, true, true, true)).toThrow();
  });

  it("keeps the cumulative entries within the allowance, with #667's row carrying the observed deltas", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      expect(tc1789Ledger.entries.reduce((sum, entry) => sum + entry[format], 0)).toBeLessThanOrEqual(tc1789Ledger.allowance[format]);
    }
    expect(tc1789Ledger.entries.find((entry) => entry.pr === "#667")).toMatchObject({
      pr: "#667", "replica.mjs": -1, "replica.cjs": 1, "activation.mjs": 0, "activation.cjs": 1,
    });
  });
});

describe("TC-1888 sign-out optional allowance", () => {
  it("pins the cumulative caps to the approved row and includes only its measured deltas", () => {
    expect(() => validateOptionalLedger(shipped, true, true, true, true, true, true, true, true, true)).not.toThrow();
    const deltas = { ...approvedTc1888PurgeLocalCopyRatchet.firstImport.delta, ...approvedTc1888PurgeLocalCopyRatchet.activation.delta };
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      expect(shipped.allowance[format]).toBe(tc1789Ledger.entries.reduce((sum, entry) => sum + entry[format], 0) + deltas[format]);
      expect(shipped.entries.reduce((sum, entry) => sum + entry[format], 0)).toBe(shipped.allowance[format]);
    }
    expect(shipped.entries.at(-1)).toMatchObject({ pr: "#728", ticket: "TC-1888", ...deltas });
  });

  it("refuses extra allowance bytes or the new allowance without the TC-1888 row", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      const changed = structuredClone(shipped);
      changed.allowance[format]++;
      expect(() => validateOptionalLedger(changed, true, true, true, true, true, true, true, true, true)).toThrow();
    }
    expect(() => validateOptionalLedger(shipped, true, true, true, true, true, true, true, true)).toThrow();
  });
});
