import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compactFixOptionalAllowance, correctedOptionalAllowance, hardeningOptionalAllowance, tc1413OptionalAllowance, tc1432OptionalAllowance, tc1475OptionalAllowance, masterDriftOptionalAllowance, tc1789OptionalAllowance, tc2043OptionalAllowance, tc1888OptionalAllowance, validateIntroducedOptionalSources,
  tc2096OptionalAllowance, tc2096LazyOptionalAllowance, tc2481OfflineOptionalAllowance,
  validateOptionalEntryTransition, validateOptionalLedger, type OptionalLedger,
} from "./replica-optional-size-policy";
import { approvedMasterDriftRatchet, approvedTc1432Ratchet, approvedTc1475Ratchet, approvedTc1789Ratchet, approvedTc2043SyncScopeRatchet, approvedTc1888PurgeLocalCopyRatchet, approvedTc2096RepairBackoffRatchet, approvedTc2096LazyContentRatchet } from "./replica-size-policy";
import { evaluateOptionalBudget, validateTc2481WebOptionalTransition } from "./replica-optional-size-policy";
import type { Ledger } from "./replica-size-policy";

const finalShipped = JSON.parse(readFileSync(resolve(import.meta.dir, "replica-optional-size-ledger.json"), "utf8")) as OptionalLedger;
delete finalShipped.tc2931;
finalShipped.entries = finalShipped.entries.filter((entry) => entry.pr !== "#945");
finalShipped.allowance = { ...tc2481OfflineOptionalAllowance };
// Keep earlier admissions in their original context; final3e0 controls use the live ledger below.
const shipped = structuredClone(finalShipped);
shipped.entries = shipped.entries.slice(0, shipped.entries.findIndex((entry) => entry.pr === "#873"));
shipped.allowance["replica.cjs"] = 68370;
// Historical cases retain the last pre-Web-routing allowance and metadata.
// The #872-era controls below use `shipped`; final3e0 controls use `finalShipped`.
const beforeWebRouting: OptionalLedger = {
  ...structuredClone(shipped),
  allowance: { ...tc2096LazyOptionalAllowance },
};
beforeWebRouting.entries = beforeWebRouting.entries.filter((entry) => entry.pr !== "#872");
delete beforeWebRouting.tc2481WebRouting;
// The tests below cover the #565 hardening-era ledger; TC-1413's own allowance is tested at the end.
const current: OptionalLedger = { ...structuredClone(beforeWebRouting), allowance: { ...hardeningOptionalAllowance } };
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
  ...structuredClone(beforeWebRouting),
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
  ...structuredClone(beforeWebRouting),
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
  ...structuredClone(beforeWebRouting),
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
  ...structuredClone(beforeWebRouting),
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
  ...structuredClone(beforeWebRouting),
  allowance: { ...tc1789OptionalAllowance },
  entries: structuredClone(shipped.entries.slice(0, shipped.entries.findIndex((entry) => entry.pr === "#742"))),
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

const tc2043Ledger: OptionalLedger = {
  ...structuredClone(beforeWebRouting),
  allowance: { ...tc2043OptionalAllowance },
  entries: structuredClone(shipped.entries.slice(0, shipped.entries.findIndex((entry) => entry.pr === "#728"))),
};

