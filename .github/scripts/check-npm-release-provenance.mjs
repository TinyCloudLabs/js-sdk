#!/usr/bin/env node
// Release provenance guard (TC-1095).
//
// The Release workflow pushes its version commit to master and then publishes
// from that commit. `changeset publish` skips every `name@version` that npm
// already has, and the skip is silent. On 2026-10-14 a cancelled run had
// published @tinycloud/mcp, cli, operations and courier from b6038b10. The next
// version commit (1a4993c3) gave newer code the same version numbers, and the
// publish skipped them, so npm's builds lacked #528 and #530.
//
// Both modes run from the checked-out version commit (HEAD) and look only at
// public workspace packages whose version differs between <base> and HEAD:
// the packages this run is meant to publish.
//
//   pre-publish <base>   If npm already has name@version, fail unless npm's
//                        gitHead is HEAD, or is an ancestor of HEAD and the
//                        package directory has not changed since (ignoring
//                        CHANGELOG.md and version numbers in package.json).
//                        Otherwise `changeset publish` may skip it.
//   post-publish <base>  Each package must now be on npm, published from HEAD
//                        or passing the pre-publish check. Retries while the
//                        registry catches up.

import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function parseJson(source) {
  if (source === undefined) return undefined;
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
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
    show(rev, path) {
      const result = run(["show", `${rev}:${path}`]);
      return result.status === 0 ? result.stdout : undefined;
    },
    files: (rev) => ok(["ls-tree", "-r", "--name-only", rev]).split("\n").filter(Boolean),
    isAncestor(ancestor, rev) {
      if (run(["cat-file", "-e", `${ancestor}^{commit}`]).status !== 0) return false;
      const result = run(["merge-base", "--is-ancestor", ancestor, rev]);
      if (result.status === 0) return true;
      if (result.status === 1) return false;
      throw new Error(`git merge-base --is-ancestor ${ancestor} ${rev} failed: ${result.stderr.trim()}`);
    },
    changedFiles: (from, to, dir) =>
      ok([
        "diff",
        "--name-only",
        from,
        to,
        "--",
        dir,
        `:(exclude)${dir}/CHANGELOG.md`,
        `:(exclude)${dir}/package.json`,
      ])
        .split("\n")
        .filter(Boolean),
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

export function workspacePackages(repo, rev) {
  const root = parseJson(repo.show(rev, "package.json")) ?? {};
  const patterns = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages ?? [];
  return repo
    .files(rev)
    .filter((path) => path.endsWith("/package.json") && !path.split("/").includes("node_modules"))
    .map((path) => path.slice(0, -"/package.json".length))
    .filter((dir) => patterns.some((pattern) => matchesWorkspace(pattern, dir)))
    .map((dir) => ({ dir, manifest: parseJson(repo.show(rev, `${dir}/package.json`)) }))
    .filter(({ manifest }) => manifest?.name);
}

// Public workspace packages whose version at `head` differs from `base`.
export function bumpedPackages(repo, base, head) {
  const workspaces = workspacePackages(repo, head);
  return workspaces
    .filter(({ manifest }) => manifest.private !== true && manifest.version)
    .filter(({ dir, manifest }) => {
      const before = parseJson(repo.show(base, `${dir}/package.json`));
      return before?.version !== manifest.version;
    })
    .map(({ dir, manifest }) => ({ name: manifest.name, version: manifest.version, dir }));
}

// package.json without the numbers `changeset version` rewrites: the package's
// own version and the versions of internal dependencies.
function comparableManifest(source, internal) {
  const manifest = parseJson(source);
  if (!manifest) return undefined;
  delete manifest.version;
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (internal.has(name)) manifest[field][name] = "<workspace>";
    }
  }
  return JSON.stringify(manifest);
}

// Is the package at `head` the same build input as npm's copy from `gitHead`?
export function provenance({ pkg, gitHead, head, repo, internal }) {
  if (!gitHead) return { ok: false, reason: "npm records no gitHead for this version" };
  if (gitHead === head) return { ok: true, reason: "published from HEAD" };
  if (!repo.isAncestor(gitHead, head)) {
    return { ok: false, reason: "npm's gitHead is not an ancestor of HEAD" };
  }
  const changed = repo.changedFiles(gitHead, head, pkg.dir);
  if (changed.length) {
    const shown = changed.slice(0, 10).join(", ");
    const more = changed.length > 10 ? ` and ${changed.length - 10} more` : "";
    return { ok: false, reason: `${pkg.dir} changed since npm's gitHead: ${shown}${more}` };
  }
  const path = `${pkg.dir}/package.json`;
  if (
    comparableManifest(repo.show(gitHead, path), internal) !==
    comparableManifest(repo.show(head, path), internal)
  ) {
    return { ok: false, reason: `${path} changed since npm's gitHead beyond version numbers` };
  }
  return { ok: true, reason: `unchanged since npm's gitHead ${gitHead}` };
}

export async function check({
  mode,
  base,
  repo,
  view = npmView,
  sleep = (ms) => delay(ms),
  attempts = 6,
  retryMs = 10_000,
  log = console.log,
}) {
  const head = repo.revParse("HEAD");
  const baseSha = repo.revParse(base);
  const internal = new Set(workspacePackages(repo, head).map(({ manifest }) => manifest.name));
  const packages = bumpedPackages(repo, baseSha, head);
  const failures = [];

  if (packages.length === 0) log(`No package versions changed between ${baseSha} and HEAD ${head}.`);

  for (const pkg of packages) {
    const id = `${pkg.name}@${pkg.version}`;
    let npm = view(pkg.name, pkg.version);
    for (let attempt = 1; mode === "post-publish" && !npm.published && attempt < attempts; attempt++) {
      log(`${id} is not on npm yet; retrying in ${retryMs / 1000}s (${attempt}/${attempts - 1}).`);
      await sleep(retryMs);
      npm = view(pkg.name, pkg.version);
    }

    if (!npm.published) {
      if (mode === "pre-publish") log(`${id}: not on npm; will publish.`);
      else failures.push({ ...pkg, gitHead: undefined, head, reason: "not on npm after publish" });
      continue;
    }

    const verdict = provenance({ pkg, gitHead: npm.gitHead, head, repo, internal });
    if (verdict.ok) log(`${id}: on npm, ${verdict.reason}.`);
    else failures.push({ ...pkg, gitHead: npm.gitHead, head, reason: verdict.reason });
  }
  return failures;
}

export function failureMessage(failures, mode) {
  const lines = failures.map(
    (failure) =>
      `  ${failure.name}@${failure.version}: ${failure.reason}\n` +
      `    npm gitHead: ${failure.gitHead ?? "(none)"}\n` +
      `    HEAD:        ${failure.head}`,
  );
  const advice =
    mode === "pre-publish"
      ? "npm already has these versions, built from other code, so `changeset publish` would skip them.\n" +
        "Nothing was published. Add a changeset for each package so the next run bumps it past the stale version."
      : "Publishing finished, but npm does not show these versions as built from this version commit.\n" +
        "Check the publish log and `npm view <name>@<version> gitHead`.";
  return `Release provenance check failed (${mode}):\n\n${lines.join("\n")}\n\n${advice}`;
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
  const [mode, base] = process.argv.slice(2);
  if ((mode === "pre-publish" || mode === "post-publish") && base) {
    report(await check({ mode, base, repo: gitRepo() }), mode);
  } else {
    console.error("usage: check-npm-release-provenance.mjs pre-publish|post-publish <base>");
    process.exitCode = 2;
  }
}
