#!/usr/bin/env node
// Staging route for approved Courier stable releases, driven by sealed plans.
//
// A plan (courier-stable-stage-plans.json, reviewed with this script) names an exact, already pushed version commit
// (`releaseSha`) on a reviewed source (`sourceSha`: the base itself, or a reviewed backport on it): the approved
// base, the exact list of paths changed from base to release, the packages allowed to change
// and their stable versions, and the exact external pins. The route builds that commit, packs the plan's packages and
// publishes the tarballs under the npm dist-tag `staging` only (never `latest`). The workflow input only picks a plan
// id; it never selects code, packages, versions or tags. A plan whose releaseSha or expectedDelta is null is refused.
//
// The version commit is made ahead of time with `prepare` (deterministic: fixed identity and dates, sole parent = sourceSha),
// reviewed, and pushed to a release ref; because it is the commit npm stamps as `gitHead`, the staged tarballs'
// lineage resolves to a real commit on that ref.
//
// usage: courier-stable-stage.mjs <command> ...   (the plan id comes from $PLAN)
//   prepare                           (cwd = clean checkout of the plan's sourceSha) edit the manifests and commit
//                                     deterministically, after the caller has settled bun.lock; prints the sha
//   release-sha                       print the plan's releaseSha (the workflow checks out exactly this)
//   build-filters                     the turbo --filter arguments for the plan, one per line
//   plan-flags                        GITHUB_OUTPUT lines for plan-dependent steps (node_release_check)
//   verify-route                      dispatch on master at a master commit; the plan is sealed
//   guard-route                       verify-route, and the release commit is the plan's (delta, manifests)
//   pack <out-dir>                    npm pack the plan's packages, write manifest.json
//   verify-tarballs <dir> [sha256]    re-check every tarball against the plan (no token needed)
//   publish <dir>                     verify, then publish in dependency order with --tag staging

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { dependencyLayers, waitForTarballs, withWaitBudget } from "./publish-in-dependency-order.mjs";
import { checkExports } from "./check-package-exports-exist.mjs";
import { gitRepo, npmDistTags } from "./check-npm-release-provenance.mjs";

export const ROUTE_REF = "refs/heads/master";
export const POLICY_FILE = new URL("./courier-stable-stage-plans.json", import.meta.url);
const WAIT_BUDGET_MS = 45 * 60_000;

const RUNTIME_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];
const DEP_FIELDS = [...RUNTIME_FIELDS, "devDependencies"];
const LIFECYCLE = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare", "prepublishOnly", "prepack", "postpack", "publish", "postpublish"];
const EXACT_STABLE = /^\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;
// Files a consumer needs; a missing one means the build did not run.
const REQUIRED_FILES = {
  "@tinycloud/node-sdk-wasm": ["dist/index.js", "dist/index.cjs", "dist/wasm/tinycloud_web_sdk_rs_bg.wasm", "dist/wasm/index.cjs"],
  "@tinycloud/courier": ["dist/cli.js", "dist/index.js"],
  "@tinycloud/cli": ["bin/tinycloud", "dist/index.js"],
};

// What a package's tarball must ship: the plan's own list when it has one, else the table, else dist/index.js.
export const requiredFiles = (pkg) => pkg.requiredFiles ?? REQUIRED_FILES[pkg.name] ?? ["dist/index.js"];

// Which plan-dependent workflow steps apply. The node release pin check is the CLI's own.
export const planFlags = (plan) => ({ nodeReleaseCheck: plan.byName.has("@tinycloud/cli") });

const fail = (message) => {
  throw new Error(message);
};

// ---- plans -------------------------------------------------------------------------------------------------------