describe("TC-2043 replication syncScope optional allowance", () => {
  it("pins the approved caps and the measured #742 entry", () => {
    expect(() => validateOptionalLedger(tc2043Ledger, true, true, true, true, true, true, true, true, true)).not.toThrow();
    const deltas = { ...approvedTc2043SyncScopeRatchet.firstImport.delta, ...approvedTc2043SyncScopeRatchet.activation.delta };
    expect(tc2043Ledger.allowance).toEqual({ "replica.mjs": 51965, "replica.cjs": 67178, "activation.mjs": 23117, "activation.cjs": 24700 });
    expect(tc2043Ledger.allowance).toEqual(tc2043OptionalAllowance);
    for (const format of ["replica.mjs", "replica.cjs"] as const) {
      expect(tc2043Ledger.allowance[format]).toBe(tc1789Ledger.entries.reduce((sum, entry) => sum + entry[format], 0) + deltas[format]);
      expect(tc2043Ledger.entries.reduce((sum, entry) => sum + entry[format], 0)).toBe(tc2043Ledger.allowance[format]);
    }
    for (const format of ["activation.mjs", "activation.cjs"] as const) {
      expect(tc2043Ledger.allowance[format]).toBe(tc1789OptionalAllowance[format]);
      expect(tc2043Ledger.entries.reduce((sum, entry) => sum + entry[format], 0)).toBeLessThanOrEqual(tc2043Ledger.allowance[format]);
    }
    expect(tc2043Ledger.entries.at(-1)).toMatchObject({ pr: "#742", ticket: "TC-2043", ...deltas });
  });

  it("refuses extra allowance bytes or the new allowance without its ratchet", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      const changed = structuredClone(tc2043Ledger);
      changed.allowance[format]++;
      expect(() => validateOptionalLedger(changed, true, true, true, true, true, true, true, true, true)).toThrow();
    }
    expect(() => validateOptionalLedger(tc2043Ledger, true, true, true, true, true, true, true, true)).toThrow();
  });
});


const tc1888Ledger: OptionalLedger = {
  ...structuredClone(beforeWebRouting),
  allowance: { ...tc1888OptionalAllowance },
  entries: structuredClone(shipped.entries.slice(0, shipped.entries.findIndex((entry) => entry.pr === "#759"))),
};

describe("TC-1888 sign-out local copy optional allowance", () => {
  it("pins the approved caps and measured #728 entry", () => {
    expect(() => validateOptionalLedger(tc1888Ledger, true, true, true, true, true, true, true, true, true, true)).not.toThrow();
    const deltas = { ...approvedTc1888PurgeLocalCopyRatchet.firstImport.delta, ...approvedTc1888PurgeLocalCopyRatchet.activation.delta };
    expect(tc1888Ledger.allowance).toEqual(tc1888OptionalAllowance);
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      expect(tc1888Ledger.allowance[format]).toBe(tc2043Ledger.entries.reduce((sum, entry) => sum + entry[format], 0) + deltas[format]);
      expect(tc1888Ledger.entries.reduce((sum, entry) => sum + entry[format], 0)).toBe(tc1888Ledger.allowance[format]);
    }
    expect(tc1888Ledger.entries.at(-1)).toMatchObject({ pr: "#728", ticket: "TC-1888", ...deltas });
  });

  it("refuses extra allowance bytes or the new allowance without its ratchet", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      const changed = structuredClone(tc1888Ledger);
      changed.allowance[format]++;
      expect(() => validateOptionalLedger(changed, true, true, true, true, true, true, true, true, true, true)).toThrow();
    }
    expect(() => validateOptionalLedger(tc1888Ledger, true, true, true, true, true, true, true, true, true)).toThrow();
  });
});

const tc2096Ledger: OptionalLedger = {
  ...structuredClone(beforeWebRouting),
  allowance: { ...tc2096OptionalAllowance },
  entries: structuredClone(shipped.entries.slice(0, shipped.entries.findIndex((entry) => entry.pr === "#761"))),
};

describe("TC-2096 repair backoff optional allowance", () => {
  it("pins the approved caps and measured #759 entry", () => {
    expect(() => validateOptionalLedger(tc2096Ledger, true, true, true, true, true, true, true, true, true, true, true)).not.toThrow();
    const deltas = { ...approvedTc2096RepairBackoffRatchet.firstImport.delta, ...approvedTc2096RepairBackoffRatchet.activation.delta };
    expect(tc2096Ledger.allowance).toEqual(tc2096OptionalAllowance);
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      expect(tc2096Ledger.entries.reduce((sum, entry) => sum + entry[format], 0)).toBe(tc1888OptionalAllowance[format] + deltas[format]);
    }
    expect(tc2096Ledger.entries.find((entry) => entry.pr === "#759")).toMatchObject({ pr: "#759", ticket: "TC-2096", ...deltas });
  });

  it("refuses the new allowance without its ratchet", () => {
    expect(() => validateOptionalLedger(tc2096Ledger, true, true, true, true, true, true, true, true, true, true)).toThrow();
  });
});

