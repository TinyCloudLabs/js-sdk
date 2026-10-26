import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { measureReplicaOptionalLoaded, type LoadedSizes } from "./measure-replica-optional";
import {
  approvedCompactFixRequired, approvedMeasurementCorrection, approvedRelocations, compactFixOptionalAllowance,
  correctedOptionalAllowance, ciOptionalAllowance, fixRequiredOptionalAllowance, hardeningOptionalAllowance, optionalFormats, tc1413OptionalAllowance, tc1432OptionalAllowance, tc1475OptionalAllowance, masterDriftOptionalAllowance, tc1789OptionalAllowance, tc2043OptionalAllowance, tc1888OptionalAllowance,
  mergedPinsNotLandedOn, priorOptionalAllowance, relocatedOptionalAllowance, validateIntroducedOptionalSources,
  validateOptionalEntryTransition, validateOptionalLedger, type OptionalLedger,
} from "./replica-optional-size-policy";
import { assertCiSizeToolchain, approvedCiToolchainCorrection, approvedFixRequiredRatchet, approvedGatedOnlyRatchet, approvedPhase2, ciCorrectionPolicyOnlyPaths, hasAncestor, isPolicyOnlySinceApprovedSource, preexistingS3EntryCommit, validateCiToolchainTransition, validateGatedOnlyRatchet, validateHardeningRatchetTransition, validateLedger, validateLogoutRatchetTransition, validateMasterMergeResolutionTransition, validateTc1413RatchetTransition, validateTc1424RatchetTransition, validateTc1448RatchetTransition, validateTc1432RatchetTransition, validateTc1436RatchetTransition, validateTc1443RatchetTransition, validateTc1443bRatchetTransition, validateTc1428RatchetTransition, validateTc1475RatchetTransition, validateTc606WorkerRatchetTransition, validateMasterDriftRatchetTransition, validateTc1789RatchetTransition, validateTc1476RatchetTransition, validateTc1466RatchetTransition, type GzipSizes, type Ledger, type LedgerEntry } from "./replica-size-policy";
import { rootCeilingFor, validateTc1757RatchetTransition, validateTc1777ExpiryRatchetTransition, validateTc1777RatchetTransition, validateTc1781DecryptExpiryRatchetTransition, validateTc1801NonTransferableShareRatchetTransition, validateTc1807CredentialDiscoveryRatchetTransition, validateTc1823SizeCodeRatchetTransition, validateTc712CredentialCoreRatchetTransition, validateTc1827ReplicaWorkerRatchetTransition, validateTc1827WorkerRatchetTransition, validateTc848PanelRatchetTransition } from "./replica-size-policy";
import { validateTc1781DecryptStandardExpiryRatchetTransition } from "./replica-size-policy";
import { validateTc1855ManifestLimitGuardRatchetTransition } from "./replica-size-policy";
import { validateTc1488SiweDomainUriRatchetTransition } from "./replica-size-policy";
import { validateTc1737ShortLinkLazyChunkRatchetTransition } from "./replica-size-policy";
import { validateTc1910SigningConsistencyRatchetTransition } from "./replica-size-policy";
import { validateTc848SettingsPanelRatchetTransition } from "./replica-size-policy";
import { validateTc2034NamedKeysCliRatchetTransition } from "./replica-size-policy";
import { validateTc2043SyncScopeRatchetTransition } from "./replica-size-policy";
import { validateTc1888PurgeLocalCopyRatchetTransition } from "./replica-size-policy";
import { validateTc1977ManifestKeysRatchetTransition } from "./replica-size-policy";
import { collectMeasuredArtifactInputs } from "./replica-size-inputs";
import { replicaOwnedPath } from "./replica-owned-path";
import { webSdkTestExitFailure } from "./web-sdk-test-exit";
type Baseline = {
  webSdkTestBaseline: { ref: string; unhandledErrors: number; failingNames: string[]; unhandledSignatures: string[] };
};

/*
 * Rule:
 * - Structural: reject replica references in the core ESM and CJS bundles.
 * - Per-PR: replica-touching PRs compare core gzip and two optional loaded
 *   buckets (first import with parser/noble, then IDB factory activation) against
 *   their git merge base. The already-loaded root is external and counted once.
 * - Cumulative: the historical core ledger stays unchanged for the approved
 *   Phase 2 absolute-root ratchet; the optional and #550 worker buckets are
 *   separately enforced. Other replica PRs append measured rows as before.
 * - The refused-admission observer is a distinct, deferred artifact with its
 *   own exact zero-headroom ESM/CJS ratchet; it never raises root or first-import caps.
 * - Non-replica PRs are never charged; they only validate the ledger shape.
 * - A reviewed row's source commit must be a HEAD ancestor in the PR that
 *   introduces the row. Squash merges leave branch commits out of master, so
 *   merged rows are pinned by exact equality to their approved values instead.
 *   A consistency check also requires each merged pin to be on the PR base or
 *   landed by it (pinLandedOn); it does not stop a new check that re-validates
 *   merged pins against HEAD, which only review prevents.
 *
 * Replica-owned paths: packages/replica/**, packages/sdk-services/src/kv/replication/**,
 * packages/sdk-core/src/replication/** (when present), packages/node-sdk/src/replication/**,
 * packages/web-sdk/src/modules/replica-wiring.ts (the only web-sdk replication wiring;
 * tcw.ts and index.ts only call into it and are not replica-owned), and
 * packages/web-sdk/src/** paths containing "replica" or "replication".
 * Test files (`*.test.*`) under those paths are not replica-owned: they never
 * reach a web bundle, so a test-only edit cannot grow it.
 * Ordinary per-PR core rows retain the existing 64 B build-noise tolerance.
 * The original 388/861 allowance and historical entries remain immutable.
 * TC-858 Phase 2 has a separately approved, exact master9891-relative
 * absolute root ceiling. It replaces additive headroom for this stack, not
 * the first-import/activation/worker ratchets. Later growth above that
 * ceiling needs policy review; an exact controlled re-baseline lowers it.
 * Phase 1's 388/861 allowance was Sam's 6,144 B gzip budget minus its
 * measured growth of 5,756 B ESM / 5,283 B CJS against cbfe21ee.
 */
const distDir = resolve(import.meta.dir, "../dist");
const repoRoot = resolve(import.meta.dir, "../../..");
const baseline = JSON.parse(await readFile(resolve(import.meta.dir, "phase1-replica-baseline.json"), "utf8")) as Baseline;
const ledgerPath = resolve(import.meta.dir, "replica-size-ledger.json");
const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as Ledger;
const optionalLedgerPath = resolve(import.meta.dir, "replica-optional-size-ledger.json");
const optionalLedger = JSON.parse(await readFile(optionalLedgerPath, "utf8")) as OptionalLedger;
const formats = ["index.mjs", "index.cjs"] as const;
const gatedFormats = ["replica-gated.mjs", "replica-gated.cjs"] as const;
const preexistingS3Entry: LedgerEntry = {
  pr: "#553", ticket: "TC-858", "index.mjs": 52, "index.cjs": 55,
  note: "Replica gzip growth measured against this PR's merge base 9516f840 (includes S1 #550 kv-storage code merged into this branch)",
};
let failed = false;

function command(program: string, args: string[], cwd = repoRoot): string {
  return execFileSync(program, args, { cwd, encoding: "utf8" }).trim();
}

async function gzipSizes(directory: string): Promise<GzipSizes> {
  const sizes = {} as GzipSizes;
  for (const format of formats) {
    sizes[format] = execFileSync("gzip", ["-9", "-c", resolve(directory, format)], { maxBuffer: 10 * 1024 * 1024 }).byteLength;
  }
  return sizes;
}

validateLedger(ledger);
const ciCorrection = ledger.canonicalToolchainCorrection;
if (ciCorrection) {
  const bun = command("bun", ["--version"]);
  const rustc = command("rustc", ["--version"]);
  assertCiSizeToolchain(bun, rustc, ciCorrection);
  console.log(`Current size toolchain: Bun ${bun}; ${rustc}`);
}
validateOptionalLedger(optionalLedger, ledger.fixRequiredRatchet !== undefined, ciCorrection !== undefined,
  ledger.hardeningRatchet !== undefined, ledger.tc1413Ratchet !== undefined, ledger.tc1432Ratchet !== undefined, ledger.tc1475Ratchet !== undefined, ledger.masterDriftRatchet !== undefined, ledger.tc1789Ratchet !== undefined, ledger.tc2043SyncScopeRatchet !== undefined, ledger.tc1888PurgeLocalCopyRatchet !== undefined);
