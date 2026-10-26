import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { LoadedSizes } from "./measure-replica-optional";
import { ancestryPins, approvedCiToolchainCorrection, approvedFixRequiredRatchet, approvedHardeningRatchet, approvedTc1413Ratchet, approvedTc1432Ratchet, approvedMasterDriftRatchet, approvedTc1475Ratchet, approvedTc1789Ratchet, approvedTc2043SyncScopeRatchet, approvedTc1888PurgeLocalCopyRatchet, approvedTc2096RepairBackoffRatchet, approvedTc2096LazyContentRatchet, pinLandedOn, validateGatedOnlyRatchet, type GatedOnlyRatchet, type Ledger } from "./replica-size-policy";
export type CompactFixRequired = {
  sourceCommit: string;
  integratedCommit: string;
  ruling: string;
  controlledAB: {
    before: Pick<LoadedSizes, "replica.mjs" | "replica.cjs">;
    after: Pick<LoadedSizes, "replica.mjs" | "replica.cjs">;
    delta: Pick<LoadedSizes, "replica.mjs" | "replica.cjs">;
  };
  measuredPaths: Record<string, string>;
  canonicalCI: {
    run: string;
    jobs: string[];
    before: Pick<LoadedSizes, "replica.mjs" | "replica.cjs">;
    after: Pick<LoadedSizes, "replica.mjs" | "replica.cjs">;
    delta: Pick<LoadedSizes, "replica.mjs" | "replica.cjs">;
    source: string;
  };
  status: string;
};