describe("TC-2096 lazy content fetch optional allowance", () => {
  it("pins the approved caps and measured #761 entry", () => {
    expect(() => validateOptionalLedger(beforeWebRouting, true, true, true, true, true, true, true, true, true, true, true, true)).not.toThrow();
    const deltas = { ...approvedTc2096LazyContentRatchet.firstImport.delta, ...approvedTc2096LazyContentRatchet.activation.delta };
    expect(beforeWebRouting.allowance).toEqual(tc2096LazyOptionalAllowance);
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      expect(beforeWebRouting.entries.reduce((sum, entry) => sum + entry[format], 0)).toBe(tc2096Ledger.entries.reduce((sum, entry) => sum + entry[format], 0) + deltas[format]);
    }
    expect(beforeWebRouting.entries.find((entry) => entry.pr === "#761")).toMatchObject({ pr: "#761", ticket: "TC-2096", ...deltas });
  });

  it("refuses the lazy allowance without its ratchet", () => {
    expect(() => validateOptionalLedger(beforeWebRouting, true, true, true, true, true, true, true, true, true, true, true)).toThrow();
  });
});

describe("TC-2481 Web routing exact optional admission", () => {
  const root = JSON.parse(readFileSync(resolve(import.meta.dir, "replica-size-ledger.json"), "utf8")) as Ledger;
    delete root.tc2931BootstrapScope;
    delete root.tc2923EncryptionTeeOriginRoot;
    delete root.tc2949PanelChunkRecoveryRoot;
    delete root.tc2970RegistryVerdictCacheRoot;
    delete root.tc2913OpenKeyContinuationRoot;
  delete root.tc2481OfflineReplicaTransport;
  root.entries = root.entries.filter((entry) => entry.pr !== "#873");
  root.allowance["index.mjs"] = 388;
  const measured = shipped.tc2481WebRouting!.canonicalCI;
  const validate = (value: OptionalLedger, rootPresent = true, lazyPresent = true) =>
    validateOptionalLedger(value, true, true, true, true, true, true, true, true, true, true, true, lazyPresent, rootPresent);

  it("admits the final first-import caps while keeping the historical activation caps", () => {
    expect(shipped.tc2481WebRouting).toBeDefined();
    expect(() => validate(shipped)).not.toThrow();
    for (const format of ["replica.mjs", "replica.cjs"] as const) {
      expect(shipped.allowance[format]).toBe(shipped.tc2481WebRouting!.firstImport.ceiling[format]);
    }
    for (const format of ["activation.mjs", "activation.cjs"] as const) {
      expect(shipped.allowance[format]).toBe(beforeWebRouting.allowance[format]);
    }
  });

  it("refuses one extra allowance byte in every format without enlarging activation", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      const changed = structuredClone(shipped);
      changed.allowance[format]++;
      expect(() => validate(changed)).toThrow();
    }
  });

  it("requires both the root admission and matching optional evidence after the prior ratchet", () => {
    expect(() => validate(shipped, false)).toThrow();
    expect(() => validate(shipped, true, false)).toThrow();
    const missing = structuredClone(shipped);
    delete missing.tc2481WebRouting;
    expect(() => validate(missing)).toThrow();
    const oldAllowance = structuredClone(shipped);
    oldAllowance.allowance = { ...beforeWebRouting.allowance };
    expect(() => validate(oldAllowance)).toThrow();
  });

  it("refuses changed measured provenance and missing investigation or payback evidence", () => {
    const source = structuredClone(shipped);
    source.tc2481WebRouting!.sourceCommits[0] = "0".repeat(40);
    expect(() => validate(source)).toThrow();
    const ci = structuredClone(shipped);
    ci.tc2481WebRouting!.canonicalCI.jobs.pop();
    expect(() => validate(ci)).toThrow();
    for (const evidence of [
      "https://github.com/TinyCloudLabs/js-sdk/pull/872#issuecomment-6714590555",
      "https://github.com/TinyCloudLabs/js-sdk/pull/872#issuecomment-6714590790",
      "https://linear.app/tinycloud-labs/issue/TC-2523/recover-tc-2481-web-routing-bundle-growth-without-relaxing-security",
    ]) {
      const changed = structuredClone(shipped);
      changed.tc2481WebRouting!.reason = changed.tc2481WebRouting!.reason.replace(evidence, "");
      expect(() => validate(changed)).toThrow();
    }
  });

  it("cannot rewrite or remove an optional admission already present in the base", () => {
    const row = structuredClone(shipped.tc2481WebRouting!);
    expect(() => validateTc2481WebOptionalTransition(undefined, row)).not.toThrow();
    expect(() => validateTc2481WebOptionalTransition(row, structuredClone(row))).not.toThrow();
    const changed = structuredClone(row);
    changed.firstImport.ceiling["replica.cjs"]++;
    expect(() => validateTc2481WebOptionalTransition(undefined, changed)).toThrow();
    expect(() => validateTc2481WebOptionalTransition(row, changed)).toThrow();
    expect(() => validateTc2481WebOptionalTransition(row, undefined)).toThrow();
  });

  it("keeps raw measured CJS charges visible and applies the reviewed four-byte baseline retirement once", () => {
    expect(() => validateOptionalEntryTransition(beforeWebRouting.entries, shipped.entries, measured.delta, "#872")).not.toThrow();
    const readings = evaluateOptionalBudget(shipped, root, measured.after);
    expect(readings.find((reading) => reading.format === "replica.cjs")).toEqual({
      format: "replica.cjs", raw: 68374, effective: 68370, direct: 68370, ceiling: 68370, exceeded: false,
    });
    for (const reading of readings) {
      expect(reading.exceeded).toBe(false);
      if (reading.format !== "replica.cjs") expect(reading.effective).toBe(reading.raw);
    }
  });

  it("refuses altered alignment, source, CI or measured deltas before granting any accounting correction", () => {
    const mutations: Array<(value: OptionalLedger) => void> = [
      (value) => { value.tc2481WebRouting!.baselineAlignment.alignment = -3; },
      (value) => { value.tc2481WebRouting!.baselineAlignment.alignment = -5; },
      (value) => { value.tc2481WebRouting!.baselineAlignment.controlledBase++; },
      (value) => { Object.assign(value.tc2481WebRouting!.baselineAlignment, { format: "activation.cjs" }); },
      (value) => { value.tc2481WebRouting!.sourceCommits[0] = "0".repeat(40); },
      (value) => { value.tc2481WebRouting!.canonicalCI.jobs.pop(); },
      (value) => { value.tc2481WebRouting!.canonicalCI.delta["replica.cjs"] = 413; },
      (value) => { value.allowance["replica.cjs"] = 68374; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(shipped);
      mutate(changed);
      expect(() => evaluateOptionalBudget(changed, root, measured.after)).toThrow();
    }
  });

  it("requires matching root metadata and both real accounting entries, not merely an alignment number", () => {
    const missingOptionalRow = structuredClone(shipped);
    delete missingOptionalRow.tc2481WebRouting;
    expect(() => evaluateOptionalBudget(missingOptionalRow, root, measured.after)).toThrow();
    for (const mutate of [
      (value: Ledger) => { delete value.tc2481WebRouting; },
      (value: Ledger) => { delete value.tc2481RegistryFreshness; },
      (value: Ledger) => { value.tc2481WebRouting!.canonicalCI.jobs.pop(); },
      (value: Ledger) => { value.entries = value.entries.filter((entry) => entry.pr !== "#872"); },
      (value: Ledger) => { value.entries.find((entry) => entry.pr === "#872")!["index.mjs"] = 1; },
    ]) {
      const changed = structuredClone(root);
      mutate(changed);
      expect(() => evaluateOptionalBudget(shipped, changed, measured.after)).toThrow();
    }
    for (const mutate of [
      (value: OptionalLedger) => { value.entries = value.entries.filter((entry) => entry.pr !== "#872"); },
      (value: OptionalLedger) => { value.entries.push(structuredClone(value.entries.at(-1)!)); },
      (value: OptionalLedger) => { value.entries.at(-1)!.ticket = "TC-UNKNOWN"; },
      (value: OptionalLedger) => { value.entries.at(-1)!["replica.cjs"] = 413; },
      (value: OptionalLedger) => { value.entries.at(-1)!.note = ""; },
    ]) {
      const changed = structuredClone(shipped);
      mutate(changed);
      expect(() => evaluateOptionalBudget(changed, root, measured.after)).toThrow();
    }
  });

  it("retains immutable historical prefixes even when a mutation leaves the cumulative sum unchanged", () => {
    const changed = structuredClone(shipped);
    changed.entries[0].note += " edited";
    expect(() => validateOptionalEntryTransition(beforeWebRouting.entries, changed.entries, measured.delta, "#872")).toThrow();
    const wrongBaseline = structuredClone(shipped);
    wrongBaseline.entries[0]["replica.cjs"]++;
    expect(() => evaluateOptionalBudget(wrongBaseline, root, measured.after)).toThrow();
  });

  it("refuses effective growth independently of direct bytes or savings in another bucket", () => {
    const changed = structuredClone(shipped);
    changed.entries.push({
      pr: "#873", ticket: "TC-OTHER", "replica.mjs": 1, "replica.cjs": 1,
      "activation.mjs": -1000, "activation.cjs": -1000, note: "Independent future accounting transition",
    });
    const readings = evaluateOptionalBudget(changed, root, measured.after);
    expect(readings.filter((reading) => reading.exceeded).map((reading) => reading.format)).toEqual(["replica.mjs", "replica.cjs"]);
    const cjs = readings.find((reading) => reading.format === "replica.cjs")!;
    expect(cjs.effective).toBe(68371);
    expect(cjs.direct).toBe(68370);
  });

  it("refuses direct asset growth in every bucket even when effective accounting remains within its ceiling", () => {
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      const readings = evaluateOptionalBudget(shipped, root, { ...measured.after, [format]: shipped.allowance[format] + 1 });
      const reading = readings.find((candidate) => candidate.format === format)!;
      expect(reading.effective).toBeLessThanOrEqual(reading.ceiling);
      expect(reading.exceeded).toBe(true);
    }
  });

  it("does not apply the new correction to historical ledgers without the new admission", () => {
    const historicalRoot = structuredClone(root);
    delete historicalRoot.tc2481WebRouting;
    historicalRoot.entries = historicalRoot.entries.filter((entry) => entry.pr !== "#872");
    const cjs = evaluateOptionalBudget(beforeWebRouting, historicalRoot, beforeWebRouting.allowance)
      .find((reading) => reading.format === "replica.cjs")!;
    expect(cjs).toEqual({ format: "replica.cjs", raw: 67957, effective: 67957, direct: 67957, ceiling: 67957, exceeded: false });
  });
});