// The sealed plan `id` from the policy, with its lookups. Throws for an unknown id or a malformed plan.
export function loadPlan(id, policy = JSON.parse(readFileSync(POLICY_FILE, "utf8"))) {
  if (typeof id !== "string" || !Object.hasOwn(policy.plans, id)) fail(`unknown plan "${id}"; known: ${Object.keys(policy.plans).join(", ")}`);
  const plan = { ...policy.plans[id], id, tag: policy.tag, sharePair: policy.sharePair, devOnly: new Set(policy.devOnly) };
  if (plan.tag !== "staging") fail(`policy tag is "${plan.tag}", not staging`);
  for (const pkg of plan.packages) {
    if (!EXACT_STABLE.test(pkg.stable) || !pkg.from || !pkg.dir.startsWith("packages/")) fail(`plan ${id}: malformed package ${JSON.stringify(pkg)}`);
    const files = pkg.requiredFiles;
    if (files !== undefined && (!Array.isArray(files) || files.length === 0 || !files.every((file) => typeof file === "string" && /^(?!.*(^|\/)\.\.?(\/|$))[\w@.+-]+(\/[\w@.+-]+)*$/.test(file)))) {
      fail(`plan ${id}: ${pkg.name} requiredFiles must be a non-empty list of safe relative paths`);
    }
  }
  plan.byName = new Map(plan.packages.map((pkg) => [pkg.name, pkg]));
  plan.pinByName = new Map(plan.pins.map((pin) => [pin.name, pin]));
  // Every @tinycloud/* runtime dependency must be exactly one of these.
  plan.allowedRuntime = new Map([
    ...Object.entries(plan.sharePair),
    ...plan.pins.map((pin) => [pin.name, pin.to]),
    ...plan.packages.map((pkg) => [pkg.name, pkg.stable]),
  ]);
  return plan;
}

// A plan can run only when its release commit and the exact changed-path list are sealed.
export function sealProblems(plan) {
  const problems = [];
  if (!SHA.test(plan.base ?? "")) problems.push(`plan ${plan.id}: base ${plan.base} is not a commit sha`);
  if (!SHA.test(plan.sourceSha ?? "")) problems.push(`plan ${plan.id}: sourceSha ${plan.sourceSha} is not a commit sha`);
  if (!SHA.test(plan.releaseSha ?? "")) problems.push(`plan ${plan.id} is not sealed: releaseSha is ${plan.releaseSha}`);
  if (!Array.isArray(plan.expectedDelta)) problems.push(`plan ${plan.id} is not sealed: expectedDelta (the exact paths changed from base to releaseSha) is missing`);
  return problems;
}

// ---- route guard -------------------------------------------------------------------------------------------------

// Provenance of the route itself: only a dispatch on master, at a commit master contains, with a sealed plan.
export function guardRouteHead({ env, repo, masterTip, plan }) {
  const problems = sealProblems(plan);
  if (problems.length) return problems;
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch") problems.push(`event is ${env.GITHUB_EVENT_NAME}, not workflow_dispatch`);
  if (env.GITHUB_REF !== ROUTE_REF) problems.push(`ref is ${env.GITHUB_REF}, not ${ROUTE_REF}`);
  const head = repo.revParse("HEAD");
  if (!env.GITHUB_SHA || head !== env.GITHUB_SHA) problems.push(`checkout ${head} is not the dispatched commit ${env.GITHUB_SHA}`);
  if (!repo.isAncestor(head, masterTip)) problems.push(`route commit ${head} is not on master`);
  return problems;
}

// The route head plus the release commit: present, a descendant of the plan's base with exactly the sealed delta,
// and its manifests exactly the version-only edit of the base's.
export function guardRoute({ env, repo, masterTip, plan, git }) {
  const problems = guardRouteHead({ env, repo, masterTip, plan });
  if (sealProblems(plan).length) return problems;
  if (!repo.isAncestor(plan.releaseSha, plan.releaseSha)) return [...problems, `release commit ${plan.releaseSha} is not available in the checkout`];
  if (repo.revParse(plan.releaseSha) !== plan.releaseSha) problems.push("releaseSha does not resolve to itself");
  return [...problems, ...verifyReleaseCommit({ git, repo, plan })];
}

