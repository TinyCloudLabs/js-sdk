import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

type GzipSizes = { "index.mjs": number; "index.cjs": number };
type LedgerEntry = { pr: string; ticket: string; "index.mjs": number; "index.cjs": number; note: string };
type Ledger = { allowance: GzipSizes; entries: LedgerEntry[] };
type Baseline = {
  webSdkTestBaseline: { ref: string; unhandledErrors: number; failingNames: string[]; unhandledSignatures: string[] };
};

/*
 * Rule:
 * - Structural: always reject replica references in either web bundle.
 * - Per-PR: replica-touching PRs compare gzip growth with their git merge base.
 * - Cumulative: replica PRs add one measured entry to the reviewed ledger; totals
 *   cannot exceed its allowance. Entries may record negative deltas when code shrinks.
 * - Non-replica PRs are never charged; they only validate the ledger shape.
 *
 * Replica-owned paths: packages/replica/**, packages/sdk-services/src/kv/replication/**,
 * packages/sdk-core/src/replication/** (when present), packages/node-sdk/src/replication/**,
 * and packages/web-sdk/src/** paths containing "replica" or "replication".
 * Build noise tolerance is 64 gzip bytes: an entry may be up to 64 bytes below
 * the measured positive delta; always record the exact observed delta when possible.
 */
const replicaOwnedPath = (path: string) =>
  path.startsWith("packages/replica/") ||
  path.startsWith("packages/sdk-services/src/kv/replication/") ||
  path.startsWith("packages/sdk-core/src/replication/") ||
  path.startsWith("packages/node-sdk/src/replication/") ||
  (path.startsWith("packages/web-sdk/src/") && /replica|replication/i.test(path));
const distDir = resolve(import.meta.dir, "../dist");
const repoRoot = resolve(import.meta.dir, "../../..");
const baseline = JSON.parse(await readFile(resolve(import.meta.dir, "phase1-replica-baseline.json"), "utf8")) as Baseline;
const ledgerPath = resolve(import.meta.dir, "replica-size-ledger.json");
const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as Ledger;
const formats = ["index.mjs", "index.cjs"] as const;
let failed = false;

function validateLedger(value: Ledger): void {
  if (!value || !value.allowance || !Array.isArray(value.entries)) throw new Error("Invalid replica size ledger shape");
  for (const format of formats) {
    if (!Number.isFinite(value.allowance[format])) throw new Error(`Invalid ledger allowance for ${format}`);
  }
  for (const entry of value.entries) {
    if (!entry || typeof entry.pr !== "string" || typeof entry.ticket !== "string" || typeof entry.note !== "string" ||
        formats.some((format) => !Number.isFinite(entry[format]))) {
      throw new Error("Invalid replica size ledger entry");
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
}

const prBaseSha = process.env.REPLICA_BUDGET_PR_BASE_SHA;
if (prBaseSha) {
  const mergeBase = command("git", ["merge-base", prBaseSha, "HEAD"]);
  const changedPaths = command("git", ["diff", "--name-only", `${mergeBase}...HEAD`]).split("\n").filter(Boolean);
  const replicaPaths = changedPaths.filter(replicaOwnedPath);
  const rustChanged = changedPaths.some((path) => path.startsWith("packages/sdk-rs/"));
  const tempDir = await mkdtemp(join(tmpdir(), "tc-web-sdk-merge-base-"));
  const worktree = join(tempDir, "worktree");
  try {
    command("git", ["worktree", "add", "--detach", worktree, mergeBase]);
    execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: worktree, stdio: "inherit" });
    if (!rustChanged) {
      for (const directory of ["web-sdk-wasm", "node-sdk-wasm"]) {
        await cp(resolve(repoRoot, "packages/sdk-rs", directory), resolve(worktree, "packages/sdk-rs", directory), { recursive: true });
      }
      console.log("Merge-base build: reusing HEAD WASM outputs (packages/sdk-rs unchanged)");
    }
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
    for (const format of formats) {
      const delta = currentSizes[format] - baseSizes[format];
      console.log(`${format}: merge-base=${baseSizes[format]} gzip-bytes current=${currentSizes[format]} delta=${delta} bytes`);
    }
    if (replicaPaths.length === 0) {
      console.log("Replica size budget: non-replica PR; no ledger charge.");
    } else {
      const baseLedger = JSON.parse(await readFile(resolve(worktree, "packages/web-sdk/scripts/replica-size-ledger.json"), "utf8")) as Ledger;
      validateLedger(baseLedger);
      const appended = ledger.entries.slice(baseLedger.entries.length);
      const prefixMatches = JSON.stringify(ledger.entries.slice(0, baseLedger.entries.length)) === JSON.stringify(baseLedger.entries);
      const deltas = Object.fromEntries(formats.map((format) => [format, currentSizes[format] - baseSizes[format]])) as GzipSizes;
      if (!prefixMatches || appended.length !== 1) {
        const pr = process.env.REPLICA_BUDGET_PR_NUMBER ? `#${process.env.REPLICA_BUDGET_PR_NUMBER}` : "#<PR>";
        const ticket = process.env.REPLICA_BUDGET_TICKET?.match(/\bTC-\d+\b/i)?.[0] ?? "TC-UNKNOWN";
        console.error("Replica-touching PR must append exactly one ledger entry. Add this entry:");
        console.error(JSON.stringify({ pr, ticket, ...deltas, note: "Replica gzip growth measured against this PR's merge base" }));
        failed = true;
      } else {
        const entry = appended[0];
        for (const format of formats) {
          if (deltas[format] > 0 && entry[format] + 64 < deltas[format]) {
            const pr = process.env.REPLICA_BUDGET_PR_NUMBER ? `#${process.env.REPLICA_BUDGET_PR_NUMBER}` : entry.pr;
            const ticket = process.env.REPLICA_BUDGET_TICKET?.match(/\bTC-\d+\b/i)?.[0] ?? entry.ticket;
            console.error(`Ledger entry too small for ${format} (64-byte build-noise tolerance). Replace it with:`);
            console.error(JSON.stringify({ pr, ticket, ...deltas, note: "Replica gzip growth measured against this PR's merge base" }));
            failed = true;
          }
        }
      }
      for (const format of formats) {
        const total = ledger.entries.reduce((sum, entry) => sum + entry[format], 0);
        console.log(`${format}: cumulative replica ledger=${total} / ${ledger.allowance[format]} gzip-bytes`);
        if (total > ledger.allowance[format]) {
          console.error(`${format}: cumulative replica ledger exceeds allowance. Raising allowance is a budget-owner or Sam decision; edit "allowance" in a reviewed PR.`);
          failed = true;
        }
      }
      if (replicaPaths.length > 0) console.log(`Replica-owned changes: ${replicaPaths.join(", ")}`);
    }
  } finally {
    try {
      command("git", ["worktree", "remove", "--force", worktree]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
} else {
  console.log("Replica size budget: no pull-request merge base; reporting only.");
}

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