const optionalCurrent = await measureReplicaOptionalLoaded(distDir);
for (const format of optionalFormats) {
  const total = optionalLedger.entries.reduce((sum, entry) => sum + entry[format], 0);
  console.log(`${format}: incremental loaded=${optionalCurrent[format]}; cumulative optional ledger=${total} / ${optionalLedger.allowance[format]} gzip-bytes`);
  if (total > optionalLedger.allowance[format] || optionalCurrent[format] > optionalLedger.allowance[format]) {
    console.error(`${format}: optional no-growth allowance exceeded; changing this separate budget requires policy review.`);
    failed = true;
  }
}
for (const format of gatedFormats) {
  const artifact = resolve(distDir, format);
  if (optionalLedger.gatedOnlyRatchet === undefined) {
    if (existsSync(artifact)) {
      console.error(`${format}: an emitted gated-only artifact requires its own reviewed size ratchet.`);
      failed = true;
    }
    continue;
  }
  if (!existsSync(artifact)) {
    console.error(`${format}: the approved gated-only artifact is missing.`);
    failed = true;
    continue;
  }
  const size = execFileSync("gzip", ["-9", "-c", artifact]).byteLength;
  const ceiling = optionalLedger.gatedOnlyRatchet.ceiling[format];
  console.log(`${format}: current=${size}; approved deferred-gate ceiling=${ceiling} gzip-bytes`);
  if (size > ceiling) {
    console.error(`${format}: refused-admission-only artifact grew above its zero-headroom cap.`);
    failed = true;
  }
}
const currentSizes = await gzipSizes(distDir);
for (const format of formats) {
  const source = await readFile(resolve(distDir, format), "utf8");
  for (const forbidden of ["@tinycloud/replica", "tinycloud-replica"]) {
    if (source.includes(forbidden)) {
      console.error(`${format}: forbidden replica reference ${JSON.stringify(forbidden)}`);
      failed = true;
    }
  }
  console.log(`${format}: current=${currentSizes[format]} gzip-bytes`);
  const active = rootCeilingFor(ledger, format);
  if ("error" in active) {
    console.error(active.error);
    failed = true;
  } else {
    console.log(`${format}: TC-858 Phase 2 absolute root ceiling=${active.ceiling} gzip-bytes (newest row: ${active.row})`);
    if (currentSizes[format] > active.ceiling) {
      console.error(`${format}: TC-858 Phase 2 absolute root ceiling exceeded; later growth requires policy review.`);
      failed = true;
    }
  }
}