// ---- version-only edit -------------------------------------------------------------------------------------------

// The stable manifest for `pkg`, or throws. Changes the version and any dependency spec that is exactly the `from`
// version of a package in the plan or of a plan pin; any other spec is left alone and judged by runtimePinProblems.
export function stabilizeManifest(manifest, pkg, plan) {
  if (manifest.name !== pkg.name || manifest.version !== pkg.from) fail(`${pkg.dir}: expected ${pkg.name}@${pkg.from}, found ${manifest.name}@${manifest.version}`);
  const next = { ...manifest, version: pkg.stable };
  for (const field of DEP_FIELDS) {
    if (!manifest[field]) continue;
    next[field] = { ...manifest[field] };
    for (const [dep, spec] of Object.entries(manifest[field])) {
      const target = plan.byName.get(dep) ?? plan.pinByName.get(dep);
      if (!target) continue;
      const [from, to] = "stable" in target ? [target.from, target.stable] : [target.from, target.to];
      if (spec !== from) fail(`${pkg.name} ${field} "${dep}": "${spec}" is not the source version ${from}`);
      next[field][dep] = to;
    }
  }
  return next;
}

// Runtime closure rule: every @tinycloud/* runtime dependency is an exact stable pin the plan allows (a package it
// stages, a pin it rewrites, the share pair); nothing prerelease. Returns problems.
export function runtimePinProblems(manifest, plan) {
  const problems = [];
  if (!EXACT_STABLE.test(manifest.version ?? "")) problems.push(`${manifest.name}: version ${manifest.version} is not a stable x.y.z`);
  for (const field of RUNTIME_FIELDS) {
    for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
      if (!dep.startsWith("@tinycloud/")) {
        if (/^(workspace|file|link|git|github|https?):/.test(spec)) problems.push(`${manifest.name} ${field} "${dep}": non-registry spec "${spec}"`);
        continue;
      }
      const want = plan.allowedRuntime.get(dep);
      if (want === undefined) problems.push(`${manifest.name} ${field} "${dep}": not allowed by plan ${plan.id}`);
      else if (spec !== want) problems.push(`${manifest.name} ${field} "${dep}": "${spec}", expected exactly "${want}"`);
    }
  }
  for (const dep of Object.keys(manifest.devDependencies ?? {})) {
    if (dep.startsWith("@tinycloud/") && !plan.allowedRuntime.has(dep) && !plan.devOnly.has(dep)) problems.push(`${manifest.name} devDependencies "${dep}": unexpected`);
  }
  for (const script of LIFECYCLE) if (manifest.scripts?.[script] !== undefined) problems.push(`${manifest.name}: has lifecycle script "${script}"`);
  return problems;
}

function changedLines(before, after) {
  // One JSON line per changed leaf: the version plus each rewritten dependency spec.
  let count = before.version !== after.version ? 1 : 0;
  for (const field of DEP_FIELDS) for (const dep of Object.keys(before[field] ?? {})) if (before[field][dep] !== after[field][dep]) count += 1;
  return count;
}

