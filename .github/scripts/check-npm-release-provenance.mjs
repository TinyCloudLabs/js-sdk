#!/usr/bin/env node
// Release provenance guard (TC-1095).
//
// The Release workflow pushes its version commit to master and then publishes
// from that commit. `changeset publish` publishes every public workspace
// version npm lacks and silently skips every version npm already has. On
// 2026-10-14 a cancelled run had published @tinycloud/mcp, cli, operations and
// courier from b6038b10 before its version commit landed. The next version
// commit (1a4993c3) gave newer code the same numbers, and the publish skipped
// them, so npm's builds lacked #528 and #530.
//
// The rule: npm's copy of name@version must be published from the commit that
// set that version in package.json (its "version commit", found on HEAD's
// first-parent history) or from a later commit on that history. A copy
// published earlier was built before the version existed on master, which is
// exactly the cancelled-run failure. The check compares commits, not files, so
// changes merged without a changeset never trip it, and bundled sources outside
// the package directory or changed dependency versions cannot slip past it.
//
// The release workflow before TC-1095 published from the version commit's
// parent, with the version bump uncommitted, then committed that same tree. A
// gitHead equal to the parent of a release-workflow version commit is accepted
// for those older versions.
//
// A stable release can push its release commit and then fail to publish some
// versions. Master is then back in pre mode with "missing stable versions":
// non-prerelease versions npm lacks, for packages npm already has or whose
// version a stable release commit set. A package npm has never seen, at a
// version an ordinary commit set, is new, and `changeset version` gives it a
// beta.
//
// Modes, run on the checked-out commit (HEAD), over every public workspace
// package:
//
//   unpublished-stable  Before a beta run versions anything: fail when there
//                       are missing stable versions. In pre mode `changeset
//                       publish` would tag them `beta`, leaving `latest`
//                       behind, and versioning could bump past them.
//   unfinished-stable [<output-file>]
//                       Before a stable run versions anything: if there are
//                       missing stable versions, find the one stable release
//                       commit that set them all and write `sha=<commit>` to
//                       <output-file> (the workflow publishes from it). Fail
//                       if no single release commit explains them.
//   pre-publish         Every version npm already has must pass the rule above.
//                       Versions npm lacks are about to be published from HEAD.
//   post-publish        Every version must now be on npm and pass the rule.
//                       Retries while the registry catches up.
//
// pre-publish and post-publish also require every exact internal dependency of
// every current version (as published on npm, or as about to be published) to
// be on npm, or in pre-publish, about to be published by this run.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const RELEASE_COMMIT = /^chore: (beta version packages|release stable packages)\b/;
const STABLE_RELEASE_COMMIT = /^chore: release stable packages\b/;
const MODES = ["unpublished-stable", "unfinished-stable", "pre-publish", "post-publish"];