const reportedBaseSha = process.env.REPLICA_BUDGET_PR_BASE_SHA;
// On refs/pull/N/merge the tested tree is HEAD^1 + the PR head. GitHub regenerates that ref when the
// base branch advances, while the event payload's base.sha stays frozen (and is reused verbatim by
// re-runs). The merge parent is the base this tree was built on, so it is authoritative.
const isMergeRef = /^refs\/pull\/\d+\/merge$/.test(process.env.GITHUB_REF ?? "");
const prBaseSha = reportedBaseSha && isMergeRef ? command("git", ["rev-parse", "HEAD^1"]) : reportedBaseSha;
if (prBaseSha) {
  if (prBaseSha !== reportedBaseSha) {
    console.log(`Base branch advanced since the event (reported ${reportedBaseSha}); using merge parent ${prBaseSha}.`);
  }
  const baseRef = prBaseSha;
  const mergeBase = command("git", ["merge-base", baseRef, "HEAD"]);
  const changedPaths = command("git", ["diff", "--name-only", "--no-renames", `${mergeBase}...HEAD`])
    .split("\n").filter(Boolean);
  const baseLedgerPath = "packages/web-sdk/scripts/replica-size-ledger.json";
  const baseLedgerResult = spawnSync("git", ["show", `${mergeBase}:${baseLedgerPath}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  let baseLedger: Ledger;
  if (baseLedgerResult.status === 0) {
    baseLedger = JSON.parse(baseLedgerResult.stdout) as Ledger;
  } else if (baseLedgerResult.stderr.includes("does not exist in") ||
      baseLedgerResult.stderr.includes("exists on disk, but not in")) {
    baseLedger = { allowance: ledger.allowance, entries: [] };
  } else {
    throw new Error(`Unable to read base ${baseLedgerPath}: ${baseLedgerResult.stderr.trim()}`);
  }
  validateLedger(baseLedger, true);
  validateCiToolchainTransition(baseLedger.canonicalToolchainCorrection, ciCorrection);
  validateMasterMergeResolutionTransition(baseLedger.masterMergeResolution, ledger.masterMergeResolution);
  validateHardeningRatchetTransition(baseLedger.hardeningRatchet, ledger.hardeningRatchet);
  const hardening = ledger.hardeningRatchet;
  if (hardening !== undefined && baseLedger.hardeningRatchet === undefined &&
      (baseLedger.masterMergeResolution === undefined || !hasAncestor(repoRoot, hardening.sourceCommits.at(-1)!))) {
    console.error("The #565 hardening ratchet requires the merged #548 resolution and its measured source commits.");
    failed = true;
  }
  validateLogoutRatchetTransition(baseLedger.logoutRatchet, ledger.logoutRatchet);
  const logout = ledger.logoutRatchet;
  const logoutIntroduced = logout !== undefined && baseLedger.logoutRatchet === undefined;
  if (logoutIntroduced && (baseLedger.hardeningRatchet === undefined || !hasAncestor(repoRoot, logout.sourceCommits.at(-1)!))) {
    console.error("The #571 sign-out ratchet requires the merged #565 hardening ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1413RatchetTransition(baseLedger.tc1413Ratchet, ledger.tc1413Ratchet);
  const tc1413 = ledger.tc1413Ratchet;
  if (tc1413 !== undefined && baseLedger.tc1413Ratchet === undefined &&
      (baseLedger.logoutRatchet === undefined || !hasAncestor(repoRoot, tc1413.sourceCommits.at(-1)!))) {
    console.error("The TC-1413 ratchet requires the merged #571 sign-out ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1436RatchetTransition(baseLedger.tc1436Ratchet, ledger.tc1436Ratchet);
  const tc1436 = ledger.tc1436Ratchet;
  if (tc1436 !== undefined && baseLedger.tc1436Ratchet === undefined &&
      (baseLedger.tc1413Ratchet === undefined || !hasAncestor(repoRoot, tc1436.sourceCommits.at(-1)!))) {
    console.error("The TC-1436 ratchet requires the merged TC-1413 ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1432RatchetTransition(baseLedger.tc1432Ratchet, ledger.tc1432Ratchet);
  const tc1432 = ledger.tc1432Ratchet;
  if (tc1432 !== undefined && baseLedger.tc1432Ratchet === undefined &&
      (baseLedger.tc1436Ratchet === undefined || !hasAncestor(repoRoot, tc1432.sourceCommits.at(-1)!))) {
    console.error("The TC-1432 ratchet requires the merged TC-1436 ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1424RatchetTransition(baseLedger.tc1424Ratchet, ledger.tc1424Ratchet);
  const tc1424 = ledger.tc1424Ratchet;
  if (tc1424 !== undefined && baseLedger.tc1424Ratchet === undefined &&
      (baseLedger.tc1432Ratchet === undefined || !hasAncestor(repoRoot, tc1424.sourceCommits.at(-1)!))) {
    console.error("The TC-1424 ratchet requires the merged TC-1432 ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1448RatchetTransition(baseLedger.tc1448Ratchet, ledger.tc1448Ratchet);
  const tc1448 = ledger.tc1448Ratchet;
  if (tc1448 !== undefined && baseLedger.tc1448Ratchet === undefined &&
      (baseLedger.tc1424Ratchet === undefined || !hasAncestor(repoRoot, tc1448.sourceCommits.at(-1)!))) {
    console.error("The TC-1448 ratchet requires the merged TC-1424 ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1443RatchetTransition(baseLedger.tc1443Ratchet, ledger.tc1443Ratchet);
  const tc1443 = ledger.tc1443Ratchet;
  if (tc1443 !== undefined && baseLedger.tc1443Ratchet === undefined &&
      (baseLedger.tc1448Ratchet === undefined || !hasAncestor(repoRoot, tc1443.sourceCommits.at(-1)!))) {
    console.error("The TC-1443 ratchet requires the merged TC-1448 ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1466RatchetTransition(baseLedger.tc1466Ratchet, ledger.tc1466Ratchet);
  const tc1466 = ledger.tc1466Ratchet;
  if (tc1466 !== undefined && baseLedger.tc1466Ratchet === undefined &&
      (baseLedger.tc1443Ratchet === undefined || !hasAncestor(repoRoot, tc1466.sourceCommits.at(-1)!))) {
    console.error("The TC-1466 ratchet requires the merged TC-1443 ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1443bRatchetTransition(baseLedger.tc1443bRatchet, ledger.tc1443bRatchet);
  const tc1443b = ledger.tc1443bRatchet;
  if (tc1443b !== undefined && baseLedger.tc1443bRatchet === undefined &&
      (baseLedger.tc1466Ratchet === undefined || !hasAncestor(repoRoot, tc1443b.sourceCommits.at(-1)!))) {
    console.error("The TC-1443 slice b ratchet requires the merged TC-1466 ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1428RatchetTransition(baseLedger.tc1428Ratchet, ledger.tc1428Ratchet);
  const tc1428 = ledger.tc1428Ratchet;
  if (tc1428 !== undefined && baseLedger.tc1428Ratchet === undefined &&
      (baseLedger.tc1443bRatchet === undefined || !hasAncestor(repoRoot, tc1428.sourceCommits.at(-1)!))) {
    console.error("The TC-1428 ratchet requires the merged TC-1443 slice b ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1476RatchetTransition(baseLedger.tc1476Ratchet, ledger.tc1476Ratchet);
  const tc1476 = ledger.tc1476Ratchet;
  if (tc1476 !== undefined && baseLedger.tc1476Ratchet === undefined &&
      (baseLedger.tc1428Ratchet === undefined || !hasAncestor(repoRoot, tc1476.sourceCommits.at(-1)!))) {
    console.error("The TC-1476 ratchet requires the merged TC-1428 ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1475RatchetTransition(baseLedger.tc1475Ratchet, ledger.tc1475Ratchet);
  const tc1475 = ledger.tc1475Ratchet;
  if (tc1475 !== undefined && baseLedger.tc1475Ratchet === undefined &&
      (baseLedger.tc1428Ratchet === undefined || !hasAncestor(repoRoot, tc1475.sourceCommits.at(-1)!))) {
    console.error("The TC-1475 ratchet requires the merged TC-1428 ratchet and its measured source commit.");
    failed = true;
  }
  validateTc606WorkerRatchetTransition(baseLedger.tc606WorkerRatchet, ledger.tc606WorkerRatchet);
  const tc606 = ledger.tc606WorkerRatchet;
  if (tc606 !== undefined && baseLedger.tc606WorkerRatchet === undefined &&
      (baseLedger.tc1475Ratchet === undefined || !hasAncestor(repoRoot, tc606.sourceCommits.at(-1)!))) {
    console.error("The TC-606 worker ratchet requires the merged TC-1475 ratchet and its measured source commit.");
    failed = true;
  }
  validateMasterDriftRatchetTransition(baseLedger.masterDriftRatchet, ledger.masterDriftRatchet);
  const masterDrift = ledger.masterDriftRatchet;
  if (masterDrift !== undefined && baseLedger.masterDriftRatchet === undefined &&
      !hasAncestor(repoRoot, masterDrift.sourceCommits.at(-1)!)) {
    console.error("The master-drift ratchet requires its measured source commit.");
    failed = true;
  }
  validateTc1789RatchetTransition(baseLedger.tc1789Ratchet, ledger.tc1789Ratchet);
  const tc1789 = ledger.tc1789Ratchet;
  if (tc1789 !== undefined && baseLedger.tc1789Ratchet === undefined &&
      (baseLedger.masterDriftRatchet === undefined || !hasAncestor(repoRoot, tc1789.sourceCommits.at(-1)!))) {
    console.error("The sdk-services 3.3.1 pin ratchet requires the merged master-drift ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1757RatchetTransition(baseLedger.tc1757Ratchet, ledger.tc1757Ratchet);
  const tc1757 = ledger.tc1757Ratchet;
  if (tc1757 !== undefined && baseLedger.tc1757Ratchet === undefined &&
      (baseLedger.tc1789Ratchet === undefined || !hasAncestor(repoRoot, tc1757.sourceCommits.at(-1)!))) {
    console.error("The web-recipient entry ratchet requires the merged sdk-services pin ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1777RatchetTransition(baseLedger.tc1777Ratchet, ledger.tc1777Ratchet);
  const tc1777 = ledger.tc1777Ratchet;
  if (tc1777 !== undefined && baseLedger.tc1777Ratchet === undefined &&
      (baseLedger.tc1757Ratchet === undefined || !hasAncestor(repoRoot, tc1777.sourceCommits.at(-1)!))) {
    console.error("The replication-wiring boundary ratchet requires the merged web-recipient entry ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1777ExpiryRatchetTransition(baseLedger.tc1777ExpiryRatchet, ledger.tc1777ExpiryRatchet);
  const tc1777Expiry = ledger.tc1777ExpiryRatchet;
  if (tc1777Expiry !== undefined && baseLedger.tc1777ExpiryRatchet === undefined &&
      (baseLedger.tc1777Ratchet === undefined || !hasAncestor(repoRoot, tc1777Expiry.sourceCommits.at(-1)!))) {
    console.error("The expiryMs / hasPermissions ratchet requires the merged replication-wiring boundary ratchet and its measured source commit.");
    failed = true;
  }
  validateTc848PanelRatchetTransition(baseLedger.tc848PanelRatchet, ledger.tc848PanelRatchet);
  const tc848Panel = ledger.tc848PanelRatchet;
  if (tc848Panel !== undefined && baseLedger.tc848PanelRatchet === undefined &&
      (baseLedger.tc1777ExpiryRatchet === undefined || !hasAncestor(repoRoot, tc848Panel.sourceCommits.at(-1)!))) {
    console.error("The developer request log panel ratchet requires the merged expiryMs / hasPermissions ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1781DecryptExpiryRatchetTransition(baseLedger.tc1781DecryptExpiryRatchet, ledger.tc1781DecryptExpiryRatchet);
  const tc1781DecryptExpiry = ledger.tc1781DecryptExpiryRatchet;
  if (tc1781DecryptExpiry !== undefined && baseLedger.tc1781DecryptExpiryRatchet === undefined &&
      (baseLedger.tc848PanelRatchet === undefined || !hasAncestor(repoRoot, tc1781DecryptExpiry.sourceCommits.at(-1)!))) {
    console.error("The one-hour decrypt default ratchet requires the merged developer request log panel ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1801NonTransferableShareRatchetTransition(baseLedger.tc1801NonTransferableShareRatchet, ledger.tc1801NonTransferableShareRatchet);
  const tc1801NonTransferableShare = ledger.tc1801NonTransferableShareRatchet;
  if (tc1801NonTransferableShare !== undefined && baseLedger.tc1801NonTransferableShareRatchet === undefined &&
      (baseLedger.tc1781DecryptExpiryRatchet === undefined || !hasAncestor(repoRoot, tc1801NonTransferableShare.sourceCommits.at(-1)!))) {
    console.error("The non-transferable share option ratchet requires the merged one-hour decrypt default ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1807CredentialDiscoveryRatchetTransition(baseLedger.tc1807CredentialDiscoveryRatchet, ledger.tc1807CredentialDiscoveryRatchet);
  const tc1807CredentialDiscovery = ledger.tc1807CredentialDiscoveryRatchet;
  if (tc1807CredentialDiscovery !== undefined && baseLedger.tc1807CredentialDiscoveryRatchet === undefined &&
      (baseLedger.tc1801NonTransferableShareRatchet === undefined || !hasAncestor(repoRoot, tc1807CredentialDiscovery.sourceCommits.at(-1)!))) {
    console.error("The credential discovery ratchet requires the merged non-transferable share option ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1827WorkerRatchetTransition(baseLedger.tc1827WorkerRatchet, ledger.tc1827WorkerRatchet);
  const tc1827Worker = ledger.tc1827WorkerRatchet;
  if (tc1827Worker !== undefined && baseLedger.tc1827WorkerRatchet === undefined &&
      (baseLedger.tc1807CredentialDiscoveryRatchet === undefined || !hasAncestor(repoRoot, tc1827Worker.sourceCommits.at(-1)!))) {
    console.error("The replica worker narrow-imports ratchet requires the merged credential discovery ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1827ReplicaWorkerRatchetTransition(baseLedger.tc1827ReplicaWorkerRatchet, ledger.tc1827ReplicaWorkerRatchet);
  const tc1827ReplicaWorker = ledger.tc1827ReplicaWorkerRatchet;
  if (tc1827ReplicaWorker !== undefined && baseLedger.tc1827ReplicaWorkerRatchet === undefined &&
      (baseLedger.tc1827WorkerRatchet === undefined || !hasAncestor(repoRoot, tc1827ReplicaWorker.sourceCommits.at(-1)!))) {
    console.error("The replica worker ratchet requires the merged replica worker narrow-imports ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1823SizeCodeRatchetTransition(baseLedger.tc1823SizeCodeRatchet, ledger.tc1823SizeCodeRatchet);
  const tc1823SizeCode = ledger.tc1823SizeCodeRatchet;
  if (tc1823SizeCode !== undefined && baseLedger.tc1823SizeCodeRatchet === undefined &&
      (baseLedger.tc1827WorkerRatchet === undefined || !hasAncestor(repoRoot, tc1823SizeCode.sourceCommits.at(-1)!))) {
    console.error("The request-size error code ratchet requires the merged replica worker narrow-imports ratchet and its measured source commit.");
    failed = true;
  }
  validateTc712CredentialCoreRatchetTransition(baseLedger.tc712CredentialCoreRatchet, ledger.tc712CredentialCoreRatchet);
  const tc712CredentialCore = ledger.tc712CredentialCoreRatchet;
  if (tc712CredentialCore !== undefined && baseLedger.tc712CredentialCoreRatchet === undefined &&
      (baseLedger.tc1823SizeCodeRatchet === undefined || !hasAncestor(repoRoot, tc712CredentialCore.sourceCommits.at(-1)!))) {
    console.error("The credential consumer core ratchet requires the merged request-size error code ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1781DecryptStandardExpiryRatchetTransition(baseLedger.tc1781DecryptStandardExpiryRatchet, ledger.tc1781DecryptStandardExpiryRatchet);
  const tc1781DecryptStandardExpiry = ledger.tc1781DecryptStandardExpiryRatchet;
  if (tc1781DecryptStandardExpiry !== undefined && baseLedger.tc1781DecryptStandardExpiryRatchet === undefined &&
      (baseLedger.tc712CredentialCoreRatchet === undefined || !hasAncestor(repoRoot, tc1781DecryptStandardExpiry.sourceCommits.at(-1)!))) {
    console.error("The decrypt standard expiry ratchet requires the merged credential consumer core ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1855ManifestLimitGuardRatchetTransition(baseLedger.tc1855ManifestLimitGuardRatchet, ledger.tc1855ManifestLimitGuardRatchet);
  const tc1855ManifestLimitGuard = ledger.tc1855ManifestLimitGuardRatchet;
  if (tc1855ManifestLimitGuard !== undefined && baseLedger.tc1855ManifestLimitGuardRatchet === undefined &&
      (baseLedger.tc1781DecryptStandardExpiryRatchet === undefined || !hasAncestor(repoRoot, tc1855ManifestLimitGuard.sourceCommits.at(-1)!))) {
    console.error("The manifest limit guard ratchet requires the merged decrypt standard expiry ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1488SiweDomainUriRatchetTransition(baseLedger.tc1488SiweDomainUriRatchet, ledger.tc1488SiweDomainUriRatchet);
  const tc1488SiweDomainUri = ledger.tc1488SiweDomainUriRatchet;
  if (tc1488SiweDomainUri !== undefined && baseLedger.tc1488SiweDomainUriRatchet === undefined &&
      (baseLedger.tc1855ManifestLimitGuardRatchet === undefined || !hasAncestor(repoRoot, tc1488SiweDomainUri.sourceCommits.at(-1)!))) {
    console.error("The SIWE domain and URI ratchet requires the merged manifest limit guard ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1737ShortLinkLazyChunkRatchetTransition(baseLedger.tc1737ShortLinkLazyChunkRatchet, ledger.tc1737ShortLinkLazyChunkRatchet);
  const tc1737ShortLink = ledger.tc1737ShortLinkLazyChunkRatchet;
  if (tc1737ShortLink !== undefined && baseLedger.tc1737ShortLinkLazyChunkRatchet === undefined &&
      (baseLedger.tc1488SiweDomainUriRatchet === undefined || !hasAncestor(repoRoot, tc1737ShortLink.sourceCommits.at(-1)!))) {
    console.error("The short-link ratchet requires the merged SIWE domain and URI ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1910SigningConsistencyRatchetTransition(baseLedger.tc1910SigningConsistencyRatchet, ledger.tc1910SigningConsistencyRatchet);
  const tc1910SigningConsistency = ledger.tc1910SigningConsistencyRatchet;
  if (tc1910SigningConsistency !== undefined && baseLedger.tc1910SigningConsistencyRatchet === undefined &&
      (baseLedger.tc1737ShortLinkLazyChunkRatchet === undefined || !hasAncestor(repoRoot, tc1910SigningConsistency.sourceCommits.at(-1)!))) {
    console.error("The signing-consistency ratchet requires the merged short-link ratchet and its measured source commit.");
    failed = true;
  }
  validateTc848SettingsPanelRatchetTransition(baseLedger.tc848SettingsPanelRatchet, ledger.tc848SettingsPanelRatchet);
  const tc848SettingsPanel = ledger.tc848SettingsPanelRatchet;
  if (tc848SettingsPanel !== undefined && baseLedger.tc848SettingsPanelRatchet === undefined &&
      (baseLedger.tc1910SigningConsistencyRatchet === undefined || !hasAncestor(repoRoot, tc848SettingsPanel.sourceCommits.at(-1)!))) {
    console.error("The panel ratchet requires the merged signing-consistency ratchet and its measured source commit.");
    failed = true;
  }
  validateTc2034NamedKeysCliRatchetTransition(baseLedger.tc2034NamedKeysCliRatchet, ledger.tc2034NamedKeysCliRatchet);
  const tc2034NamedKeysCli = ledger.tc2034NamedKeysCliRatchet;
  if (tc2034NamedKeysCli !== undefined && baseLedger.tc2034NamedKeysCliRatchet === undefined &&
      (baseLedger.tc848SettingsPanelRatchet === undefined || !hasAncestor(repoRoot, tc2034NamedKeysCli.sourceCommits.at(-1)!))) {
    console.error("The named-keys ratchet requires the merged settings panel ratchet and its measured source commit.");
    failed = true;
  }
  validateTc2043SyncScopeRatchetTransition(baseLedger.tc2043SyncScopeRatchet, ledger.tc2043SyncScopeRatchet);
  const tc2043SyncScope = ledger.tc2043SyncScopeRatchet;
  if (tc2043SyncScope !== undefined && baseLedger.tc2043SyncScopeRatchet === undefined &&
      (baseLedger.tc2034NamedKeysCliRatchet === undefined || !hasAncestor(repoRoot, tc2043SyncScope.sourceCommits.at(-1)!))) {
    console.error("The replication syncScope ratchet requires the merged named-keys ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1888PurgeLocalCopyRatchetTransition(baseLedger.tc1888PurgeLocalCopyRatchet, ledger.tc1888PurgeLocalCopyRatchet);
  const tc1888PurgeLocalCopy = ledger.tc1888PurgeLocalCopyRatchet;
  if (tc1888PurgeLocalCopy !== undefined && baseLedger.tc1888PurgeLocalCopyRatchet === undefined &&
      (baseLedger.tc2043SyncScopeRatchet === undefined || !hasAncestor(repoRoot, tc1888PurgeLocalCopy.sourceCommits.at(-1)!))) {
    console.error("The sign-out local copy ratchet requires the merged replication syncScope ratchet and its measured source commit.");
    failed = true;
  }
  validateTc1977ManifestKeysRatchetTransition(baseLedger.tc1977ManifestKeysRatchet, ledger.tc1977ManifestKeysRatchet);
  const tc1977ManifestKeys = ledger.tc1977ManifestKeysRatchet;
  if (tc1977ManifestKeys !== undefined && baseLedger.tc1977ManifestKeysRatchet === undefined &&
      (baseLedger.tc1888PurgeLocalCopyRatchet === undefined || !hasAncestor(repoRoot, tc1977ManifestKeys.sourceCommits.at(-1)!))) {
    console.error("The manifest-keys ratchet requires the merged sign-out local copy ratchet and its measured source commit.");
    failed = true;
  }
  const baseOptionalPath = "packages/web-sdk/scripts/replica-optional-size-ledger.json";
  const optionalResult = spawnSync("git", ["show", `${mergeBase}:${baseOptionalPath}`], {
    cwd: repoRoot, encoding: "utf8",
  });
  let baseOptional: OptionalLedger;
  if (optionalResult.status === 0) {
    baseOptional = JSON.parse(optionalResult.stdout) as OptionalLedger;
  } else if (optionalResult.stderr.includes("does not exist in") ||
      optionalResult.stderr.includes("exists on disk, but not in")) {
    baseOptional = { allowance: priorOptionalAllowance, entries: [] };
  } else {
    throw new Error(`Unable to read base ${baseOptionalPath}: ${optionalResult.stderr.trim()}`);
  }
  validateOptionalLedger(baseOptional, baseLedger.fixRequiredRatchet !== undefined,
    baseLedger.canonicalToolchainCorrection !== undefined, baseLedger.hardeningRatchet !== undefined,
    baseLedger.tc1413Ratchet !== undefined, baseLedger.tc1432Ratchet !== undefined, baseLedger.tc1475Ratchet !== undefined, baseLedger.masterDriftRatchet !== undefined, baseLedger.tc1789Ratchet !== undefined, baseLedger.tc2043SyncScopeRatchet !== undefined);
  validateIntroducedOptionalSources(baseOptional, optionalLedger);
  // Consistency check: each merged row's pin is on the base or was landed by it (see pinLandedOn).
  for (const { row, pin } of mergedPinsNotLandedOn(repoRoot, baseLedger, baseOptional, prBaseSha)) {
    console.error(`Merged size-policy row ${row} pins ${pin}, which master ${prBaseSha} neither contains nor landed through packages/web-sdk/scripts/.`);
    failed = true;
  }
  validateGatedOnlyRatchet(optionalLedger.gatedOnlyRatchet, baseOptional.gatedOnlyRatchet);
  if (baseOptional.fixRequired !== undefined &&
      JSON.stringify(optionalLedger.fixRequired) !== JSON.stringify(baseOptional.fixRequired)) {
    console.error("Merged fix-required measured-source rows must remain unchanged.");
    failed = true;
  }
  if (optionalLedger.gatedOnlyRatchet !== undefined && baseOptional.gatedOnlyRatchet === undefined &&
      !hasAncestor(repoRoot, approvedGatedOnlyRatchet.sourceCommit)) {
    console.error("The deferred-gate budget requires its measured source commit as an ancestor.");
    failed = true;
  }
  const optionalPrefixMatches = optionalLedger.entries.length >= baseOptional.entries.length &&
    baseOptional.entries.every((entry, index) => {
      const current = optionalLedger.entries[index];
      return current.pr === entry.pr && current.ticket === entry.ticket &&
        optionalFormats.every((format) => current[format] === entry[format]) &&
        current.note === entry.note;
    });
  if (!optionalPrefixMatches) {
    console.error(`${baseOptionalPath} entries[] must preserve the base ledger as an unchanged prefix.`);
    failed = true;
  }
  if (optionalResult.status === 0 && optionalFormats.some((format) =>
    optionalLedger.allowance[format] > baseOptional.allowance[format])) {
    const ciAllowance = optionalLedger.fixRequired === undefined ? ciOptionalAllowance : compactFixOptionalAllowance;
    const pairedTransition = baseOptional.relocations === undefined &&
      JSON.stringify(optionalLedger.relocations) === JSON.stringify(approvedRelocations) &&
      baseOptional.measurementCorrection === undefined &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === priorOptionalAllowance[format] &&
        optionalLedger.allowance[format] ===
          (ciCorrection !== undefined ? ciAllowance[format]
            : ledger.fixRequiredRatchet !== undefined ? fixRequiredOptionalAllowance[format]
              : optionalLedger.measurementCorrection === undefined
                ? relocatedOptionalAllowance[format] : correctedOptionalAllowance[format]));
    const measurementCorrection = JSON.stringify(baseOptional.relocations) === JSON.stringify(approvedRelocations) &&
      baseOptional.measurementCorrection === undefined &&
      JSON.stringify(optionalLedger.measurementCorrection) === JSON.stringify(approvedMeasurementCorrection) &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === relocatedOptionalAllowance[format] &&
        optionalLedger.allowance[format] ===
          (ledger.fixRequiredRatchet !== undefined ? fixRequiredOptionalAllowance[format] : correctedOptionalAllowance[format]));
    const reviewedFixTransition = baseLedger.fixRequiredRatchet === undefined &&
      ledger.fixRequiredRatchet !== undefined &&
      JSON.stringify(baseOptional.measurementCorrection) === JSON.stringify(approvedMeasurementCorrection) &&
      JSON.stringify(optionalLedger.measurementCorrection) === JSON.stringify(baseOptional.measurementCorrection) &&
      JSON.stringify(optionalLedger.gatedOnlyRatchet) === JSON.stringify(baseOptional.gatedOnlyRatchet) &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === correctedOptionalAllowance[format] &&
        optionalLedger.allowance[format] === fixRequiredOptionalAllowance[format]);
    const ciCorrectionTransition = baseLedger.canonicalToolchainCorrection === undefined &&
      ciCorrection !== undefined &&
      JSON.stringify(optionalLedger.relocations) === JSON.stringify(approvedRelocations) &&
      JSON.stringify(optionalLedger.measurementCorrection) === JSON.stringify(approvedMeasurementCorrection) &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === priorOptionalAllowance[format] &&
        optionalLedger.allowance[format] === ciAllowance[format]);
    const compactFixTransition = baseOptional.fixRequired === undefined &&
      JSON.stringify(optionalLedger.fixRequired) === JSON.stringify([approvedCompactFixRequired]) &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === ciOptionalAllowance[format] &&
        optionalLedger.allowance[format] === compactFixOptionalAllowance[format]);
    const hardeningTransition = baseLedger.hardeningRatchet === undefined && ledger.hardeningRatchet !== undefined &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === compactFixOptionalAllowance[format] &&
        optionalLedger.allowance[format] === hardeningOptionalAllowance[format]);
    const tc1413Transition = baseLedger.tc1413Ratchet === undefined && ledger.tc1413Ratchet !== undefined &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === hardeningOptionalAllowance[format] &&
        optionalLedger.allowance[format] === tc1413OptionalAllowance[format]);
    const tc1432Transition = baseLedger.tc1432Ratchet === undefined && ledger.tc1432Ratchet !== undefined &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === tc1413OptionalAllowance[format] &&
        optionalLedger.allowance[format] === tc1432OptionalAllowance[format]);
    const tc1475Transition = baseLedger.tc1475Ratchet === undefined && ledger.tc1475Ratchet !== undefined &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === tc1432OptionalAllowance[format] &&
        optionalLedger.allowance[format] === tc1475OptionalAllowance[format]);
    const masterDriftTransition = baseLedger.masterDriftRatchet === undefined && ledger.masterDriftRatchet !== undefined &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === tc1475OptionalAllowance[format] &&
        optionalLedger.allowance[format] === masterDriftOptionalAllowance[format]);
    const tc1789Transition = baseLedger.tc1789Ratchet === undefined && ledger.tc1789Ratchet !== undefined &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === masterDriftOptionalAllowance[format] &&
        optionalLedger.allowance[format] === tc1789OptionalAllowance[format]);
    const tc2043Transition = baseLedger.tc2043SyncScopeRatchet === undefined && ledger.tc2043SyncScopeRatchet !== undefined &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === tc1789OptionalAllowance[format] &&
        optionalLedger.allowance[format] === tc2043OptionalAllowance[format]);
    const tc1888Transition = baseLedger.tc1888PurgeLocalCopyRatchet === undefined && ledger.tc1888PurgeLocalCopyRatchet !== undefined &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === tc2043OptionalAllowance[format] &&
        optionalLedger.allowance[format] === tc1888OptionalAllowance[format]);
    if (!pairedTransition && !measurementCorrection && !reviewedFixTransition && !ciCorrectionTransition &&
        !compactFixTransition && !hardeningTransition && !tc1413Transition && !tc1432Transition && !tc1475Transition && !masterDriftTransition && !tc1789Transition && !tc2043Transition && !tc1888Transition) {
      console.error(`${baseOptionalPath}: optional allowance may increase only with an exact reviewed relocation, toolchain correction, fix-required source row, hardening ratchet, TC-1413 ratchet, TC-1432 ratchet, TC-1475 ratchet, master-drift ratchet, sdk-services 3.3.1 pin ratchet, TC-2043 syncScope ratchet or TC-1888 sign-out ratchet.`);
      failed = true;
    }
  }
  const replicaPaths = changedPaths.filter(replicaOwnedPath);
  const phase2Introduced = ledger.phase2Ratchet !== undefined && baseLedger.phase2Ratchet === undefined;
  const ciCorrectionIntroduced = ciCorrection !== undefined &&
    baseLedger.canonicalToolchainCorrection === undefined;
  if (ledger.masterMergeResolution !== undefined && baseLedger.masterMergeResolution === undefined &&
      (ledger.masterMergeResolution.masterBase !== prBaseSha ||
       !hasAncestor(repoRoot, ledger.masterMergeResolution.mergedHead))) {
    console.error(`The reviewed master merge input blobs require trusted base ${ledger.masterMergeResolution.masterBase} and resolved merged tree ${ledger.masterMergeResolution.mergedHead}.`);
    failed = true;
  }
  if (ciCorrectionIntroduced) {
    const graph = await collectMeasuredArtifactInputs(repoRoot);
    if (!isPolicyOnlySinceApprovedSource(
      repoRoot, approvedCiToolchainCorrection.approvedSource, ciCorrectionPolicyOnlyPaths, graph,
      {
        ...optionalLedger.fixRequired?.[0]?.measuredPaths,
        ...ledger.masterMergeResolution?.measuredPaths,
      }, prBaseSha,
    )) {
      console.error("CI toolchain size correction requires unchanged measured inputs except exact ruled source blobs since ddc032ca.");
      failed = true;
    }
  }
  const reviewedFixIntroduced = ledger.fixRequiredRatchet !== undefined && baseLedger.fixRequiredRatchet === undefined;
  if (baseLedger.fixRequiredRatchet !== undefined &&
      JSON.stringify(ledger.fixRequiredRatchet) !== JSON.stringify(baseLedger.fixRequiredRatchet)) {
    console.error("The exact ddc032ca fix-required ratchet cannot change after introduction.");
    failed = true;
  }
  if (reviewedFixIntroduced &&
      (optionalLedger.gatedOnlyRatchet === undefined || !hasAncestor(repoRoot, approvedFixRequiredRatchet.measuredAt))) {
    console.error("The reviewed fix-required root/first-import transition requires the measured ddc032ca source and approved gated-only artifact.");
    failed = true;
  }
  if (baseLedger.phase2Ratchet !== undefined &&
      JSON.stringify(ledger.phase2Ratchet) !== JSON.stringify(baseLedger.phase2Ratchet)) {
    const prior = baseLedger.phase2Ratchet;
    const toolchainCorrection = prior.toolchain === "Bun 1.4.3; production webpack; gzip -9 -c" &&
      baseOptional.measurementCorrection === undefined &&
      JSON.stringify(optionalLedger.measurementCorrection) === JSON.stringify(approvedMeasurementCorrection) &&
      JSON.stringify({ ...prior, toolchain: approvedPhase2.toolchain }) === JSON.stringify(ledger.phase2Ratchet);
    if (!toolchainCorrection) {
      console.error("The approved TC-858 Phase 2 ratchet must remain unchanged after its one canonical-toolchain correction.");
      failed = true;
    }
  }
  if (phase2Introduced) {
    const oldEntriesAdded = ledger.entries.slice(baseLedger.entries.length);
    const inheritedS3Only = oldEntriesAdded.length === 0 ||
      (oldEntriesAdded.length === 1 &&
        JSON.stringify(oldEntriesAdded[0]) === JSON.stringify(preexistingS3Entry) &&
        hasAncestor(repoRoot, preexistingS3EntryCommit));
    if (!inheritedS3Only || replicaPaths.length === 0 ||
        formats.some((format) => baseLedger.allowance[format] !== ledger.allowance[format]) ||
        !hasAncestor(repoRoot, approvedPhase2.base)) {
      console.error("TC-858 Phase 2 may introduce only Naomi's exact master9891-relative root ratchet, preserving the old #546/#553 entries.");
      failed = true;
    }
  }
  const prefixMatches = ledger.entries.length >= baseLedger.entries.length &&
    baseLedger.entries.every((entry, index) => {
      const current = ledger.entries[index];
      return current.pr === entry.pr && current.ticket === entry.ticket &&
        current["index.mjs"] === entry["index.mjs"] && current["index.cjs"] === entry["index.cjs"] &&
        current.note === entry.note;
    });
  if (!prefixMatches) {
    console.error("packages/web-sdk/scripts/replica-size-ledger.json entries[] must preserve the base ledger as an unchanged prefix.");
    failed = true;
  }
  for (const format of formats) {
    const total = ledger.entries.reduce((sum, entry) => sum + entry[format], 0);
    console.log(`${format}: cumulative replica ledger=${total} / ${ledger.allowance[format]} gzip-bytes`);
    if (total > ledger.allowance[format]) {
      console.error(`packages/web-sdk/scripts/replica-size-ledger.json allowance exceeded for ${format}; allowance changes require a reviewed policy edit.`);
      failed = true;
    }
  }
  const baseEntriesUnchanged = ledger.entries.length === baseLedger.entries.length &&
    baseLedger.entries.every((entry, index) => {
      const current = ledger.entries[index];
      return current.pr === entry.pr && current.ticket === entry.ticket &&
        current["index.mjs"] === entry["index.mjs"] && current["index.cjs"] === entry["index.cjs"] &&
        current.note === entry.note;
    });
  if (replicaPaths.length === 0) {
    if (!baseEntriesUnchanged) {
      console.error("Non-replica PRs must not append to packages/web-sdk/scripts/replica-size-ledger.json entries[].");
      failed = true;
    }
    console.log("Replica size budget: non-replica PR; no ledger charge or merge-base rebuild.");
    if (optionalLedger.entries.length !== baseOptional.entries.length || !optionalPrefixMatches) {
      console.error("Non-replica PRs must not append to the optional loaded-byte ledger.");
      failed = true;
    }
  } else {
    const rustChanged = changedPaths.some((path) =>
      path.startsWith("packages/sdk-rs/") ||
      /(^|\/)(Cargo\.toml|Cargo\.lock|rust-toolchain[^/]*)$/.test(path) ||
      /(^|\/)\.cargo\//.test(path)
    );
    const tempDir = await mkdtemp(join(tmpdir(), "tc-web-sdk-merge-base-"));
    const worktree = join(tempDir, "worktree");
    try {
      // A first Phase 2 row must compare to the approved master, even when
      // #553 has already merged and is the PR's ordinary merge base.
      const measuredRef = phase2Introduced ? approvedPhase2.base : mergeBase;
      command("git", ["worktree", "add", "--detach", worktree, measuredRef]);
      execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: worktree, stdio: "inherit" });
      if (!rustChanged) {
        for (const directory of ["web-sdk-wasm", "node-sdk-wasm"]) {
          await cp(resolve(repoRoot, "packages/sdk-rs", directory), resolve(worktree, "packages/sdk-rs", directory), { recursive: true });
        }
        console.log("Merge-base build: reusing HEAD WASM outputs (Rust inputs unchanged)");
      }
      // Keep this command list aligned with the "Build the CLI and its packages" step in .github/workflows/replica-e2e.yml.
      const buildCommands: [string, string[]][] = [];
      if (rustChanged) buildCommands.push(["bun", ["run", "--cwd", "packages/sdk-rs", "build:wasm:node"]]);
      buildCommands.push(["bun", ["run", "--cwd", "packages/sdk-rs/packages/node", "build"]]);
      if (rustChanged) buildCommands.push(["bun", ["run", "--cwd", "packages/sdk-rs", "build:wasm:web"]]);
      buildCommands.push(
        ["bun", ["run", "--cwd", "packages/sdk-rs/packages/web", "build"]],
        ["bun", ["run", "--cwd", "packages/bootstrap", "build"]],
        ["bun", ["run", "--cwd", "packages/sdk-services", "build"]],
        ["bun", ["run", "--cwd", "packages/share-envelope", "build"]],
        ["bun", ["run", "--cwd", "packages/share-sdk", "build"]],
        ["bun", ["run", "--cwd", "packages/sdk-core", "build"]],
        ["bun", ["run", "--cwd", "packages/node-sdk", "build"]],
        ["bun", ["run", "--cwd", "packages/operations", "build"]],
        ["bun", ["run", "--cwd", "packages/replica", "build"]],
        ["bun", ["run", "--cwd", "packages/courier", "build"]],
        ["bun", ["run", "--cwd", "packages/node-sdk", "typecheck:replica-contract"]],
        ["bun", ["run", "--cwd", "packages/cli", "build"]],
        ["bun", ["run", "--cwd", "packages/web-sdk", "build"]],
      );
      for (const [program, args] of buildCommands) {
        execFileSync(program, args, { cwd: worktree, stdio: "inherit" });
      }
      const baseSizes = await gzipSizes(resolve(worktree, "packages/web-sdk/dist"));
      const deltas = Object.fromEntries(formats.map((format) => [format, currentSizes[format] - baseSizes[format]])) as GzipSizes;
      for (const format of formats) {
        console.log(`${phase2Introduced ? "approved master9891" : "merge-base"}=${baseSizes[format]} gzip-bytes current=${currentSizes[format]} delta=${deltas[format]} bytes`);
      }
      if (ciCorrection) {
        console.log(`Controlled-master size toolchain: Bun ${ciCorrection.toolchain.bun}; rustc ${ciCorrection.toolchain.rustc} (same HEAD WASM)`);
      }
      if (phase2Introduced &&
          formats.some((format) => Math.abs(baseSizes[format] -
            (ciCorrection?.measured.master[format] ?? approvedPhase2.baseline[format])) > 2)) {
        console.error("Official master9891 build differs by more than 2 B from the approved TC-858 Phase 2 baseline for this toolchain.");
        failed = true;
      }
      const baseOptionalSizes = await measureReplicaOptionalLoaded(resolve(worktree, "packages/web-sdk/dist"));
      const optionalDeltas = Object.fromEntries(optionalFormats.map((format) =>
        [format, optionalCurrent[format] - baseOptionalSizes[format]])) as LoadedSizes;
      for (const format of optionalFormats) {
        console.log(`${format}: merge-base incremental=${baseOptionalSizes[format]} current=${optionalCurrent[format]} delta=${optionalDeltas[format]} gzip-bytes`);
      }
      try {
        validateOptionalEntryTransition(
          baseOptional.entries, optionalLedger.entries, optionalDeltas,
          process.env.REPLICA_BUDGET_PR_NUMBER ? `#${process.env.REPLICA_BUDGET_PR_NUMBER}` : "",
        );
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Invalid optional PR ledger transition");
        console.error(JSON.stringify({
          pr: process.env.REPLICA_BUDGET_PR_NUMBER ? `#${process.env.REPLICA_BUDGET_PR_NUMBER}` : "#<PR>",
          ticket: process.env.REPLICA_BUDGET_TICKET?.match(/\bTC-\d+\b/i)?.[0] ?? "TC-UNKNOWN",
          ...optionalDeltas, note: "Optional first-import and IDB activation gzip deltas against this PR's merge base",
        }));
        failed = true;
      }
      const appended = ledger.entries.slice(baseLedger.entries.length);
      if (phase2Introduced) {
        // The separately approved row replaces a cumulative #548 entry; #553
        // remains its own unchanged upstream ledger entry.
        if (!prefixMatches) failed = true;
        console.log("TC-858 Phase 2 uses its exact absolute-root policy row, not additive old headroom.");
      } else if (logoutIntroduced && prefixMatches && appended.length === 1) {
        // The exact sign-out row carries the growth through its absolute root ceiling, as for Phase 2,
        // so the cumulative old-headroom entry is zero. The measured growth may not exceed the row.
        const entry = appended[0];
        for (const format of formats) {
          if (entry[format] !== 0 || deltas[format] > logout.root.delta[format]) {
            console.error(`${format}: the #571 entry must be 0 and the measured growth ${deltas[format]} must not exceed the sign-out row's ${logout.root.delta[format]}.`);
            failed = true;
          }
        }
        console.log("TC-858 #571 uses its exact absolute-root sign-out row, not additive old headroom.");
      } else if (tc1888PurgeLocalCopy !== undefined && baseLedger.tc1888PurgeLocalCopyRatchet === undefined && prefixMatches && appended.length === 1) {
        // The exact TC-1888 row carries the growth through its absolute root ceiling.
        const entry = appended[0];
        for (const format of formats) {
          if (entry[format] !== 0 || deltas[format] > tc1888PurgeLocalCopy.root.delta[format]) {
            console.error(`${format}: the TC-1888 entry must be 0 and the measured growth ${deltas[format]} must not exceed the TC-1888 row's ${tc1888PurgeLocalCopy.root.delta[format]}.`);
            failed = true;
          }
        }
        console.log("TC-1888 uses its exact absolute-root row, not additive old headroom.");
      } else if (tc1413 !== undefined && baseLedger.tc1413Ratchet === undefined && prefixMatches && appended.length === 1) {
        // As for #571: the exact TC-1413 row carries the growth through its absolute root ceiling, so the
        // cumulative old-headroom entry is zero. The measured growth may not exceed the row.
        const entry = appended[0];
        for (const format of formats) {
          if (entry[format] !== 0 || deltas[format] > tc1413.root.delta[format]) {
            console.error(`${format}: the TC-1413 entry must be 0 and the measured growth ${deltas[format]} must not exceed the TC-1413 row's ${tc1413.root.delta[format]}.`);
            failed = true;
          }
        }
        console.log("TC-1413 uses its exact absolute-root row, not additive old headroom.");
      } else if (tc1432 !== undefined && baseLedger.tc1432Ratchet === undefined && prefixMatches && appended.length === 1) {
        // As for TC-1413: the exact TC-1432 row carries the growth through its absolute root ceiling, so the
        // cumulative old-headroom entry is zero. The measured growth may not exceed the row.
        const entry = appended[0];
        for (const format of formats) {
          if (entry[format] !== 0 || deltas[format] > tc1432.root.delta[format]) {
            console.error(`${format}: the TC-1432 entry must be 0 and the measured growth ${deltas[format]} must not exceed the TC-1432 row's ${tc1432.root.delta[format]}.`);
            failed = true;
          }
        }
        console.log("TC-1432 uses its exact absolute-root row, not additive old headroom.");
      } else if (tc1443b !== undefined && baseLedger.tc1443bRatchet === undefined && prefixMatches && appended.length === 1) {
        // As for TC-1432: the exact TC-1443 slice b row carries the growth through its absolute root ceiling,
        // so the cumulative old-headroom entry is zero. The measured growth may not exceed the row.
        const entry = appended[0];
        for (const format of formats) {
          if (entry[format] !== 0 || deltas[format] > tc1443b.root.delta[format]) {
            console.error(`${format}: the TC-1443 slice b entry must be 0 and the measured growth ${deltas[format]} must not exceed the TC-1443 slice b row's ${tc1443b.root.delta[format]}.`);
            failed = true;
          }
        }
        console.log("TC-1443 slice b uses its exact absolute-root row, not additive old headroom.");
      } else if (tc1475 !== undefined && baseLedger.tc1475Ratchet === undefined && prefixMatches && appended.length === 1) {
        // As for TC-1432: the exact TC-1475 row carries the growth through its absolute root ceiling, so the
        // cumulative old-headroom entry is zero. The measured growth may not exceed the row.
        const entry = appended[0];
        for (const format of formats) {
          if (entry[format] !== 0 || deltas[format] > tc1475.root.delta[format]) {
            console.error(`${format}: the TC-1475 entry must be 0 and the measured growth ${deltas[format]} must not exceed the TC-1475 row's ${tc1475.root.delta[format]}.`);
            failed = true;
          }
        }
        console.log("TC-1475 uses its exact absolute-root row, not additive old headroom.");
      } else if (masterDrift !== undefined && baseLedger.masterDriftRatchet === undefined && prefixMatches && appended.length === 1) {
        // As for TC-1475: the exact master-drift row carries the growth through its absolute root ceiling, so
        // the cumulative old-headroom entry is zero. The measured growth may not exceed the row.
        const entry = appended[0];
        for (const format of formats) {
          if (entry[format] !== 0 || deltas[format] > masterDrift.root.delta[format]) {
            console.error(`${format}: the master-drift entry must be 0 and the measured growth ${deltas[format]} must not exceed the master-drift row's ${masterDrift.root.delta[format]}.`);
            failed = true;
          }
        }
        console.log("Master drift uses its exact absolute-root row, not additive old headroom.");
      } else if (tc1789 !== undefined && baseLedger.tc1789Ratchet === undefined && prefixMatches && appended.length === 1) {
        // As for master drift: the exact sdk-services pin row carries any growth through its absolute root ceiling, so
        // the cumulative old-headroom entry is zero. The measured growth may not exceed the row.
        const entry = appended[0];
        for (const format of formats) {
          if (entry[format] !== 0 || deltas[format] > tc1789.root.delta[format]) {
            console.error(`${format}: the sdk-services pin entry must be 0 and the measured growth ${deltas[format]} must not exceed the sdk-services pin row's ${tc1789.root.delta[format]}.`);
            failed = true;
          }
        }
        console.log("The sdk-services 3.3.1 pin uses its exact absolute-root row, not additive old headroom.");
      } else if (!prefixMatches || appended.length !== 1) {
        const pr = process.env.REPLICA_BUDGET_PR_NUMBER ? `#${process.env.REPLICA_BUDGET_PR_NUMBER}` : "#<PR>";
        const ticket = process.env.REPLICA_BUDGET_TICKET?.match(/\bTC-\d+\b/i)?.[0] ?? "TC-UNKNOWN";
        console.error("Replica-touching PR must append exactly one ledger entry to packages/web-sdk/scripts/replica-size-ledger.json entries[]. Add this entry:");
        console.error(JSON.stringify({ pr, ticket, ...deltas, note: "Replica gzip growth measured against this PR's merge base" }));
        failed = true;
      } else {
        const entry = appended[0];
        for (const format of formats) {
          if (!Number.isInteger(entry[format]) || entry[format] < deltas[format] - (deltas[format] > 0 ? 64 : 0)) {
            const pr = process.env.REPLICA_BUDGET_PR_NUMBER ? `#${process.env.REPLICA_BUDGET_PR_NUMBER}` : entry.pr;
            const ticket = process.env.REPLICA_BUDGET_TICKET?.match(/\bTC-\d+\b/i)?.[0] ?? entry.ticket;
            console.error(`packages/web-sdk/scripts/replica-size-ledger.json entries[] too small for ${format}. Replace it with:`);
            console.error(JSON.stringify({ pr, ticket, ...deltas, note: "Replica gzip growth measured against this PR's merge base" }));
            failed = true;
            break;
          }
        }
      }
      if (!phase2Introduced && prefixMatches && appended.length !== 1) failed = true;
      console.log(`Replica-owned changes: ${replicaPaths.join(", ")}`);
    } finally {
      try {
        command("git", ["worktree", "remove", "--force", worktree]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }
} else {
  console.log("Replica size budget: no pull-request merge base; reporting only.");
}

// Keep structural/size inspection independent of the web test suite.
if (process.argv.includes("--dist-only")) process.exit(failed ? 1 : 0);
const reportDir = await mkdtemp(join(tmpdir(), "tc-web-sdk-junit-"));
const report = join(reportDir, "web-sdk.xml");
try {
  // Bun's file workers share global test shims; keep the suite in one worker.
  const test = spawnSync("bun", ["test", "--parallel=1", "packages/web-sdk/tests", "--reporter=junit", `--reporter-outfile=${report}`], {
    cwd: resolve(import.meta.dir, "../../.."),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (test.error) throw test.error;
  process.stdout.write(test.stdout);
  process.stderr.write(test.stderr);
  const exitFailure = webSdkTestExitFailure(test.status, test.signal);
  if (exitFailure) {
    console.error(`${exitFailure}; the step fails on any non-zero exit even when the junit report is clean`);
    failed = true;
  }
  const xml = await readFile(report, "utf8");
  const cases = [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
  const decode = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const failedNames = cases.flatMap(([, attributes, body]) => {
    if (!/<(?:failure|error)\b/.test(body ?? "")) return [];
    const name = attributes.match(/\bname="([^"]*)"/)?.[1];
    const file = attributes.match(/\bfile="([^"]*)"/)?.[1];
    return [decode(`${file ?? "unknown test file"}::${name ?? "unnamed test"}`)];
  });
  const output = `${test.stdout}\n${test.stderr}`;
  const unhandledSignatures = [...output.matchAll(/# Unhandled error between tests\n-{20,}\n([\s\S]*?)(?=\n-{20,}\n)/g)].map(([, block]) => {
    if (block.includes("ReferenceError: HTMLElement is not defined")) return "ReferenceError: HTMLElement is not defined";
    const message = block.match(/error:\s*(.+)/)?.[1] ?? "unidentified unhandled test error";
    if (message.includes("Cannot find package 'eth-testing'")) return "Cannot find package 'eth-testing'";
    if (message.includes("paired OpenCredentials worktree not found")) return "paired OpenCredentials worktree not found";
    return `unrecognized: ${message}`;
  });
  const unhandledErrors = Math.max(
    Number(output.match(/\b(\d+) errors?\b/i)?.[1] ?? 0),
    unhandledSignatures.length,
  );
  const baselineNames = new Set(baseline.webSdkTestBaseline.failingNames);
  const newFailures = failedNames.filter((name) => !baselineNames.has(name));
  const newUnhandled = unhandledSignatures.filter((signature) => !baseline.webSdkTestBaseline.unhandledSignatures.includes(signature));
  console.log(`web-sdk tests: ${cases.length} cases; failures=${failedNames.length}; unhandled=${unhandledErrors}`);
  console.log(`web-sdk failing names: ${failedNames.length === 0 ? "(none)" : failedNames.join(" | ")}`);
  console.log(`web-sdk unhandled signatures: ${unhandledSignatures.length === 0 ? "(none)" : unhandledSignatures.join(" | ")}`);
  if (typeof baseline.webSdkTestBaseline.ref !== "string" || baseline.webSdkTestBaseline.ref.length === 0) {
    console.error("web-sdk test failure baseline must retain its reference");
    failed = true;
  }
  if (newFailures.length > 0) {
    console.error(`web-sdk has failures outside the baseline: ${newFailures.join(" | ")}`);
    failed = true;
  }
  if (newUnhandled.length > 0) {
    console.error(`web-sdk has unhandled errors outside the baseline: ${newUnhandled.join(" | ")}`);
    failed = true;
  }
  if (unhandledErrors > baseline.webSdkTestBaseline.unhandledErrors) {
    console.error(`web-sdk has ${unhandledErrors} unhandled errors; baseline allows ${baseline.webSdkTestBaseline.unhandledErrors}`);
    failed = true;
  }
} finally {
  await rm(reportDir, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
