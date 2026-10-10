import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

type Baseline = {
  baselineRef: string;
  baselineToolchain: { node: string; bun: string; rustc: string; wasmPack: string; build: string; gzip: string };
  "index.mjs": number;
  "index.cjs": number;
  webSdkTestBaseline: { ref: string; unhandledErrors: number; failingNames: string[]; unhandledSignatures: string[] };
};
const distDir = resolve(import.meta.dir, "../dist");
const baseline = JSON.parse(await readFile(resolve(import.meta.dir, "phase1-replica-baseline.json"), "utf8")) as Baseline;
const actualToolchain = {
  node: execFileSync("node", ["--version"], { encoding: "utf8" }).trim().replace(/^v/, ""),
  bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
  rustc: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim().replace(/^rustc\s+/, ""),
  wasmPack: execFileSync("wasm-pack", ["--version"], { encoding: "utf8" }).trim(),
};
console.log(`Gzip baseline: ${baseline.baselineRef}; Node ${baseline.baselineToolchain.node}; Bun ${baseline.baselineToolchain.bun}; Rust ${baseline.baselineToolchain.rustc}; ${baseline.baselineToolchain.wasmPack}`);
console.log(`Baseline build: ${baseline.baselineToolchain.build}; gzip: ${baseline.baselineToolchain.gzip}`);
let failed = false;
for (const [tool, version] of Object.entries(actualToolchain)) {
  if (version !== baseline.baselineToolchain[tool as keyof typeof actualToolchain]) {
    console.error(`Baseline toolchain mismatch: ${tool} baseline=${baseline.baselineToolchain[tool as keyof typeof actualToolchain]} current=${version}`);
    failed = true;
  }
}
for (const filename of ["index.mjs", "index.cjs"] as const) {
  const source = await readFile(resolve(distDir, filename), "utf8");
  for (const forbidden of ["@tinycloud/replica", "tinycloud-replica"]) {
    if (source.includes(forbidden)) {
      console.error(`${filename}: forbidden replica reference ${JSON.stringify(forbidden)}`);
      failed = true;
    }
  }
  const current = execFileSync("gzip", ["-9", "-c", resolve(distDir, filename)], { maxBuffer: 10 * 1024 * 1024 }).byteLength;
  const delta = current - baseline[filename];
  console.log(`${filename}: baseline=${baseline[filename]} gzip-bytes current=${current} delta=${delta} bytes`);
  if (delta > 6 * 1024) {
    console.error(`${filename}: gzip delta ${delta} bytes exceeds the 6144-byte limit`);
    failed = true;
  }
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
  if (baseline.webSdkTestBaseline.ref !== baseline.baselineRef) {
    console.error("web-sdk test baseline ref does not match the dist baseline ref");
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
