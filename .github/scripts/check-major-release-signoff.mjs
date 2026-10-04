#!/usr/bin/env node
// Major versions are a human decision (TC-615). Agents bump `minor` or
// `patch`, even for breaking changes. A major ships only after a maintainer
// approves it with an empty commit:
//
//   git commit --allow-empty -m "approve-major-release: @scope/pkg [@scope/other]"
//
// Modes:
//   pr <base> <head>  A pull request may not add a `major` changeset or raise a
//                     package's major version unless one of its own empty
//                     commits approves that package. A version PR that consumes
//                     a major changeset also accepts the sign-off that changeset
//                     was merged with.
//   beta              Before publishing betas: changesets not yet admitted to
//                     .changeset/pre.json may not declare `major` unless a
//                     commit in this pre-release cycle approves the package.
//   stable            Before graduating betas: no package may leave pre mode at
//                     a higher major than it entered unless a commit in this
//                     pre-release cycle approves it.
//
// This is a soft check. It catches the mistake; it cannot tell who wrote the
// sign-off, so agents must never write one.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const SIGNOFF = /^[ \t*>-]*approve-major-release:[ \t]*(.+)$/gim;

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function lines(output) {
  return output ? output.split("\n").filter(Boolean) : [];
}

function show(rev, path) {
  try {
    return execFileSync("git", ["show", `${rev}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseJson(source) {
  if (source === undefined) return undefined;
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

function isChangeset(path) {
  return /^\.changeset\/[^/]+\.md$/.test(path) && !/\/README\.md$/i.test(path);
}

function changesetMajors(source = "") {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
  if (frontmatter === undefined) return [];
  const names = [];
  for (const line of frontmatter.split(/\r?\n/)) {
    const entry = /^\s*["']?([^"':]+)["']?\s*:\s*major\s*$/.exec(line);
    if (entry) names.push(entry[1].trim());
  }
  return names;
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(version ?? ""),
  );
  if (!match) return undefined;
  return {
    raw: String(version),
    major: Number(match[1]),
    prerelease: match[4] !== undefined,
    release: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

function signoffsIn(message) {
  const names = new Set();
  for (const match of message.matchAll(SIGNOFF)) {
    for (const name of match[1].split(/[\s,]+/)) if (name) names.add(name);
  }
  return names;
}

// Sign-offs in any commit message of a range. Release modes run on the
// default branch, where a squash merge folds the PR's empty sign-off commit
// into the squash commit's message.
function historySignoffs(range) {
  return signoffsIn(git("log", "--format=%B", range));
}

// Sign-offs in the range's empty, non-merge commits only.
function emptyCommitSignoffs(range) {
  const names = new Set();
  for (const sha of lines(git("rev-list", "--no-merges", range))) {
    if (git("diff-tree", "--no-commit-id", "--name-only", "-r", sha) !== "") continue;
    for (const name of signoffsIn(git("log", "-1", "--format=%B", sha))) names.add(name);
  }
  return names;
}

function addedIn(path, rev = "HEAD") {
  return git("log", "--diff-filter=A", "--format=%H", "-1", rev, "--", path) || undefined;
}

// The range from `commit` (inclusive) to `rev`.
function rangeFrom(commit, rev = "HEAD") {
  try {
    git("rev-parse", "--verify", "--quiet", `${commit}^`);
    return `${commit}^..${rev}`;
  } catch {
    return rev;
  }
}

// The current pre-release cycle starts with the commit that added pre.json.
function cycleRange() {
  const start = addedIn(".changeset/pre.json");
  return start ? rangeFrom(start) : "HEAD";
}

function record(majors, name, reason) {
  if (!majors.has(name)) majors.set(name, []);
  majors.get(name).push(reason);
}

function unadmittedMajorChangesets(majors) {
  const pre = parseJson(read(".changeset/pre.json"));
  const admitted = new Set(pre?.changesets ?? []);
  let names = [];
  try {
    names = readdirSync(".changeset");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const name of names.sort()) {
    const path = `.changeset/${name}`;
    if (!isChangeset(path) || admitted.has(name.slice(0, -3))) continue;
    for (const pkg of changesetMajors(read(path))) record(majors, pkg, `major in ${path}`);
  }
}

function prMajors(base, head) {
  const mergeBase = git("merge-base", base, head);
  const majors = new Map();

  for (const path of lines(
    git("diff", "--name-only", "--diff-filter=AM", mergeBase, head, "--", ".changeset"),
  )) {
    if (!isChangeset(path)) continue;
    for (const name of changesetMajors(show(head, path))) record(majors, name, `major in ${path}`);
  }

  const pre = parseJson(show(mergeBase, ".changeset/pre.json"));
  for (const path of lines(git("diff", "--name-only", mergeBase, head))) {
    if (!/(^|\/)package\.json$/.test(path) || path.split("/").includes("node_modules")) continue;
    const after = parseJson(show(head, path));
    const before = parseJson(show(mergeBase, path));
    if (!after?.name || !before || after.private === true) continue;
    const next = parseVersion(after.version);
    let baseline = parseVersion(before.version);
    if (!next || !baseline) continue;
    // Graduating from pre mode compares against the version pre mode began at.
    if (!next.prerelease && baseline.prerelease) {
      baseline = parseVersion(pre?.initialVersions?.[after.name]) ?? baseline;
    }
    if (next.major > baseline.major) {
      record(majors, after.name, `${path}: ${baseline.raw} -> ${next.raw}`);
    }
  }

  const approved = emptyCommitSignoffs(`${mergeBase}..${head}`);

  // A version PR raises versions from changesets already on the base branch.
  // Those count as approved if they were merged with a sign-off.
  const consumed = new Map();
  for (const path of lines(git("ls-tree", "-r", "--name-only", mergeBase, "--", ".changeset"))) {
    if (!isChangeset(path)) continue;
    for (const name of changesetMajors(show(mergeBase, path))) {
      if (!consumed.has(name)) consumed.set(name, []);
      consumed.get(name).push(path);
    }
  }
  for (const [name, paths] of consumed) {
    if (!majors.has(name) || approved.has(name)) continue;
    for (const path of paths) {
      const added = addedIn(path, mergeBase);
      if (added && historySignoffs(rangeFrom(added, mergeBase)).has(name)) {
        approved.add(name);
        break;
      }
    }
  }

  return { majors, approved };
}

function betaMajors() {
  const majors = new Map();
  unadmittedMajorChangesets(majors);
  return { majors, approved: majors.size ? historySignoffs(cycleRange()) : new Set() };
}

function stableMajors() {
  const pre = parseJson(read(".changeset/pre.json"));
  const majors = new Map();
  if (pre) {
    for (const path of lines(git("ls-files", "*package.json"))) {
      if (path.split("/").includes("node_modules")) continue;
      const pkg = parseJson(read(path));
      if (!pkg?.name || pkg.private === true) continue;
      const current = parseVersion(pkg.version);
      const initial = parseVersion(pre.initialVersions?.[pkg.name]);
      if (current && initial && current.major > initial.major) {
        record(majors, pkg.name, `entered pre mode at ${initial.raw}, graduates to ${current.release}`);
      }
    }
  }
  unadmittedMajorChangesets(majors);
  return { majors, approved: majors.size ? historySignoffs(cycleRange()) : new Set() };
}

function report({ majors, approved }, mode) {
  const names = [...majors.keys()].sort();
  const granted = names.filter((name) => approved.has(name));
  const missing = names.filter((name) => !approved.has(name));

  if (names.length === 0) {
    console.log("No major version bumps.");
    return;
  }
  if (granted.length) console.log(`Major release approved by sign-off: ${granted.join(", ")}`);
  if (missing.length === 0) return;

  const where =
    mode === "pr"
      ? "they add this empty commit to the pull request"
      : "they push this empty commit to the default branch (directly or through a PR)";
  const message = [
    `No sign-off for a major release: ${missing.join(", ")}`,
    "",
    ...missing.map((name) => `  ${name}: ${majors.get(name).join("; ")}`),
    "",
    "Major versions are a human decision. Agents use `minor` or `patch`, even for breaking changes.",
    `If a maintainer has decided to ship a major, ${where}:`,
    "",
    `  git commit --allow-empty -m "approve-major-release: ${missing.join(" ")}"`,
  ].join("\n");

  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::error title=No sign-off for a major release::${missing.join(", ")}`);
  }
  console.error(message);
  process.exitCode = 1;
}

const [mode, base, head] = process.argv.slice(2);
if (mode === "pr" && base && head) report(prMajors(base, head), mode);
else if (mode === "beta") report(betaMajors(), mode);
else if (mode === "stable") report(stableMajors(), mode);
else {
  console.error("usage: check-major-release-signoff.mjs pr <base> <head> | beta | stable");
  process.exitCode = 2;
}
