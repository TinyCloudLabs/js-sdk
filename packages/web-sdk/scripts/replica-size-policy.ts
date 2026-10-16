import { execFileSync, spawnSync } from "node:child_process";
import type { MeasuredInputGraph } from "./replica-size-inputs";

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
export type CiToolchainCorrection = {
  label: string;
  approvedSource: string;
  policyOnlyThrough: string;
  ciRun: string;
  ciJob: string;
  ciSecondJob: string;
  ciRunUrl: string;
  ciJobUrls: readonly [string, string];
  toolchain: { bun: string; rustc: string };
  historical: {
    master: GzipSizes;
    approvedDelta: GzipSizes;
    rootCeiling: GzipSizes;
    firstImportCeiling: FirstImportSizes;
    activation: { "activation.mjs": number; "activation.cjs": number };
  };
  priorNoncanonical: {
    master: GzipSizes;
    rootCeiling: GzipSizes;
    firstImportCeiling: FirstImportSizes;
    activationCeiling: { "activation.mjs": number; "activation.cjs": number };
  };
  measured: {
    master: GzipSizes;
    delta: GzipSizes;
    rootCeiling: GzipSizes;
    firstImportCeiling: FirstImportSizes;
    activationCeiling: { "activation.mjs": number; "activation.cjs": number };
  };
  reason: string;
};
export type Ledger = {
  allowance: GzipSizes;
  entries: LedgerEntry[];
  phase2Ratchet?: Phase2Ratchet;
  fixRequiredRatchet?: FixRequiredRatchet;
  canonicalToolchainCorrection?: CiToolchainCorrection;
};

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
/** Approved shipped code is unchanged; only GitHub size-job bytes set ceilings. */
export const approvedCiToolchainCorrection: CiToolchainCorrection = {
  label: "TC-858 #548 canonical CI toolchain measurement correction, zero headroom",
  approvedSource: "ddc032caef81a2177e7f9c30a6a28a8f593a4580",
  policyOnlyThrough: "2acd4ac57697333ebe780bc69a54e9586e164998",
  ciRun: "38971529166",
  ciJob: "117210798521",
  ciSecondJob: "117210798348",
  ciRunUrl: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/38971529166",
  ciJobUrls: [
    "https://github.com/TinyCloudLabs/js-sdk/actions/runs/38971529166/job/117210798521",
    "https://github.com/TinyCloudLabs/js-sdk/actions/runs/38971529166/job/117210798348",
  ],
  toolchain: { bun: "1.3.14", rustc: "1.99.0" },
  historical: {
    master: { "index.mjs": 1460603, "index.cjs": 1390460 },
    approvedDelta: { "index.mjs": 1431, "index.cjs": 1339 },
    rootCeiling: { "index.mjs": 1462034, "index.cjs": 1391799 },
    firstImportCeiling: { "replica.mjs": 51785, "replica.cjs": 66995 },
    activation: { "activation.mjs": 23071, "activation.cjs": 24650 },
  },
  priorNoncanonical: {
    master: { "index.mjs": 1462685, "index.cjs": 1393687 },
    rootCeiling: { "index.mjs": 1464189, "index.cjs": 1395035 },
    firstImportCeiling: { "replica.mjs": 51786, "replica.cjs": 66995 },
    activationCeiling: { "activation.mjs": 23073, "activation.cjs": 24653 },
  },
  measured: {
    master: { "index.mjs": 1462590, "index.cjs": 1393500 },
    delta: { "index.mjs": 1512, "index.cjs": 1369 },
    rootCeiling: { "index.mjs": 1464102, "index.cjs": 1394869 },
    firstImportCeiling: { "replica.mjs": 51785, "replica.cjs": 66995 },
    activationCeiling: { "activation.mjs": 23071, "activation.cjs": 24650 },
  },
  reason: "GitHub replica-e2e Node size jobs 117210798521 and 117210798348 in run 38971529166 independently measured the same master9891 and #548 e5b080d5 build under CI Bun 1.3.14 and rustc 1.99.0. Local rebuilds, including the previous 1462685/1393687 master baseline, are non-canonical smoke tests. The GitHub candidate sets stricter zero-headroom root and first-import ceilings without changing shipped source or historical rows.",
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
      Object.keys(value).some((key) => key !== "allowance" && key !== "entries" && key !== "phase2Ratchet" && key !== "fixRequiredRatchet" && key !== "canonicalToolchainCorrection")) {
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
  if (value.canonicalToolchainCorrection !== undefined &&
      (!value.fixRequiredRatchet || value.phase2Ratchet?.toolchain !== approvedPhase2.toolchain ||
       JSON.stringify(value.canonicalToolchainCorrection) !== JSON.stringify(approvedCiToolchainCorrection))) {
    throw new Error("Only the exact Rust 1.99.0 / Bun 1.3.14 CI measurement correction is approved.");
  }
}

