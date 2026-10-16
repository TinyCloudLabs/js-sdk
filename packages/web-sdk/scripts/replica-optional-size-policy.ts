import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { LoadedSizes } from "./measure-replica-optional";
import { approvedFixRequiredRatchet, validateGatedOnlyRatchet, type GatedOnlyRatchet } from "./replica-size-policy";

export type OptionalEntry = LoadedSizes & { pr: string; ticket: string; note: string };
export type OptionalLedger = {
  allowance: LoadedSizes;
  entries: OptionalEntry[];
  relocations?: unknown;
  measurementCorrection?: unknown;
  gatedOnlyRatchet?: GatedOnlyRatchet;
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
export function validateOptionalLedger(value: OptionalLedger, fixRequired = false): void {
  const path = "packages/web-sdk/scripts/replica-optional-size-ledger.json";
  if (!value || !value.allowance || !Array.isArray(value.entries) ||
      Object.keys(value).some((key) => key !== "allowance" && key !== "entries" && key !== "relocations" && key !== "measurementCorrection" && key !== "gatedOnlyRatchet") ||
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
  const ceiling = fixRequired ? fixRequiredOptionalAllowance
    : corrected ? correctedOptionalAllowance : relocated ? relocatedOptionalAllowance : priorOptionalAllowance;
  if (optionalFormats.some((format) => value.allowance[format] !== ceiling[format]) ||
      (relocated && JSON.stringify(value.relocations) !== JSON.stringify(approvedRelocations)) ||
      (corrected && (!relocated || JSON.stringify(value.measurementCorrection) !== JSON.stringify(approvedMeasurementCorrection))) ||
      (fixRequired && !corrected)) {
    throw new Error(`${path}: only the exact paired relocation, canonical toolchain correction and reviewed ddc032ca first-import cap are approved`);
  }
  validateGatedOnlyRatchet(value.gatedOnlyRatchet);
  const repoRoot = resolve(import.meta.dir, "../../..");
  if (corrected) {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", approvedMeasurementCorrection.commit, "HEAD"], {
        cwd: repoRoot, stdio: "ignore",
      });
    } catch {
      throw new Error(`${path}: ce52494d measurement correction requires its approved source ancestor`);
    }
  }
  if (relocated) {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", relocationCommit, "HEAD"], {
        cwd: repoRoot, stdio: "ignore",
      });
    } catch {
      throw new Error(`${path}: approved relocation commit is not an ancestor of HEAD`);
    }
  }
}

/** Only rows already in the PR merge base are immutable; the PR's own last row is measured. */
export function validateOptionalEntryTransition(
  base: readonly OptionalEntry[],
  current: readonly OptionalEntry[],
  observed: LoadedSizes,
): void {
  const prefixMatches = current.length === base.length + 1 && base.every((entry, index) => {
    const candidate = current[index];
    return candidate.pr === entry.pr && candidate.ticket === entry.ticket &&
      candidate.note === entry.note && optionalFormats.every((format) => candidate[format] === entry[format]);
  });
  if (!prefixMatches || optionalFormats.some((format) => current[base.length][format] !== observed[format])) {
    throw new Error("Merged optional ledger rows must stay unchanged; the unmerged PR's own row must equal observed first-import and activation gzip deltas.");
  }
}
