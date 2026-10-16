export type GzipSizes = { "index.mjs": number; "index.cjs": number };
export type LedgerEntry = { pr: string; ticket: string; "index.mjs": number; "index.cjs": number; note: string };
export type Phase2Ratchet = {
  label: string;
  base: string;
  toolchain: string;
  baseline: GzipSizes;
  delta: GzipSizes;
  ceiling: GzipSizes;
  rationale: { module: string; controlledMarginalBeforeSafeCuts: GzipSizes; requiredAtLoad: string }[];
  safeCuts: string;
};
export type Ledger = { allowance: GzipSizes; entries: LedgerEntry[]; phase2Ratchet?: Phase2Ratchet };

const formats = ["index.mjs", "index.cjs"] as const;
export const approvedPhase2 = {
  label: "TC-858 Phase 2 (#548 stack): security fences + required sync paths, approved by Naomi 2026-10-16",
  base: "9891ed9dddc19a57198ed156804948e04d8ea025",
  toolchain: "Bun 1.3.14; replica-e2e Node size job Rust 1.99.0; production webpack; gzip -9 -c",
  baseline: { "index.mjs": 1460603, "index.cjs": 1390460 },
  delta: { "index.mjs": 1322, "index.cjs": 1205 },
  ceiling: { "index.mjs": 1461925, "index.cjs": 1391665 },
} as const;
const historicalToolchain = "Bun 1.4.3; production webpack; gzip -9 -c";

/** Only a git merge-base ledger may retain the pre-correction toolchain. */
export function validateLedger(value: Ledger, historicalBase = false): void {
  if (!value || !value.allowance || !Array.isArray(value.entries) ||
      Object.keys(value).some((key) => key !== "allowance" && key !== "entries" && key !== "phase2Ratchet")) {
    throw new Error("Invalid packages/web-sdk/scripts/replica-size-ledger.json shape");
  }
  if (Object.keys(value.allowance).some((key) => !formats.includes(key as typeof formats[number]))) {
    throw new Error("Invalid packages/web-sdk/scripts/replica-size-ledger.json allowance shape");
  }
  for (const format of formats) {
    if (!Number.isFinite(value.allowance[format])) {
      throw new Error(`Invalid packages/web-sdk/scripts/replica-size-ledger.json allowance for ${format}`);
    }
  }
  for (const entry of value.entries) {
    if (!entry || Object.keys(entry).some((key) =>
      key !== "pr" && key !== "ticket" && key !== "note" && !formats.includes(key as typeof formats[number])) ||
        typeof entry.pr !== "string" || typeof entry.ticket !== "string" || typeof entry.note !== "string" ||
        formats.some((format) => !Number.isFinite(entry[format]))) {
      throw new Error("Invalid packages/web-sdk/scripts/replica-size-ledger.json entries[] item");
    }
  }
  const row = value.phase2Ratchet;
  if (row !== undefined) {
    if (value.allowance["index.mjs"] !== 388 || value.allowance["index.cjs"] !== 861 ||
        !row || Object.keys(row).some((key) =>
          !["label", "base", "toolchain", "baseline", "delta", "ceiling", "rationale", "safeCuts"].includes(key)) ||
        row.label !== approvedPhase2.label || row.base !== approvedPhase2.base ||
        (row.toolchain !== approvedPhase2.toolchain && !(historicalBase && row.toolchain === historicalToolchain)) ||
        formats.some((format) => row.baseline?.[format] !== approvedPhase2.baseline[format] ||
          row.delta?.[format] !== approvedPhase2.delta[format] ||
          row.ceiling?.[format] !== approvedPhase2.ceiling[format] ||
          row.baseline[format] + row.delta[format] !== row.ceiling[format]) ||
        !Array.isArray(row.rationale) || row.rationale.length < 3 ||
        row.rationale.some((item) => !item || Object.keys(item).some((key) =>
          !["module", "controlledMarginalBeforeSafeCuts", "requiredAtLoad"].includes(key)) ||
          typeof item.module !== "string" || item.module.length === 0 ||
          typeof item.requiredAtLoad !== "string" || item.requiredAtLoad.length < 40 ||
          formats.some((format) => !Number.isSafeInteger(item.controlledMarginalBeforeSafeCuts?.[format]))) ||
        typeof row.safeCuts !== "string" || row.safeCuts.length < 40) {
      throw new Error("TC-858 Phase 2 root ratchet must match Naomi's exact master9891 approval and document nonadditive file marginals");
    }
  }
}
