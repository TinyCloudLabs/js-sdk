// Mutation harness for the email-proof credential core.
// Usage (from packages/node-sdk): node scripts/mutation/mutate.mjs scripts/mutation/<specs>.json
// Each spec: {id, file, find, replace, all?}. Per spec: copy src/ to a temp tree, apply one textual
// mutation, run the credential suites. KILLED = a suite fails; SURVIVED = all suites still pass.
// A spec whose `find` text is absent reports FIND-MISSING and is not counted as a result.
// Preflight: the unmutated copy must pass every suite, or the run aborts (no false kills).
// Layout: <tmp>/node-sdk/{src,package.json,tsconfig.json} plus <tmp>/sdk-core/test-fixtures, because
// the suites resolve ../../../../sdk-core/test-fixtures relative to their own location.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(PKG, `.mutation-tmp-${process.pid}`);
const FIXTURES = path.resolve(PKG, "../sdk-core/test-fixtures");
const specs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const CONC = Number(process.env.CONC ?? 16);
const TESTS = [
  "src/credentials/email-proof.test.ts",
  "src/credentials/import-graph.test.ts",
  "src/credential-pending-store.test.ts",
];
const results = [];

function stage(dir, mutate) {
  const pkgCopy = path.join(dir, "node-sdk");
  fs.mkdirSync(pkgCopy, { recursive: true });
  fs.cpSync(path.join(PKG, "src"), path.join(pkgCopy, "src"), { recursive: true });
  for (const f of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(PKG, f), path.join(pkgCopy, f));
  fs.cpSync(FIXTURES, path.join(dir, "sdk-core", "test-fixtures"), { recursive: true });
  if (mutate) mutate(pkgCopy);
  return pkgCopy;
}

function runSuites(cwd) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn("bun", ["test", ...TESTS], { cwd, env: process.env });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

function summarize(out) {
  return {
    pass: /(\d+) pass/.exec(out)?.[1],
    fail: /(\d+) fail/.exec(out)?.[1],
    firstFail: (/\(fail\) (.*?)(?: \[|$)/m.exec(out)?.[1] ?? /error: (.*)/.exec(out)?.[1] ?? "").slice(0, 110),
  };
}

async function runOne(spec, idx) {
  if (!spec.file) {
    results[idx] = { id: spec.id, verdict: "BASELINE", note: "covered by preflight" };
    return;
  }
  const dir = path.join(TMP, `mut-${process.pid}-${idx}`);
  let status = "MUTATED";
  const cwd = stage(dir, (pkgCopy) => {
    if (!spec.file) return;
    const fp = path.join(pkgCopy, spec.file);
    const text = fs.readFileSync(fp, "utf8");
    if (!text.includes(spec.find)) status = "FIND-MISSING";
    else fs.writeFileSync(fp, spec.all ? text.split(spec.find).join(spec.replace) : text.replace(spec.find, () => spec.replace));
  });

  let run = { code: -1, out: "" };
  if (status === "MUTATED") run = await runSuites(cwd);
  fs.rmSync(dir, { recursive: true, force: true });

  const verdict = status !== "MUTATED" ? status : run.code === 0 ? "SURVIVED" : "KILLED";
  results[idx] = { id: spec.id, verdict, ...summarize(run.out) };
}

fs.mkdirSync(TMP, { recursive: true });

// Preflight: unmutated tree must be green, or every verdict would be a false kill.
const preDir = path.join(TMP, `pre-${process.pid}`);
const pre = await runSuites(stage(preDir, null));
const preSummary = summarize(pre.out);
fs.rmSync(preDir, { recursive: true, force: true });
if (pre.code !== 0) {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(JSON.stringify({ preflight: "UNMUTATED TREE FAILS - run aborted", ...preSummary }));
  process.exit(2);
}
console.log(JSON.stringify({ preflight: "GREEN", ...preSummary }));

let next = 0;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (next < specs.length) {
      const i = next++;
      await runOne(specs[i], i);
    }
  }),
);
fs.rmSync(TMP, { recursive: true, force: true });

for (const r of results) console.log(JSON.stringify(r));
const count = (v) => results.filter((r) => r.verdict === v).length;
console.log(
  `TOTAL ${results.length} KILLED ${count("KILLED")} SURVIVED ${count("SURVIVED")} FIND-MISSING ${count("FIND-MISSING")}`,
);