export type OptionalEntry = LoadedSizes & { pr: string; ticket: string; note: string };
export type OptionalLedger = {
  allowance: LoadedSizes;
  entries: OptionalEntry[];
  relocations?: unknown;
  measurementCorrection?: unknown;
  gatedOnlyRatchet?: GatedOnlyRatchet;
  fixRequired?: CompactFixRequired[];
};
export const optionalFormats = ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const;
export const relocationCommit = "2578c6a7624a3408b4584ed2331723694b8afb4b";
export const priorOptionalAllowance: LoadedSizes = {
  "replica.mjs": 45507, "replica.cjs": 65006, "activation.mjs": 23081, "activation.cjs": 24886,
};
export const relocatedOptionalAllowance: LoadedSizes = {
  ...priorOptionalAllowance, "replica.mjs": 45657, "replica.cjs": 65176,
};
/** The CI Bun 1.3.14 output differs from Bun 1.4.3 for the same ce52494d source. */
export const correctedOptionalAllowance: LoadedSizes = {
  ...relocatedOptionalAllowance, "replica.mjs": 51201, "replica.cjs": 66132,
};
export const fixRequiredOptionalAllowance: LoadedSizes = {
  ...correctedOptionalAllowance, ...approvedFixRequiredRatchet.firstImportCeiling,
};
export const ciOptionalAllowance: LoadedSizes = {
  ...approvedCiToolchainCorrection.measured.firstImportCeiling,
  ...approvedCiToolchainCorrection.measured.activationCeiling,
};
/** Only the exact approved compact grant source blob may change; CI bytes are final. */
export const approvedCompactFixRequired: CompactFixRequired = {
  sourceCommit: "a5b1ae1fc61ff352d6ea6940a1791d6cf01f1492",
  integratedCommit: "b796dc52894524ee01a4458f640ecf45906b3040",
  ruling: "Naomi TC-858 compact delegate §3:646, 2026-10-16",
  controlledAB: {
    before: { "replica.mjs": 52355, "replica.cjs": 67328 },
    after: { "replica.mjs": 52362, "replica.cjs": 67332 },
    delta: { "replica.mjs": 7, "replica.cjs": 4 },
  },
  measuredPaths: {
    "packages/node-sdk/src/replication/authority.ts": "0990eecad96ebaa25a615fafe7558ec124b62c7f",
  },
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
export const compactFixOptionalAllowance: LoadedSizes = {
  ...ciOptionalAllowance, "replica.mjs": 51791, "replica.cjs": 67009,
};
/** The #565 hardening ratchet's exact canonical first-import and activation ceilings. */
export const hardeningOptionalAllowance: LoadedSizes = {
  ...approvedHardeningRatchet.firstImport.ceiling, ...approvedHardeningRatchet.activation.ceiling,
};
/** The TC-1413 ratchet's exact canonical first-import and activation ceilings. */
export const tc1413OptionalAllowance: LoadedSizes = {
  ...approvedTc1413Ratchet.firstImport.ceiling, ...approvedTc1413Ratchet.activation.ceiling,
};
/** The TC-1432 ratchet's exact canonical first-import and activation ceilings. */
export const tc1432OptionalAllowance: LoadedSizes = {
  ...approvedTc1432Ratchet.firstImport.ceiling, ...approvedTc1432Ratchet.activation.ceiling,
};
/** The TC-1475 ratchet's exact canonical first-import and activation ceilings. */
export const tc1475OptionalAllowance: LoadedSizes = {
  ...approvedTc1475Ratchet.firstImport.ceiling, ...approvedTc1475Ratchet.activation.ceiling,
};
/** The master-drift ratchet's exact canonical first-import and activation ceilings. */
export const masterDriftOptionalAllowance: LoadedSizes = {
  ...approvedMasterDriftRatchet.firstImport.ceiling, ...approvedMasterDriftRatchet.activation.ceiling,
};
/** The sdk-services 3.3.1 pin ratchet's exact canonical first-import and activation ceilings. */
export const tc1789OptionalAllowance: LoadedSizes = {
  ...approvedTc1789Ratchet.firstImport.ceiling, ...approvedTc1789Ratchet.activation.ceiling,
};
/** The TC-2043 replication syncScope ratchet's cumulative optional ledger caps. */
export const tc2043OptionalAllowance: LoadedSizes = {
  ...approvedTc2043SyncScopeRatchet.firstImport.ceiling, ...approvedTc2043SyncScopeRatchet.activation.ceiling,
};
/** The TC-1888 sign-out local copy ratchet's cumulative optional ledger caps. */
export const tc1888OptionalAllowance: LoadedSizes = {
  ...approvedTc1888PurgeLocalCopyRatchet.firstImport.ceiling, ...approvedTc1888PurgeLocalCopyRatchet.activation.ceiling,
};
/** The TC-2096 capped replica repair backoff ratchet's cumulative optional ledger caps. */
export const tc2096OptionalAllowance: LoadedSizes = {
  ...approvedTc2096RepairBackoffRatchet.firstImport.ceiling, ...approvedTc2096RepairBackoffRatchet.activation.ceiling,
};
/** The TC-2096 lazy content fetch ratchet's cumulative optional ledger caps: the repair-backoff caps plus this row's first-import and activation deltas. */
export const tc2096LazyOptionalAllowance: LoadedSizes = {
  ...approvedTc2096LazyContentRatchet.firstImport.ceiling, ...approvedTc2096LazyContentRatchet.activation.ceiling,
};
export const approvedMeasurementCorrection = {
  commit: "ce52494d0cb1ea236578bc6b709e9e6e016f8c78",
  ciRun: "38958197518",
  ciJob: "117166290134",
  reproduce: "At detached ce52494d, PATH=<Bun-1.3.14-bin>:$PATH bun install --frozen-lockfile && PATH=<Bun-1.3.14-bin>:$PATH bunx turbo build --filter=@tinycloud/web-sdk... --force && PATH=<Bun-1.3.14-bin>:$PATH bun packages/web-sdk/scripts/measure-replica-optional.ts; repeat the measurement with Bun 1.4.3 on the same built dist.",
  previousToolchain: "Bun 1.4.3",
  canonicalToolchain: "Bun 1.3.14",
  previousFirstImport: { "replica.mjs": 45538, "replica.cjs": 65096 },
  canonicalFirstImport: { "replica.mjs": 51201, "replica.cjs": 66132 },
  reason: "CI-pinned Bun.build emits a different minified graph from Bun 1.4.3 for the same 25 modules. This corrects the ce52494d first-import measurement with zero headroom; no new adapter bytes or activation/root allowance.",
};
export const approvedRelocations = [
  { commit: relocationCommit, bucket: "web-core", "index.mjs": -143, "index.cjs": -130 },
  { commit: relocationCommit, bucket: "web-optional:first-import", "replica.mjs": 150, "replica.cjs": 170 },
];

/** Validate the actual ledger before comparing its immutable prefix or built artifacts. */
export function validateOptionalLedger(
  value: OptionalLedger, fixRequired = false, ciToolchainCorrection = false, hardening = false, tc1413 = false, tc1432 = false, tc1475 = false, masterDrift = false, tc1789 = false, tc2043 = false, tc1888 = false, tc2096 = false, tc2096Lazy = false,
): void {
  const path = "packages/web-sdk/scripts/replica-optional-size-ledger.json";
  if (!value || !value.allowance || !Array.isArray(value.entries) ||
      Object.keys(value).some((key) => key !== "allowance" && key !== "entries" && key !== "relocations" && key !== "measurementCorrection" && key !== "gatedOnlyRatchet" && key !== "fixRequired") ||
      Object.keys(value.allowance).some((key) => !optionalFormats.includes(key as typeof optionalFormats[number])) ||
      optionalFormats.some((format) => !Number.isSafeInteger(value.allowance[format]) || value.allowance[format] < 0)) {
    throw new Error(`Invalid ${path} shape or allowance`);
  }
  for (const entry of value.entries) {
    if (!entry || Object.keys(entry).some((key) =>
      key !== "pr" && key !== "ticket" && key !== "note" && !optionalFormats.includes(key as typeof optionalFormats[number])) ||
        typeof entry.pr !== "string" || typeof entry.ticket !== "string" || typeof entry.note !== "string" ||
        optionalFormats.some((format) => !Number.isSafeInteger(entry[format]))) {
      throw new Error(`Invalid ${path} entries[] item`);
    }
  }
  const relocated = value.relocations !== undefined;
  const corrected = value.measurementCorrection !== undefined;
  const hasCompactFix = value.fixRequired !== undefined;
  const ceiling = tc2096Lazy ? tc2096LazyOptionalAllowance : tc2096 ? tc2096OptionalAllowance : tc1888 ? tc1888OptionalAllowance : tc2043 ? tc2043OptionalAllowance : tc1789 ? tc1789OptionalAllowance : masterDrift ? masterDriftOptionalAllowance : tc1475 ? tc1475OptionalAllowance : tc1432 ? tc1432OptionalAllowance : tc1413 ? tc1413OptionalAllowance : hardening ? hardeningOptionalAllowance : hasCompactFix ? compactFixOptionalAllowance
    : ciToolchainCorrection ? ciOptionalAllowance : fixRequired ? fixRequiredOptionalAllowance
      : corrected ? correctedOptionalAllowance : relocated ? relocatedOptionalAllowance : priorOptionalAllowance;
  if (optionalFormats.some((format) => value.allowance[format] !== ceiling[format]) ||
      (relocated && JSON.stringify(value.relocations) !== JSON.stringify(approvedRelocations)) ||
      (corrected && (!relocated || JSON.stringify(value.measurementCorrection) !== JSON.stringify(approvedMeasurementCorrection))) ||
      (fixRequired && !corrected) || (ciToolchainCorrection && !fixRequired) || (hardening && !hasCompactFix) || (tc1413 && !hardening) || (tc1432 && !tc1413) || (tc1475 && !tc1432) || (masterDrift && !tc1475) || (tc1789 && !masterDrift) || (tc2043 && !tc1789) || (tc1888 && !tc2043) ||
      (tc2096 && !tc1888) ||
      (tc2096Lazy && !tc2096) ||
      (hasCompactFix && (!ciToolchainCorrection ||
        JSON.stringify(value.fixRequired) !== JSON.stringify([approvedCompactFixRequired])))) {
    throw new Error(`${path}: only the exact paired relocation, canonical toolchain correction and reviewed fix-required first-import caps are approved`);
  }
  validateGatedOnlyRatchet(value.gatedOnlyRatchet);
}

/**
 * The source commit each source-backed optional row present in `ledger` pins, in check order. A
 * PR that introduces the row must contain the literal commit; once merged, the row resolves through
 * its squash commit instead (see landingCommit in replica-size-policy.ts).
 */
export function optionalSourcePins(ledger: OptionalLedger): Array<{ row: "relocations" | "measurementCorrection" | "fixRequired"; pin: string }> {
  const pins: Array<{ row: "relocations" | "measurementCorrection" | "fixRequired"; pin: string }> = [];
  if (ledger.relocations !== undefined) pins.push({ row: "relocations", pin: relocationCommit });
  if (ledger.measurementCorrection !== undefined) pins.push({ row: "measurementCorrection", pin: approvedMeasurementCorrection.commit });
  if (ledger.fixRequired !== undefined) pins.push({ row: "fixRequired", pin: approvedCompactFixRequired.integratedCommit });
  return pins;
}

/**
 * The pins of rows already merged into a base (root, gated-only and optional) for which `ref`
 * fails pinLandedOn. check-phase1-replica-dist.ts refuses a PR whose base yields any.
 */
export function mergedPinsNotLandedOn(
  root: string, base: Ledger, baseOptional: OptionalLedger, ref: string,
): Array<{ row: string; pin: string }> {
  return [...ancestryPins(base, baseOptional.gatedOnlyRatchet !== undefined), ...optionalSourcePins(baseOptional)]
    .filter(({ pin }) => !pinLandedOn(root, pin, ref));
}

/**
 * A pull request that introduces a source-backed row must contain that row's source commit. Squash
 * merges leave branch commits out of master, so rows already in the merge base are not re-checked;
 * validateOptionalLedger keeps them pinned to the exact approved values.
 */
export function validateIntroducedOptionalSources(base: OptionalLedger, current: OptionalLedger): void {
  const path = "packages/web-sdk/scripts/replica-optional-size-ledger.json";
  const errors = {
    relocations: "approved relocation commit is not an ancestor of HEAD",
    measurementCorrection: "ce52494d measurement correction requires its approved source ancestor",
    fixRequired: "compact fix requires the integrated source commit",
  };
  const merged = new Set(optionalSourcePins(base).map(({ row }) => row));
  for (const { row, pin } of optionalSourcePins(current)) {
    if (merged.has(row)) continue;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", pin, "HEAD"], {
        cwd: resolve(import.meta.dir, "../../.."), stdio: "ignore",
      });
    } catch {
      throw new Error(`${path}: ${errors[row]}`);
    }
  }
}

/** Only rows already in the PR merge base are immutable; the PR's own last row is measured. */
export function validateOptionalEntryTransition(
  base: readonly OptionalEntry[],
  current: readonly OptionalEntry[],
  observed: LoadedSizes,
  expectedPr: string,
): void {
  const prefixMatches = current.length === base.length + 1 && base.every((entry, index) => {
    const candidate = current[index];
    return candidate.pr === entry.pr && candidate.ticket === entry.ticket &&
      candidate.note === entry.note && optionalFormats.every((format) => candidate[format] === entry[format]);
  });
  if (!/^#\d+$/.test(expectedPr) || base.some((entry) => entry.pr === expectedPr) ||
      !prefixMatches || current[base.length].pr !== expectedPr ||
      optionalFormats.some((format) => current[base.length][format] !== observed[format])) {
    throw new Error("Merged optional rows must remain unchanged and must not repeat this PR; its one new row must have the requested PR number and exact observed gzip deltas.");
  }
}
