import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { measureReplicaOptionalLoaded, type LoadedSizes } from "./measure-replica-optional";
import { approvedGatedOnlyRatchet, approvedPhase2, validateGatedOnlyRatchet, validateLedger, type GatedOnlyRatchet, type GzipSizes, type Ledger, type LedgerEntry } from "./replica-size-policy";

type OptionalEntry = LoadedSizes & { pr: string; ticket: string; note: string };
type OptionalLedger = { allowance: LoadedSizes; entries: OptionalEntry[]; relocations?: unknown; measurementCorrection?: unknown; gatedOnlyRatchet?: GatedOnlyRatchet };
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
 *
 * Replica-owned paths: packages/replica/**, packages/sdk-services/src/kv/replication/**,
 * packages/sdk-core/src/replication/** (when present), packages/node-sdk/src/replication/**,
 * and packages/web-sdk/src/** paths containing "replica" or "replication".
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
// web-sdk files that wire replication into the client bundle; their bytes are replica-owned
// even though the filenames do not match the regex below.
const replicationWiringPaths = new Set([
  "packages/web-sdk/src/index.ts",
  "packages/web-sdk/src/modules/tcw.ts",
]);
const replicaOwnedPath = (path: string) =>
  !/\.test\.[cm]?[jt]sx?$/.test(path) && (
    path.startsWith("packages/replica/") ||
    path.startsWith("packages/sdk-services/src/kv/replication/") ||
    path.startsWith("packages/sdk-core/src/replication/") ||
    path.startsWith("packages/node-sdk/src/replication/") ||
    replicationWiringPaths.has(path) ||
    (path.startsWith("packages/web-sdk/src/") && /replica|replication/i.test(path))
  );
const distDir = resolve(import.meta.dir, "../dist");
const repoRoot = resolve(import.meta.dir, "../../..");
const baseline = JSON.parse(await readFile(resolve(import.meta.dir, "phase1-replica-baseline.json"), "utf8")) as Baseline;
const ledgerPath = resolve(import.meta.dir, "replica-size-ledger.json");
const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as Ledger;
const optionalLedgerPath = resolve(import.meta.dir, "replica-optional-size-ledger.json");
const optionalLedger = JSON.parse(await readFile(optionalLedgerPath, "utf8")) as OptionalLedger;
const formats = ["index.mjs", "index.cjs"] as const;
const optionalFormats = ["replica.mjs", "replica.cjs", "activation.mjs", "activation.cjs"] as const;
const gatedFormats = ["replica-gated.mjs", "replica-gated.cjs"] as const;
// Naomi-approved 2578c6a7 stamp-dispatch relocation. Both measured buckets
// travel together; the root ceiling and the immutable #546 ledger row do not change.
const relocationCommit = "2578c6a7624a3408b4584ed2331723694b8afb4b";
const priorOptionalAllowance: LoadedSizes = {
  "replica.mjs": 45507, "replica.cjs": 65006, "activation.mjs": 23081, "activation.cjs": 24886,
};
const relocatedOptionalAllowance: LoadedSizes = {
  ...priorOptionalAllowance, "replica.mjs": 45657, "replica.cjs": 65176,
};
// ce52494d was approved with Bun 1.4.3, while the replica-size CI job now pins
// Bun 1.3.14. The same 25-module browser graph minifies differently; correct
// only the first-import measurement, leaving root, activation and worker fixed.
const correctedOptionalAllowance: LoadedSizes = {
  ...relocatedOptionalAllowance, "replica.mjs": 51201, "replica.cjs": 66132,
};
const approvedMeasurementCorrection = {
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
const approvedRelocations = [
  { commit: relocationCommit, bucket: "web-core", "index.mjs": -143, "index.cjs": -130 },
  { commit: relocationCommit, bucket: "web-optional:first-import", "replica.mjs": 150, "replica.cjs": 170 },
];
const preexistingS3Entry: LedgerEntry = {
  pr: "#553", ticket: "TC-858", "index.mjs": 52, "index.cjs": 55,
  note: "Replica gzip growth measured against this PR's merge base 9516f840 (includes S1 #550 kv-storage code merged into this branch)",
};
let failed = false;

function validateOptionalLedger(value: OptionalLedger): void {
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
  const ceiling = corrected ? correctedOptionalAllowance : relocated ? relocatedOptionalAllowance : priorOptionalAllowance;
  if (optionalFormats.some((format) => value.allowance[format] !== ceiling[format]) ||
      (relocated && JSON.stringify(value.relocations) !== JSON.stringify(approvedRelocations)) ||
      (corrected && (!relocated || JSON.stringify(value.measurementCorrection) !== JSON.stringify(approvedMeasurementCorrection)))) {
    throw new Error(`${path}: only the exact paired ${relocationCommit} relocation and ce52494d Bun correction are approved`);
  }
  validateGatedOnlyRatchet(value.gatedOnlyRatchet);
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
validateOptionalLedger(optionalLedger);
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
  const ceiling = ledger.phase2Ratchet?.ceiling[format];
  if (ceiling !== undefined) {
    console.log(`${format}: TC-858 Phase 2 absolute root ceiling=${ceiling} gzip-bytes`);
    if (currentSizes[format] > ceiling) {
      console.error(`${format}: TC-858 Phase 2 absolute root ceiling exceeded; later growth requires policy review.`);
      failed = true;
    }
  }
}

const prBaseSha = process.env.REPLICA_BUDGET_PR_BASE_SHA;
if (prBaseSha) {
  const baseRef = /^refs\/pull\/\d+\/merge$/.test(process.env.GITHUB_REF ?? "") ? "HEAD^1" : prBaseSha;
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
  validateOptionalLedger(baseOptional);
  validateGatedOnlyRatchet(optionalLedger.gatedOnlyRatchet, baseOptional.gatedOnlyRatchet);
  if (optionalLedger.gatedOnlyRatchet !== undefined && baseOptional.gatedOnlyRatchet === undefined &&
      spawnSync("git", ["merge-base", "--is-ancestor", approvedGatedOnlyRatchet.sourceCommit, "HEAD"], {
        cwd: repoRoot,
      }).status !== 0) {
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
    const pairedTransition = baseOptional.relocations === undefined &&
      JSON.stringify(optionalLedger.relocations) === JSON.stringify(approvedRelocations) &&
      baseOptional.measurementCorrection === undefined &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === priorOptionalAllowance[format] &&
        optionalLedger.allowance[format] ===
          (optionalLedger.measurementCorrection === undefined
            ? relocatedOptionalAllowance[format] : correctedOptionalAllowance[format]));
    const measurementCorrection = JSON.stringify(baseOptional.relocations) === JSON.stringify(approvedRelocations) &&
      baseOptional.measurementCorrection === undefined &&
      JSON.stringify(optionalLedger.measurementCorrection) === JSON.stringify(approvedMeasurementCorrection) &&
      optionalFormats.every((format) =>
        baseOptional.allowance[format] === relocatedOptionalAllowance[format] &&
        optionalLedger.allowance[format] === correctedOptionalAllowance[format]);
    if (!pairedTransition && !measurementCorrection) {
      console.error(`${baseOptionalPath}: optional allowance may increase only with the exact paired core relocation or ce52494d canonical-toolchain correction.`);
      failed = true;
    }
  }
  const replicaPaths = changedPaths.filter(replicaOwnedPath);
  const phase2Introduced = ledger.phase2Ratchet !== undefined && baseLedger.phase2Ratchet === undefined;
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
        spawnSync("git", ["merge-base", "--is-ancestor", "0241ba9b", "HEAD"], { cwd: repoRoot }).status === 0);
    if (!inheritedS3Only || replicaPaths.length === 0 ||
        formats.some((format) => baseLedger.allowance[format] !== ledger.allowance[format]) ||
        spawnSync("git", ["merge-base", "--is-ancestor", approvedPhase2.base, "HEAD"], { cwd: repoRoot }).status !== 0) {
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
      if (phase2Introduced &&
          formats.some((format) => Math.abs(baseSizes[format] - approvedPhase2.baseline[format]) > 2)) {
        console.error("Official master9891 build differs by more than 2 B from the approved TC-858 Phase 2 baseline.");
        failed = true;
      }
      const baseOptionalSizes = await measureReplicaOptionalLoaded(resolve(worktree, "packages/web-sdk/dist"));
      const optionalDeltas = Object.fromEntries(optionalFormats.map((format) =>
        [format, optionalCurrent[format] - baseOptionalSizes[format]])) as LoadedSizes;
      for (const format of optionalFormats) {
        console.log(`${format}: merge-base incremental=${baseOptionalSizes[format]} current=${optionalCurrent[format]} delta=${optionalDeltas[format]} gzip-bytes`);
      }
      const optionalAppended = optionalLedger.entries.slice(baseOptional.entries.length);
      if (!optionalPrefixMatches || optionalAppended.length !== 1) {
        console.error(`Replica-touching PR must append exactly one measured row to ${baseOptionalPath}:`);
        console.error(JSON.stringify({
          pr: process.env.REPLICA_BUDGET_PR_NUMBER ? `#${process.env.REPLICA_BUDGET_PR_NUMBER}` : "#<PR>",
          ticket: process.env.REPLICA_BUDGET_TICKET?.match(/\bTC-\d+\b/i)?.[0] ?? "TC-UNKNOWN",
          ...optionalDeltas, note: "Optional first-import and IDB activation gzip deltas against this PR's merge base",
        }));
        failed = true;
      } else if (optionalFormats.some((format) => optionalAppended[0][format] !== optionalDeltas[format])) {
        console.error(`${baseOptionalPath} appended row must record exact observed first-import and IDB activation deltas: ${JSON.stringify(optionalDeltas)}`);
        failed = true;
      }
      const appended = ledger.entries.slice(baseLedger.entries.length);
      if (phase2Introduced) {
        // The separately approved row replaces a cumulative #548 entry; #553
        // remains its own unchanged upstream ledger entry.
        if (!prefixMatches) failed = true;
        console.log("TC-858 Phase 2 uses its exact absolute-root policy row, not additive old headroom.");
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