// Release-commit provenance: the plan's `releaseSha` is a single commit directly on the plan's `sourceSha` (the
// reviewed source: the base itself, or a reviewed backport on it) that changes nothing but the plan's package manifests
// and bun.lock; `sourceSha` descends from `base`; the whole base..release delta is exactly `expectedDelta`; and each
// package manifest is the version-only edit of the source's (one changed line each), with runtime pins locked.
export function verifyReleaseCommit({ git, repo, plan, head = plan.releaseSha }) {
  const problems = [];
  const { base, sourceSha } = plan;
  if (!repo.isAncestor(base, sourceSha)) return [`base ${base} is not an ancestor of source ${sourceSha}`];
  if (!repo.isAncestor(sourceSha, head)) return [`source ${sourceSha} is not an ancestor of ${head}`];
  const parents = git(["rev-list", "--parents", "-n", "1", head]).trim().split(" ").slice(1);
  if (parents.length !== 1 || parents[0] !== sourceSha) problems.push(`${head}'s parents are [${parents}], not exactly the source ${sourceSha}`);
  const names = (from) => git(["diff", "--name-only", "--no-renames", from, head]).split("\n").filter(Boolean).sort();
  const actual = names(base);
  const expected = [...plan.expectedDelta].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`delta ${base}..${head} is [${actual}], the plan expects exactly [${expected}]`);
  const allowed = new Set(["bun.lock", ...plan.packages.map((pkg) => `${pkg.dir}/package.json`)]);
  const stray = names(sourceSha).filter((path) => !allowed.has(path));
  if (stray.length) problems.push(`${head} changes paths other than package manifests and bun.lock: [${stray}]`);
  for (const pkg of plan.packages) {
    const file = `${pkg.dir}/package.json`;
    const before = JSON.parse(git(["show", `${sourceSha}:${file}`]));
    const after = JSON.parse(git(["show", `${head}:${file}`]));
    let wanted;
    try {
      wanted = stabilizeManifest(before, pkg, plan);
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    if (JSON.stringify(wanted) !== JSON.stringify(after)) problems.push(`${file}: not exactly the version-only edit of the source manifest`);
    const [added, deleted] = git(["diff", "--numstat", "--no-renames", sourceSha, head, "--", file]).trim().split(/\s+/);
    const lines = changedLines(before, wanted);
    if (Number(added) !== lines || Number(deleted) !== lines) problems.push(`${file}: ${added}+/${deleted}- lines changed, expected ${lines}`);
    problems.push(...runtimePinProblems(after, plan));
  }
  return problems;
}

// ---- tarballs ----------------------------------------------------------------------------------------------------