describe("TC-2481 final3e0 optional accounting admission", () => {
  const observed = { "replica.mjs": 53129, "replica.cjs": 68401, "activation.mjs": 19143, "activation.cjs": 20115 };
  const fixture = () => {
    const root = JSON.parse(readFileSync(resolve(import.meta.dir, "replica-size-ledger.json"), "utf8")) as Ledger;
    delete root.tc2931BootstrapScope;
    delete root.tc2923EncryptionTeeOriginRoot;
    delete root.tc2949PanelChunkRecoveryRoot;
    delete root.tc2970RegistryVerdictCacheRoot;
    delete root.tc2913OpenKeyContinuationRoot;
    root.allowance = { "index.mjs": 391, "index.cjs": 861 };
    root.entries = root.entries.slice(0, root.entries.findIndex((entry) => entry.pr === "#873"));
    root.entries.push({
      pr: "#873", ticket: "TC-2481", "index.mjs": 99, "index.cjs": 104,
      note: "Naomi, TC-2523, 2026-11-08: #873 registry_unavailable refusal plus offline mapping, +99/+104 root (base e21 → 3e0d9322)",
    });
    const optional = structuredClone(finalShipped);
    optional.allowance["replica.cjs"] = 68401;
    optional.entries = optional.entries.slice(0, optional.entries.findIndex((entry) => entry.pr === "#873"));
    optional.entries.push({
      pr: "#873", ticket: "TC-2481", "replica.mjs": -2, "replica.cjs": 31,
      "activation.mjs": 0, "activation.cjs": 1, note: "Actual3e0 controlled merge-base deltas; Naomi, TC-2523, 2026-11-08.",
    });
    return { root, optional };
  };
  const validate = (value: OptionalLedger, root: Ledger) => validateOptionalLedger(
    value, true, true, true, true, true, true, true, true, true, true, true, true, true,
    root.tc2481OfflineReplicaTransport,
  );

  it("admits the true optional charges without adding or repeating the historical four-byte retirement", () => {
    const { root, optional } = fixture();
    expect(() => validate(optional, root)).not.toThrow();
    const readings = evaluateOptionalBudget(optional, root, observed);
    expect(readings.find((reading) => reading.format === "replica.cjs")).toEqual({
      format: "replica.cjs", raw: 68405, effective: 68401, direct: 68401, ceiling: 68401, exceeded: false,
    });
    for (const reading of readings) {
      expect(reading.exceeded).toBe(false);
      if (reading.format !== "replica.cjs") expect(reading.effective).toBe(reading.raw);
    }
  });

  it("still refuses one direct byte above every bucket after the new CJS admission", () => {
    const { root, optional } = fixture();
    expect(() => validate(optional, root)).not.toThrow();
    for (const format of ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const) {
      const reading = evaluateOptionalBudget(optional, root, { ...observed, [format]: optional.allowance[format] + 1 })
        .find((candidate) => candidate.format === format)!;
      expect(reading.effective).toBeLessThanOrEqual(reading.ceiling);
      expect(reading.exceeded).toBe(true);
    }
  });

  it("does not offset extra initial CJS charges with activation savings", () => {
    const { root, optional } = fixture();
    expect(() => validate(optional, root)).not.toThrow();
    optional.entries.push({
      pr: "#874", ticket: "TC-OTHER", "replica.mjs": 0, "replica.cjs": 1,
      "activation.mjs": -1000, "activation.cjs": -1000, note: "Independent later accounting.",
    });
    const reading = evaluateOptionalBudget(optional, root, observed).find((value) => value.format === "replica.cjs")!;
    expect(reading).toMatchObject({ effective: 68402, direct: 68401, ceiling: 68401, exceeded: true });
  });

  it("requires the matching final root record, true accounting and unchanged baseline evidence", () => {
    const { root, optional } = fixture();
    expect(() => validate(optional, root)).not.toThrow();
    for (const mutate of [
      (value: Ledger) => { delete value.tc2481OfflineReplicaTransport; },
      (value: Ledger) => { value.tc2481OfflineReplicaTransport!.sourceCommits[0] = "0".repeat(40); },
      (value: Ledger) => { value.entries.find((entry) => entry.pr === "#873")!["index.mjs"] = 0; },
    ]) {
      const changed = structuredClone(root);
      mutate(changed);
      expect(() => evaluateOptionalBudget(optional, changed, observed)).toThrow();
    }
    for (const mutate of [
      (value: OptionalLedger) => { value.entries = value.entries.filter((entry) => entry.pr !== "#873"); },
      (value: OptionalLedger) => { value.entries.find((entry) => entry.pr === "#873")!["replica.cjs"] = 30; },
      (value: OptionalLedger) => { value.tc2481WebRouting!.baselineAlignment.alignment = -5; },
    ]) {
      const changed = structuredClone(optional);
      mutate(changed);
      expect(() => evaluateOptionalBudget(changed, root, observed)).toThrow();
    }
  });

  it("accepts the newest shipped optional row through the same entry-transition validation the check applies", () => {
    const newest = finalShipped.entries.at(-1)!;
    const delta = {
      "replica.mjs": newest["replica.mjs"], "replica.cjs": newest["replica.cjs"],
      "activation.mjs": newest["activation.mjs"], "activation.cjs": newest["activation.cjs"],
    };
    expect(() => validateOptionalEntryTransition(finalShipped.entries.slice(0, -1), finalShipped.entries, delta, newest.pr)).not.toThrow();
    expect(() => validateOptionalEntryTransition(finalShipped.entries.slice(0, -1), finalShipped.entries, { ...delta, "replica.cjs": delta["replica.cjs"] + 1 }, newest.pr)).toThrow();
    expect(() => validateOptionalEntryTransition(finalShipped.entries.slice(0, -1), finalShipped.entries, delta, "#0")).toThrow();
  });
});