function parseJson(source) {
  if (source === undefined) return undefined;
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

function lines(output) {
  return output ? output.split("\n").filter(Boolean) : [];
}

export function gitRepo(cwd = process.cwd()) {
  const run = (args) =>
    spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const ok = (args) => {
    const result = run(args);
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  return {
    revParse: (rev) => ok(["rev-parse", "--verify", `${rev}^{commit}`]),
    parent(rev) {
      const result = run(["rev-parse", "--verify", "--quiet", `${rev}^1`]);
      return result.status === 0 ? result.stdout.trim() : undefined;
    },
    subject: (rev) => ok(["log", "-1", "--format=%s", rev]),
    show(rev, path) {
      const result = run(["show", `${rev}:${path}`]);
      return result.status === 0 ? result.stdout : undefined;
    },
    files: (rev) => lines(ok(["ls-tree", "-r", "--name-only", rev])),
    // First-parent commits reachable from `rev` that changed `path`, newest first.
    history: (rev, path) => lines(ok(["log", "--first-parent", "--format=%H", rev, "--", path])),
    isAncestor(ancestor, rev) {
      if (run(["cat-file", "-e", `${ancestor}^{commit}`]).status !== 0) return false;
      const result = run(["merge-base", "--is-ancestor", ancestor, rev]);
      if (result.status === 0) return true;
      if (result.status === 1) return false;
      throw new Error(`git merge-base --is-ancestor ${ancestor} ${rev} failed: ${result.stderr.trim()}`);
    },
  };
}

// The consumer-facing requirements of a manifest: [name, range] pairs.
function requirements(manifest) {
  return ["dependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
    Object.entries(manifest?.[field] ?? {}),
  );
}

// npm view name@version -> { published: false } | { published: true, gitHead, requires }
export function npmView(name, version) {
  const fields = ["version", "gitHead", "dependencies", "peerDependencies", "optionalDependencies"];
  const result = spawnSync("npm", ["view", `${name}@${version}`, ...fields, "--json"], { encoding: "utf8" });
  const output = parseJson(result.stdout.trim() || "null");
  if (result.status === 0) {
    if (output === null) return { published: false };
    if (typeof output === "string") return { published: true, gitHead: undefined, requires: [] };
    return { published: true, gitHead: output?.gitHead || undefined, requires: requirements(output) };
  }
  if (output?.error?.code === "E404") return { published: false };
  throw new Error(`npm view ${name}@${version} failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

// npm view name -> has npm ever had this package?
export function npmPackageExists(name) {
  const result = spawnSync("npm", ["view", name, "name", "--json"], { encoding: "utf8" });
  if (result.status === 0) return true;
  if (parseJson(result.stdout.trim() || "null")?.error?.code === "E404") return false;
  throw new Error(`npm view ${name} failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

function matchesWorkspace(pattern, dir) {
  const glob = pattern.replace(/\/+$/, "");
  if (!glob.includes("*")) return glob === dir;
  const escaped = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join("[^/]+")}$`).test(dir);
}

// Workspace packages at `rev`: { name, version, dir, private, requires }.
export function workspacePackages(repo, rev) {
  const root = parseJson(repo.show(rev, "package.json")) ?? {};
  const patterns = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages ?? [];
  return repo
    .files(rev)
    .filter((path) => path.endsWith("/package.json") && !path.split("/").includes("node_modules"))
    .map((path) => path.slice(0, -"/package.json".length))
    .filter((dir) => patterns.some((pattern) => matchesWorkspace(pattern, dir)))
    .map((dir) => ({ dir, manifest: parseJson(repo.show(rev, `${dir}/package.json`)) }))
    .filter(({ manifest }) => manifest?.name)
    .map(({ dir, manifest }) => ({
      name: manifest.name,
      version: manifest.version,
      dir,
      private: manifest.private === true,
      requires: requirements(manifest),
    }));
}

// Public workspace packages at `rev`.
export function publicPackages(repo, rev) {
  return workspacePackages(repo, rev).filter((pkg) => pkg.version && !pkg.private);
}

// The exact version a dependency range pins, if it pins one. `workspace:`
// ranges resolve to the workspace's current version, as the workflow's
// resolver does before publishing.
function pinnedVersion(range, current) {
  if (range.startsWith("workspace:")) return current;
  return /^=?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/.exec(range.trim())?.[1];
}

function isPrerelease(version) {
  return version.split("+")[0].includes("-");
}

// The first-parent commit that set `dir`'s package.json to its version at `head`.
export function versionCommit(repo, head, pkg) {
  for (const commit of repo.history(head, `${pkg.dir}/package.json`)) {
    const parent = repo.parent(commit);
    const before = parent && parseJson(repo.show(parent, `${pkg.dir}/package.json`))?.version;
    if (before !== pkg.version) return commit;
  }
  return undefined;
}

// Was npm's copy (built from `gitHead`) published from this version's commit
// or a later one on HEAD's history?
export function provenance({ pkg, gitHead, head, repo }) {
  const version = versionCommit(repo, head, pkg);
  const verdict = (ok, reason) => ({ ok, reason, versionCommit: version });
  if (!gitHead) return verdict(false, "npm records no gitHead for this version");
  if (!repo.isAncestor(gitHead, head)) return verdict(false, "npm's gitHead is not in HEAD's history");
  if (!version) return verdict(false, `no commit on HEAD's first-parent history sets ${pkg.dir}/package.json to ${pkg.version}`);
  if (repo.isAncestor(version, gitHead)) {
    return verdict(true, gitHead === version ? "published from its version commit" : "published after its version commit");
  }
  if (gitHead === repo.parent(version) && RELEASE_COMMIT.test(repo.subject(version))) {
    return verdict(true, "published by the pre-TC-1095 workflow from its version commit's parent");
  }
  return verdict(false, "published from a commit before its version commit landed");
}

// Missing stable versions (see the header).
export function missingStable({ repo, head, view = npmView, packageExists = npmPackageExists }) {
  const missing = [];
  for (const pkg of publicPackages(repo, head)) {
    if (isPrerelease(pkg.version) || view(pkg.name, pkg.version).published) continue;
    const commit = versionCommit(repo, head, pkg);
    const setByStableRelease = commit !== undefined && STABLE_RELEASE_COMMIT.test(repo.subject(commit));
    if (!setByStableRelease && !packageExists(pkg.name)) continue;
    missing.push({ name: pkg.name, version: pkg.version, dir: pkg.dir, head, versionCommit: commit });
  }
  return missing;
}

// The stable release commit to finish publishing from, if any. All missing
// stable versions must come from one stable release commit outside pre mode;
// otherwise `problems` says why it cannot be finished automatically.
export function unfinishedStableRelease({ repo, view = npmView, packageExists = npmPackageExists }) {
  const head = repo.revParse("HEAD");
  const missing = missingStable({ repo, head, view, packageExists });
  const commits = [...new Set(missing.map((pkg) => pkg.versionCommit))];
  if (missing.length === 0) return { missing, problems: [] };
  const problems = [];
  const [commit] = commits;
  if (commits.length > 1 || !commit) {
    problems.push(`the missing versions were not all set by one commit (${commits.map((c) => c ?? "unknown").join(", ")})`);
  } else {
    if (!STABLE_RELEASE_COMMIT.test(repo.subject(commit))) problems.push(`${commit} is not a stable release commit`);
    if (parseJson(repo.show(commit, ".changeset/pre.json"))?.mode === "pre") problems.push(`${commit} is in pre mode`);
  }
  return { missing, problems, releaseCommit: problems.length ? undefined : commit };
}

export async function check({
  mode,
  repo,
  view = npmView,
  packageExists = npmPackageExists,
  sleep = (ms) => delay(ms),
  // npm's index can lag a successful publish by many minutes (web-sdk 3.2.5 showed up after ~17 min, TC-1155).
  // Poll with backoff (10 s doubling, capped at 2 min) within one 30-minute budget shared by every package.
  waitMs = 30 * 60_000,
  firstRetryMs = 10_000,
  maxRetryMs = 120_000,
  log = console.log,
}) {
  const head = repo.revParse("HEAD");
  if (mode === "unpublished-stable") {
    return missingStable({ repo, head, view, packageExists }).map((pkg) => ({
      ...pkg,
      reason: "stable version not on npm; in pre mode `changeset publish` would tag it beta",
    }));
  }

  const failures = [];
  const fail = (pkg, fields) =>
    failures.push({ name: pkg.name, version: pkg.version, dir: pkg.dir, head, ...fields });
  const packages = publicPackages(repo, head);
  const registry = new Map();
  const lookup = (name, version) => {
    const id = `${name}@${version}`;
    if (!registry.has(id)) registry.set(id, view(name, version));
    return registry.get(id);
  };

  let waited = 0;
  for (const pkg of packages) {
    const id = `${pkg.name}@${pkg.version}`;
    let npm = lookup(pkg.name, pkg.version);
    for (let retryMs = firstRetryMs; mode === "post-publish" && !npm.published && waited < waitMs; retryMs *= 2) {
      const wait = Math.min(retryMs, maxRetryMs, waitMs - waited);
      log(`${id} is not on npm yet; retrying in ${Math.round(wait / 1000)}s (${Math.round(waited / 1000)}s of ${waitMs / 1000}s waited).`);
      await sleep(wait);
      waited += wait;
      npm = view(pkg.name, pkg.version);
      registry.set(id, npm);
    }
    if (!npm.published) {
      if (mode === "pre-publish") log(`${id}: not on npm; will publish from HEAD.`);
      else fail(pkg, { reason: "not on npm after publish" });
      continue;
    }

    const verdict = provenance({ pkg, gitHead: npm.gitHead, head, repo });
    if (verdict.ok) log(`${id}: ${verdict.reason} (gitHead ${npm.gitHead}).`);
    else fail(pkg, { gitHead: npm.gitHead, versionCommit: verdict.versionCommit, reason: verdict.reason });
  }

  // Every exact internal dependency must resolve on npm (or, before
  // publishing, be one of the versions this run publishes).
  const workspace = new Map(workspacePackages(repo, head).map((pkg) => [pkg.name, pkg]));
  for (const pkg of packages) {
    const npm = registry.get(`${pkg.name}@${pkg.version}`);
    for (const [name, range] of npm.published ? npm.requires ?? [] : pkg.requires) {
      const dependency = workspace.get(name);
      const version = dependency && pinnedVersion(range, dependency.version);
      if (!version || lookup(name, version).published) continue;
      const publishing = mode === "pre-publish" && !dependency.private && dependency.version === version;
      if (publishing) continue;
      const where = mode === "pre-publish" ? "not on npm and not published by this run" : "not on npm";
      fail(pkg, { reason: `requires ${name}@${version}, which is ${where}` });
    }
  }
  return failures;
}

const ADVICE = {
  "unpublished-stable":
    "Master carries stable versions npm does not have: a stable release pushed its release commit but did not finish\n" +
    "publishing. A beta run would tag them `beta` and leave `latest` behind, so nothing was versioned or published.\n" +
    "Dispatch the Stable Release: it publishes exactly these versions from their release commit and graduates nothing\n" +
    "else in that run. The next push to master then resumes betas.",
  "unfinished-stable":
    "These stable versions are missing from npm, but cannot be finished automatically. A maintainer must check out\n" +
    "the commit that set each version, build it, and run `changeset publish` there (no .changeset/pre.json, so the\n" +
    "versions go to `latest`). Then dispatch the Stable Release again.",
  "pre-publish":
    "npm already has these versions, published before the commit that set them, so `changeset publish` would skip them.\n" +
    "Nothing was published. Add a changeset for each package so the next run bumps it past the stale version.",
  "post-publish":
    "Publishing finished, but npm does not show these versions as published from their version commit or later.\n" +
    "Check the publish log and `npm view <name>@<version> gitHead`.",
};

export function failureMessage(failures, mode, problems = []) {
  const missingOnly = mode === "unpublished-stable" || mode === "unfinished-stable";
  const lines = failures.map((failure) =>
    [
      `  ${failure.name}@${failure.version}: ${failure.reason}`,
      ...(missingOnly ? [] : [`    npm gitHead:    ${failure.gitHead ?? "(none)"}`]),
      `    version commit: ${failure.versionCommit ?? "(unknown)"}`,
      `    HEAD:           ${failure.head}`,
    ].join("\n"),
  );
  const why = problems.length ? `\nWhy: ${problems.join("; ")}.\n` : "";
  return `Release provenance check failed (${mode}):\n\n${lines.join("\n")}\n${why}\n${ADVICE[mode]}`;
}

function report(failures, mode, problems) {
  if (failures.length === 0) return;
  if (process.env.GITHUB_ACTIONS === "true") {
    for (const failure of failures) {
      console.log(
        `::error title=${mode}: ${failure.name}@${failure.version}::${failure.reason} ` +
          `(npm gitHead ${failure.gitHead ?? "none"}, HEAD ${failure.head})`,
      );
    }
  }
  console.error(failureMessage(failures, mode, problems));
  process.exitCode = 1;
}

async function main([mode, output, ...rest]) {
  const repo = gitRepo();
  if (mode === "unfinished-stable" && rest.length === 0) {
    const { missing, problems, releaseCommit } = unfinishedStableRelease({ repo });
    if (missing.length === 0) return console.log("No stable versions are missing from npm.");
    if (!releaseCommit) {
      const reason = "stable version not on npm";
      return report(missing.map((pkg) => ({ ...pkg, reason })), mode, problems);
    }
    for (const pkg of missing) console.log(`${pkg.name}@${pkg.version} is missing from npm; set by ${releaseCommit}.`);
    console.log(`Finishing the stable release ${releaseCommit}; nothing new is versioned in this run.`);
    if (output) appendFileSync(output, `sha=${releaseCommit}\n`);
    return;
  }
  if (MODES.includes(mode) && output === undefined) return report(await check({ mode, repo }), mode);
  console.error(`usage: check-npm-release-provenance.mjs ${MODES.join("|")} (unfinished-stable takes an optional <output-file>)`);
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