const sha = (algo, data, enc = "hex") => createHash(algo).update(data).digest(enc);
const tgzName = (pkg) => `${pkg.name.slice(1).replace("/", "-")}-${pkg.stable}.tgz`;

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, ...options });
  if (result.status !== 0) fail(`${cmd} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout;
}

// Problems with one tarball: path safety, manifest identity, runtime pins, lineage, required files.
export function tarballProblems({ pkg, entries, manifest, plan }) {
  const problems = [];
  for (const { path, type } of entries) {
    if (!path.startsWith("package/") || path.split("/").includes("..") || path.startsWith("/")) problems.push(`${pkg.name}: unsafe path ${path}`);
    if (type !== "-" && type !== "d") problems.push(`${pkg.name}: ${path} is not a regular file`);
  }
  if (manifest.name !== pkg.name) problems.push(`${pkg.name}: tarball is ${manifest.name}`);
  if (manifest.version !== pkg.stable) problems.push(`${pkg.name}: tarball version ${manifest.version}, expected ${pkg.stable}`);
  problems.push(...runtimePinProblems(manifest, plan));
  for (const key of Object.keys(manifest.publishConfig ?? {})) {
    if (!["access", "provenance"].includes(key)) problems.push(`${pkg.name}: publishConfig.${key} could redirect the publish`);
  }
  for (const file of requiredFiles(pkg)) {
    if (!entries.some((entry) => entry.path === `package/${file}`)) problems.push(`${pkg.name}: tarball lacks ${file}`);
  }
  return problems;
}

function inspectTarball(file) {
  const entries = run("tar", ["-tvzf", file]).split("\n").filter(Boolean).map((line) => {
    const match = /^(\S)\S*\s+\S+\s+\d+\s+\S+\s+\S+\s+(.*)$/.exec(line);
    return { type: match?.[1] ?? "?", path: (match?.[2] ?? line).replace(/ -> .*$/, "") };
  });
  const manifest = JSON.parse(run("tar", ["-xOzf", file, "package/package.json"]));
  return { entries, manifest };
}

function digest(file) {
  const data = readFileSync(file);
  return { sha256: sha("sha256", data), integrity: `sha512-${sha("sha512", data, "base64")}` };
}

// Pack the plan's packages from the release commit checked out in `cwd`.
function packAll(plan, outDir, cwd = process.cwd()) {
  mkdirSync(outDir, { recursive: true });
  const head = run("git", ["rev-parse", "HEAD"], { cwd }).trim();
  if (head !== plan.releaseSha) fail(`checkout ${head} is not the release commit ${plan.releaseSha}`);
  const record = plan.packages.map((pkg) => {
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", outDir], { cwd: join(cwd, pkg.dir) });
    return { name: pkg.name, version: pkg.stable, file: tgzName(pkg), ...digest(join(outDir, tgzName(pkg))) };
  });
  const manifest = { plan: plan.id, release: plan.releaseSha, route: process.env.GITHUB_SHA ?? null, tag: plan.tag, packages: record };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// Re-derive everything from the plan; the manifest only supplies digests, which must match the files.
export function verifyTarballs(plan, dir, expectedManifestSha256) {
  const problems = [];
  const manifestRaw = readFileSync(join(dir, "manifest.json"));
  if (expectedManifestSha256 && sha("sha256", manifestRaw) !== expectedManifestSha256) problems.push("manifest.json does not match the build job's digest");
  const manifest = JSON.parse(manifestRaw);
  if (manifest.plan !== plan.id) problems.push(`manifest plan ${manifest.plan} is not ${plan.id}`);
  if (manifest.release !== plan.releaseSha) problems.push(`manifest release ${manifest.release} is not ${plan.releaseSha}`);
  if (manifest.tag !== plan.tag) problems.push(`manifest tag ${manifest.tag} is not ${plan.tag}`);
  const files = readdirSync(dir).filter((name) => name !== "manifest.json").sort();
  const expected = plan.packages.map(tgzName).sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) problems.push(`artifact files [${files}] are not exactly [${expected}]`);
  if (manifest.packages?.length !== plan.packages.length) problems.push(`manifest does not list exactly the ${plan.packages.length} packages`);
  for (const pkg of plan.packages) {
    const file = join(dir, tgzName(pkg));
    const recorded = manifest.packages?.find((entry) => entry.name === pkg.name);
    try {
      const actual = digest(file);
      if (!recorded || recorded.version !== pkg.stable || recorded.file !== tgzName(pkg) || recorded.integrity !== actual.integrity || recorded.sha256 !== actual.sha256) problems.push(`${pkg.name}: digest differs from manifest`);
      problems.push(...tarballProblems({ pkg, plan, ...inspectTarball(file) }));
    } catch (error) {
      problems.push(`${pkg.name}: ${error.message}`);
    }
  }
  if (problems.length === 0) {
    // Every exports target the tarball declares must be a shipped, non-empty file; checked on the extracted package.
    for (const pkg of plan.packages) {
      const scratch = mkdtempSync(join(tmpdir(), "stage-"));
      try {
        run("tar", ["-xzf", join(dir, tgzName(pkg)), "-C", scratch]);
        const root = join(scratch, "package");
        const declared = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        if (declared.exports !== undefined) problems.push(...checkExports(root).problems.map((problem) => `${pkg.name}: ${problem}`));
        const bins = typeof declared.bin === "string" ? [declared.bin] : Object.values(declared.bin ?? {});
        for (const target of [declared.main, ...bins].filter(Boolean)) {
          if (!existsSync(join(root, target))) problems.push(`${pkg.name}: ${target} is missing from the tarball`);
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
  return { manifest, problems };
}

// ---- publish -----------------------------------------------------------------------------------------------------

// npm's integrity for name@version, or undefined if npm does not have it.
function npmIntegrity(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "dist.integrity", "--json"], { encoding: "utf8" });
  if (result.status === 0) return JSON.parse(result.stdout.trim() || "null") ?? undefined;
  if (/E404/.test(result.stdout + result.stderr)) return undefined;
  return fail(`npm view ${name}@${version} failed: ${(result.stderr || result.stdout).trim()}`);
}

function npmRuntimeDeps(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "dependencies", "--json"], { encoding: "utf8" });
  if (result.status !== 0) fail(`npm has no ${name}@${version}: ${(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout.trim() || "{}");
}

// Layers over the plan's packages only, from the tarballs' own manifests.
export function publishLayers(manifests) {
  return dependencyLayers(manifests.map((manifest) => ({
    name: manifest.name,
    requires: DEP_FIELDS.flatMap((field) => Object.entries(manifest[field] ?? {})),
  })));
}

// The repo commits one root .npmrc: the default registry, no auth. That exact content (one optional trailing newline) is
// the only npm config the publish accepts, and the file must still be the release commit's blob. Any other root
// .npmrc, or any .npmrc in a package directory, could redirect the registry or carry auth.
export const ROOT_NPMRC = "registry=https://registry.npmjs.org/";

export function npmrcProblems(cwd, dir, { read = (path) => readFileSync(path, "utf8"), headBlob = (path) => run("git", ["show", `HEAD:${path}`], { cwd }) } = {}) {
  const problems = [];
  if (existsSync(join(dir, ".npmrc"))) problems.push(`${join(dir, ".npmrc")} would change npm's registry or auth`);
  const root = join(cwd, ".npmrc");
  if (existsSync(root)) {
    const text = read(root);
    if (text !== ROOT_NPMRC && text !== `${ROOT_NPMRC}\n`) problems.push(`${root} is not exactly "${ROOT_NPMRC}"`);
    else {
      let committed;
      try {
        committed = headBlob(".npmrc");
      } catch {
        committed = undefined;
      }
      if (committed !== text) problems.push(`${root} is not the release commit's committed file`);
    }
  }
  return problems;
}

// Publish from the package directory of the release commit's checkout, not from the tarball: only a directory publish
// makes npm record `gitHead` (the checkout's HEAD) in the registry. The directory gets the verified tarball's files,
// is re-packed, and must re-pack to exactly the verified bytes before anything is published.
function publishPackage({ pkg, tarball, integrity, tag }, cwd = process.cwd()) {
  const dir = join(cwd, pkg.dir);
  const npmrc = npmrcProblems(cwd, dir);
  if (npmrc.length) fail(`refusing: ${npmrc.join("; ")}`);
  run("tar", ["-xzf", tarball, "--strip-components=1", "-C", dir]);
  // The extraction must not have dropped npm config into the package directory either.
  const after = npmrcProblems(cwd, dir);
  if (after.length) fail(`refusing: ${after.join("; ")}`);
  const scratch = mkdtempSync(join(tmpdir(), "stage-repack-"));
  try {
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", scratch], { cwd: dir });
    const repacked = digest(join(scratch, tgzName(pkg))).integrity;
    if (repacked !== integrity) fail(`${pkg.name}: ${pkg.dir} re-packs to ${repacked}, not the verified ${integrity}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // The tag is the policy's constant and the directory is the sealed release commit's: nothing here comes from the caller.
  const status = spawnSync("npm", ["publish", dir, "--tag", tag, "--access", "public", "--ignore-scripts"], { stdio: "inherit" }).status;
  return status;
}

// npm's recorded gitHead for name@version.
function npmGitHead(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "gitHead", "--json"], { encoding: "utf8" });
  return result.status === 0 ? JSON.parse(result.stdout.trim() || "null") ?? undefined : undefined;
}

// The registry and publisher seams; tests replace them.
const npmIo = {
  integrity: npmIntegrity,
  runtimeDeps: npmRuntimeDeps,
  distTags: npmDistTags,
  gitHead: npmGitHead,
  head: () => run("git", ["rev-parse", "HEAD"]).trim(),
  publishPackage,
  waitServed: withWaitBudget(WAIT_BUDGET_MS, (ids, options) => waitForTarballs(ids, options)),
};

export async function publish(plan, dir, { io = npmIo, manifestSha256, log = console.log } = {}) {
  const { manifest, problems } = verifyTarballs(plan, dir, manifestSha256);
  if (problems.length) fail(`refusing to publish:\n- ${problems.join("\n- ")}`);
  // gitHead is read from the checkout, so the checkout must be exactly the sealed release commit.
  if (io.head() !== plan.releaseSha) fail(`checkout ${io.head()} is not the release commit ${plan.releaseSha}`);
  // What the plan relies on being on npm already must be there, with stable runtime dependencies only (no nested beta):
  // the share pair, and every pin a backport points at.
  const relied = [...Object.entries(plan.sharePair), ...plan.pins.map((pin) => [pin.name, pin.to])];
  for (const [name, version] of relied) {
    if (io.integrity(name, version) === undefined) fail(`${name}@${version} is not on npm`);
    for (const [dep, spec] of Object.entries(io.runtimeDeps(name, version))) if (dep.startsWith("@tinycloud/") && /-/.test(spec)) fail(`${name}@${version} requires prerelease ${dep}@${spec}`);
  }
  const latestBefore = Object.fromEntries(plan.packages.map((pkg) => [pkg.name, io.distTags(pkg.name).latest ?? null]));
  const todo = new Set();
  for (const pkg of plan.packages) {
    const recorded = manifest.packages.find((entry) => entry.name === pkg.name);
    const onNpm = io.integrity(pkg.name, pkg.stable);
    if (onNpm === undefined) todo.add(pkg.name);
    else if (onNpm === recorded.integrity) log(`${pkg.name}@${pkg.stable} is already on npm with these exact bytes; skipping`);
    else fail(`${pkg.name}@${pkg.stable} is already on npm with different bytes (${onNpm}); refusing to continue`);
  }
  const tarballManifests = plan.packages.map((pkg) => inspectTarball(join(dir, tgzName(pkg))).manifest);
  for (const [index, layer] of publishLayers(tarballManifests).entries()) {
    log(`Publishing layer ${index + 1}: ${layer.map((pkg) => pkg.name).join(", ")}`);
    const ids = [];
    for (const { name } of layer) {
      if (!todo.has(name)) continue;
      const pkg = plan.byName.get(name);
      const recorded = manifest.packages.find((entry) => entry.name === name);
      const status = io.publishPackage({ pkg, tarball: join(dir, tgzName(pkg)), integrity: recorded.integrity, tag: plan.tag });
      if (status !== 0) fail(`npm publish ${name}@${pkg.stable} failed (${status}); later layers were not published`);
      ids.push(`${name}@${pkg.stable}`);
    }
    // Every tarball of a layer must be served before a package that requires it goes out.
    const { missing } = ids.length ? await io.waitServed(ids) : { missing: [] };
    if (missing.length) fail(`npm does not serve ${missing.map((m) => m.id).join(", ")}; later layers were not published`);
    // Lineage: npm's recorded gitHead is the sealed release commit (no stray or invented metadata).
    for (const id of ids) {
      const at = id.lastIndexOf("@");
      const recordedHead = io.gitHead(id.slice(0, at), id.slice(at + 1));
      if (recordedHead !== plan.releaseSha) fail(`${id}: npm's gitHead is ${recordedHead}, not the release commit ${plan.releaseSha}`);
    }
  }
  for (const pkg of plan.packages) {
    const now = io.distTags(pkg.name);
    if ((now.latest ?? null) !== latestBefore[pkg.name]) fail(`${pkg.name} latest moved from ${latestBefore[pkg.name]} to ${now.latest}`);
    log(`${pkg.name}: ${plan.tag}=${now[plan.tag] ?? "(not shown yet)"} latest=${now.latest ?? "(none)"}`);
  }
}

// ---- cli ---------------------------------------------------------------------------------------------------------

function git(args, cwd = process.cwd(), env = process.env) {
  return run("git", args, { cwd, env });
}

// The turbo filters that build the plan's packages and what they build from, minus the plan's exclusions.
export function buildFilters(plan) {
  return [...plan.packages.map((pkg) => `--filter=${pkg.name}...`), ...(plan.buildExclude ?? []).map((name) => `--filter=!${name}`)];
}

// Local, before review: edit the plan's manifests in a clean checkout of the base, then commit with a fixed identity,
// message and the base's date, so the same tree always yields the same commit. bun.lock is settled by the caller
// between the edit and the commit (see the two phases below).
function prepare(plan, phase) {
  if (git(["rev-parse", "HEAD"]).trim() !== plan.sourceSha) fail(`checkout is not the source ${plan.sourceSha}`);
  if (phase === "edit") {
    if (git(["status", "--porcelain"]).trim()) fail("base checkout is not clean");
    for (const pkg of plan.packages) {
      const file = join(pkg.dir, "package.json");
      writeFileSync(file, `${JSON.stringify(stabilizeManifest(JSON.parse(readFileSync(file, "utf8")), pkg, plan), null, 2)}\n`);
    }
  } else if (phase === "commit") {
    const date = git(["log", "-1", "--format=%cI", plan.sourceSha]).trim();
    const email = "41898282+github-actions[bot]@users.noreply.github.com";
    const env = { ...process.env, GIT_AUTHOR_NAME: "github-actions[bot]", GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: "github-actions[bot]", GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: date };
    git(["add", "-A"], process.cwd(), env);
    git(["commit", "-q", "-m", `chore: ${plan.id} version packages [skip ci]`], process.cwd(), env);
    console.log(git(["rev-parse", "HEAD"]).trim());
  } else fail("usage: prepare edit|commit");
}

async function main([command, ...args]) {
  const plan = loadPlan(process.env.PLAN);
  const gitOut = (a) => git(a);
  if (command === "prepare") {
    prepare(plan, args[0]);
  } else if (command === "release-sha") {
    const problems = sealProblems(plan);
    if (problems.length) fail(problems.join("\n"));
    console.log(plan.releaseSha);
  } else if (command === "build-filters") {
    console.log(buildFilters(plan).join("\n"));
  } else if (command === "plan-flags") {
    console.log(`node_release_check=${planFlags(plan).nodeReleaseCheck}`);
  } else if (command === "verify-route" || command === "guard-route") {
    const common = { env: process.env, repo: gitRepo(), masterTip: git(["rev-parse", "refs/remotes/origin/master"]).trim(), plan, git: gitOut };
    const problems = command === "verify-route" ? guardRouteHead(common) : guardRoute(common);
    if (problems.length) fail(`route guard failed:\n- ${problems.join("\n- ")}`);
    console.log(`plan ${plan.id}: route ${process.env.GITHUB_SHA} is on master; release commit ${plan.releaseSha}`);
  } else if (command === "pack") {
    for (const entry of packAll(plan, args[0]).packages) console.log(`${entry.file} ${entry.integrity}`);
  } else if (command === "verify-tarballs") {
    const { problems } = verifyTarballs(plan, args[0], args[1]);
    if (problems.length) fail(`tarballs rejected:\n- ${problems.join("\n- ")}`);
    console.log("tarballs match the plan");
  } else if (command === "publish") {
    await publish(plan, args[0], { manifestSha256: process.env.MANIFEST_SHA256 });
  } else {
    fail("usage: courier-stable-stage.mjs prepare|release-sha|build-filters|plan-flags|verify-route|guard-route|pack|verify-tarballs|publish");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error title=Courier stable staging::${error.message}`);
    process.exitCode = 1;
  }
}
