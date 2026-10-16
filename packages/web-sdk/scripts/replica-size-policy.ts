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
export type FirstImportSizes = { "replica.mjs": number; "replica.cjs": number };
export type FixRequiredRatchet = {
  label: string;
  measuredAt: string;
  toolchain: string;
  priorRoot: GzipSizes;
  rootCeiling: GzipSizes;
  priorFirstImport: FirstImportSizes;
  firstImportCeiling: FirstImportSizes;
  groupedMarginals: {
    from: string;
    to: string;
    root: GzipSizes;
    firstImport: FirstImportSizes;
    reason: string;
  }[];
  s4Marginal: string;
};
export type Ledger = { allowance: GzipSizes; entries: LedgerEntry[]; phase2Ratchet?: Phase2Ratchet; fixRequiredRatchet?: FixRequiredRatchet };

const formats = ["index.mjs", "index.cjs"] as const;
export const approvedPhase2 = {
  label: "TC-858 Phase 2 (#548 stack): security fences + required sync paths, approved by Naomi 2026-10-16",
  base: "9891ed9dddc19a57198ed156804948e04d8ea025",
  toolchain: "Bun 1.3.14; replica-e2e Node size job Rust 1.99.0; production webpack; gzip -9 -c",
  baseline: { "index.mjs": 1460603, "index.cjs": 1390460 },
  delta: { "index.mjs": 1322, "index.cjs": 1205 },
  ceiling: { "index.mjs": 1461925, "index.cjs": 1391665 },
} as const;

export const approvedFixRequiredRatchet: FixRequiredRatchet = {
  label: "TC-858 Phase 2 reviewed correctness fixes: copied-proof restore, gated observation, durable denial event, GRANT_REVOKED",
  measuredAt: "ddc032caef81a2177e7f9c30a6a28a8f593a4580",
  toolchain: approvedPhase2.toolchain,
  priorRoot: { "index.mjs": 1461925, "index.cjs": 1391665 },
  rootCeiling: { "index.mjs": 1462034, "index.cjs": 1391799 },
  priorFirstImport: { "replica.mjs": 51201, "replica.cjs": 66132 },
  firstImportCeiling: { "replica.mjs": 51785, "replica.cjs": 66995 },
  groupedMarginals: [
    {
      from: "ce52494d0cb1ea236578bc6b709e9e6e016f8c78",
      to: "18e9f58983727c63c8ad1bab0378e6c3248bbfa3",
      root: { "index.mjs": 180, "index.cjs": 157 },
      firstImport: { "replica.mjs": 1155, "replica.cjs": 1197 },
      reason: "Copied-proof restore refusal, scoped gated network-read events, S3 durable-denial event; TC-1208 synchronous sign-out and session-attempt fences preserved.",
    },
    {
      from: "18e9f58983727c63c8ad1bab0378e6c3248bbfa3",
      to: "ddc032caef81a2177e7f9c30a6a28a8f593a4580",
      root: { "index.mjs": -71, "index.cjs": -23 },
      firstImport: { "replica.mjs": -571, "replica.cjs": -334 },
      reason: "Refused-admission observer physically deferred, existing runtime unbind reused, S3 sign-out event kept in loaded authority; no security or network semantics removed.",
    },
  ],
  s4Marginal: "S4 GRANT_REVOKED network-read projection from 28addd98 integrated as d3930dee; standalone gzip marginal was not isolated and grouped measurements are nonadditive.",
};

export type GatedOnlyRatchet = {
  label: string;
  sourceCommit: string;
  measuredAt: string;
  toolchain: string;
  trigger: string;
  ceiling: { "replica-gated.mjs": number; "replica-gated.cjs": number };
};

export const approvedGatedOnlyRatchet: GatedOnlyRatchet = {
  label: "TC-858 refused-replica-admission observer, approved by Naomi 2026-10-16",
  sourceCommit: "212142ae1cf7ff8568d4172a2ca991a4d79364c7",
  measuredAt: "ddc032caef81a2177e7f9c30a6a28a8f593a4580",
  toolchain: "Bun 1.3.14; production webpack; gzip -9 -c",
  trigger: "Refused replica admission only: stale/missing/malformed restore or failed fresh establishment; never successful opt-in, replica-off, or sign-out.",
  ceiling: { "replica-gated.mjs": 926, "replica-gated.cjs": 1014 },
};

/** This is a distinct physical artifact; neither core nor first-import gains headroom. */
export function validateGatedOnlyRatchet(row?: GatedOnlyRatchet, base?: GatedOnlyRatchet): void {
  if (row !== undefined && JSON.stringify(row) !== JSON.stringify(approvedGatedOnlyRatchet)) {
    throw new Error("Only Naomi's exact measured TC-858 gated-only artifact ratchet is approved.");
  }
  if (base !== undefined && JSON.stringify(row) !== JSON.stringify(base)) {
    throw new Error("The gated-only artifact ratchet may not change after introduction.");
  }
}
const historicalToolchain = "Bun 1.4.3; production webpack; gzip -9 -c";

/** Only a git merge-base ledger may retain the pre-correction toolchain. */
export function validateLedger(value: Ledger, historicalBase = false): void {
  if (!value || !value.allowance || !Array.isArray(value.entries) ||
      Object.keys(value).some((key) => key !== "allowance" && key !== "entries" && key !== "phase2Ratchet" && key !== "fixRequiredRatchet")) {
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
  if (value.fixRequiredRatchet !== undefined &&
      (!value.phase2Ratchet ||
       JSON.stringify(value.fixRequiredRatchet) !== JSON.stringify(approvedFixRequiredRatchet))) {
    throw new Error("Only Naomi's exact ddc032ca fix-required root and first-import ratchet is approved.");
  }
}
