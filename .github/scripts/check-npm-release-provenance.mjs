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
// Modes, run on the checked-out commit (HEAD), over every public workspace
// package:
//
//   unpublished-stable  Before a beta run versions anything: fail when a
//                       non-prerelease version is missing from npm. In pre mode
//                       `changeset publish` would publish it under the `beta`
//                       dist-tag, leaving `latest` behind. This is what a stable
//                       release that pushed but did not finish publishing
//                       leaves behind.
//   pre-publish         Every version npm already has must pass the rule above.
//                       Versions npm lacks are about to be published from HEAD.
//   post-publish        Every version must now be on npm and pass the rule.
//                       Retries while the registry catches up.

import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const RELEASE_COMMIT = /^chore: (beta version packages|release stable packages)\b/;
const MODES = ["unpublished-stable", "pre-publish", "post-publish"];

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

// npm view name@version -> { published: false } | { published: true, gitHead }
export function npmView(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "gitHead", "--json"], {
    encoding: "utf8",
  });
  const output = parseJson(result.stdout.trim() || "null");
  if (result.status === 0) {
    if (output === null) return { published: false };
    if (typeof output === "string") return { published: true, gitHead: undefined };
    return { published: true, gitHead: output?.gitHead || undefined };
  }
  if (output?.error?.code === "E404") return { published: false };
  throw new Error(`npm view ${name}@${version} failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

function matchesWorkspace(pattern, dir) {
  const glob = pattern.replace(/\/+$/, "");
  if (!glob.includes("*")) return glob === dir;
  const escaped = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join("[^/]+")}$`).test(dir);
}

// Public workspace packages at `rev`: { name, version, dir }.
export function publicPackages(repo, rev) {
  const root = parseJson(repo.show(rev, "package.json")) ?? {};
  const patterns = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages ?? [];
  return repo
    .files(rev)
    .filter((path) => path.endsWith("/package.json") && !path.split("/").includes("node_modules"))
    .map((path) => path.slice(0, -"/package.json".length))
    .filter((dir) => patterns.some((pattern) => matchesWorkspace(pattern, dir)))
    .map((dir) => ({ dir, manifest: parseJson(repo.show(rev, `${dir}/package.json`)) }))
    .filter(({ manifest }) => manifest?.name && manifest.version && manifest.private !== true)
    .map(({ dir, manifest }) => ({ name: manifest.name, version: manifest.version, dir }));
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

export async function check({
  mode,
  repo,
  view = npmView,
  sleep = (ms) => delay(ms),
  attempts = 6,
  retryMs = 10_000,
  log = console.log,
}) {
  const head = repo.revParse("HEAD");
  const failures = [];
  const fail = (pkg, fields) => failures.push({ ...pkg, head, ...fields });

  for (const pkg of publicPackages(repo, head)) {
    const id = `${pkg.name}@${pkg.version}`;
    let npm = view(pkg.name, pkg.version);

    if (mode === "unpublished-stable") {
      if (npm.published || isPrerelease(pkg.version)) continue;
      fail(pkg, { reason: "stable version not on npm; in pre mode `changeset publish` would tag it beta" });
      continue;
    }

    for (let attempt = 1; mode === "post-publish" && !npm.published && attempt < attempts; attempt++) {
      log(`${id} is not on npm yet; retrying in ${retryMs / 1000}s (${attempt}/${attempts - 1}).`);
      await sleep(retryMs);
      npm = view(pkg.name, pkg.version);
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
  return failures;
}

const ADVICE = {
  "unpublished-stable":
    "Master carries stable versions npm does not have, most likely from a stable release that pushed but did not\n" +
    "finish publishing. A beta run would publish them under the `beta` dist-tag and leave `latest` behind, so\n" +
    "nothing was versioned or published. Dispatch the Stable Release again: it publishes them under `latest`\n" +
    "(and also graduates any betas merged since). For a new package, add a changeset so it gets a beta version.",
  "pre-publish":
    "npm already has these versions, published before the commit that set them, so `changeset publish` would skip them.\n" +
    "Nothing was published. Add a changeset for each package so the next run bumps it past the stale version.",
  "post-publish":
    "Publishing finished, but npm does not show these versions as published from their version commit or later.\n" +
    "Check the publish log and `npm view <name>@<version> gitHead`.",
};

export function failureMessage(failures, mode) {
  const lines = failures.map((failure) =>
    [
      `  ${failure.name}@${failure.version}: ${failure.reason}`,
      ...(mode === "unpublished-stable"
        ? []
        : [
            `    npm gitHead:    ${failure.gitHead ?? "(none)"}`,
            `    version commit: ${failure.versionCommit ?? "(unknown)"}`,
          ]),
      `    HEAD:           ${failure.head}`,
    ].join("\n"),
  );
  return `Release provenance check failed (${mode}):\n\n${lines.join("\n")}\n\n${ADVICE[mode]}`;
}

function report(failures, mode) {
  if (failures.length === 0) return;
  if (process.env.GITHUB_ACTIONS === "true") {
    for (const failure of failures) {
      console.log(
        `::error title=${mode}: ${failure.name}@${failure.version}::${failure.reason} ` +
          `(npm gitHead ${failure.gitHead ?? "none"}, HEAD ${failure.head})`,
      );
    }
  }
  console.error(failureMessage(failures, mode));
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && MODES.includes(args[0])) {
    report(await check({ mode: args[0], repo: gitRepo() }), args[0]);
  } else {
    console.error(`usage: check-npm-release-provenance.mjs ${MODES.join("|")}`);
    process.exitCode = 2;
  }
}