export function assertCiSizeToolchain(bun: string, rustcOutput: string, row: CiToolchainCorrection): void {
  const rustc = /^rustc (\d+\.\d+\.\d+)(?:\s|$)/.exec(rustcOutput)?.[1];
  if (bun !== row.toolchain.bun || rustc !== row.toolchain.rustc) {
    throw new Error(`TC-858 size toolchain mismatch: expected Bun ${row.toolchain.bun} and rustc ${row.toolchain.rustc}; received Bun ${bun} and ${rustcOutput}.`);
  }
}

export function validateCiToolchainTransition(
  base?: CiToolchainCorrection,
  current?: CiToolchainCorrection,
): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedCiToolchainCorrection) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The CI Rust 1.99.0 size correction may be introduced once and must remain unchanged thereafter.");
  }
}

// Webpack's index/replica/replica-gated entries and the replica tsup worker
// entry pull from these workspace packages (including transitive SDK and Share
// dependencies). No measured entry or dependency imports packages/cli.
const measuredPackagePrefixes = [
  "packages/web-sdk/",
  "packages/node-sdk/",
  "packages/sdk-services/",
  "packages/sdk-core/",
  "packages/replica/",
  "packages/sdk-rs/",
  "packages/bootstrap/",
  "packages/share-sdk/",
  "packages/share-envelope/",
] as const;

// The reviewed S0 sentence is contract text, not a module. Test files are
// admitted separately only after a fresh graph and emitted-map absence check.
const unbundledContract = "packages/sdk-services/src/kv/replication/CONTRACT.md";

function isCliNonInput(path: string): boolean {
  return path.startsWith("packages/cli/src/") ||
    path.startsWith("packages/cli/test/") ||
    path.startsWith("packages/cli/tests/") ||
    path.startsWith("packages/cli/__tests__/") ||
    path === "packages/cli/README.md" || path === "packages/cli/CHANGELOG.md";
}

function isMeasuredTest(path: string): boolean {
  return measuredPackagePrefixes.some((prefix) => path.startsWith(prefix)) &&
    (/\.test\.ts$/.test(path) || /\/(?:tests|__tests__)\//.test(path));
}

function isMeasuredArtifactInput(path: string): boolean {
  return path === "bun.lock" || path === "package.json" || path === "bunfig.toml" ||
    path === "turbo.json" || /^tsconfig(?:\.[^/]+)?\.json$/.test(path) ||
    path === ".github/workflows/replica-e2e.yml" ||
    (path.startsWith("packages/cli/") && !isCliNonInput(path)) ||
    measuredPackagePrefixes.some((prefix) => path.startsWith(prefix));
}

// A CLI implementation cannot enter either measured entry graph. Its manifest,
// scripts and configs can influence the CI build and remain frozen. Unknown
// paths fail closed, including executable files beside Changesets release notes.
export const ciCorrectionPolicyOnlyPaths: ReadonlySet<string> = new Set([
  "packages/replica/CHANGELOG.md",
  "packages/replica/README.md",
  "packages/replica/scripts/check-worker-size.test.ts",
  "packages/replica/scripts/check-worker-size.ts",
  "packages/web-sdk/README.md",
  "packages/web-sdk/scripts/check-phase1-replica-dist.ts",
  "packages/web-sdk/scripts/check-replica-built-entry.ts",
  "packages/web-sdk/scripts/replica-optional-size-ledger.json",
  "packages/web-sdk/scripts/replica-optional-size-policy.test.ts",
  "packages/web-sdk/scripts/replica-optional-size-policy.ts",
  "packages/web-sdk/scripts/replica-size-ledger.json",
  "packages/web-sdk/scripts/replica-size-policy.test.ts",
  "packages/web-sdk/scripts/replica-size-policy.ts",
  "packages/web-sdk/scripts/replica-size-inputs.ts",
]);

export function isPolicyOnlySinceApprovedSource(
  root: string, approvedSource: string, allowed: ReadonlySet<string>, graph?: MeasuredInputGraph,
): boolean {
  if (spawnSync("git", ["merge-base", "--is-ancestor", approvedSource, "HEAD"], { cwd: root }).status !== 0) {
    return false;
  }
  const changed = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${approvedSource}...HEAD`], { cwd: root });
  return changed.toString("utf8").split("\0").filter(Boolean).every((path) => {
    if (allowed.has(path) || /^\.changeset\/[^/]+\.md$/.test(path) || path === unbundledContract) return true;
    if (isMeasuredArtifactInput(path) && !isMeasuredTest(path)) return false;
    if (!isMeasuredTest(path) && !isCliNonInput(path)) return false;
    return graph !== undefined && !graph.bundleInputs.has(path) && !graph.sourceMapInputs.has(path);
  });
}
