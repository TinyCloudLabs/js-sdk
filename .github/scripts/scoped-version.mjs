#!/usr/bin/env node
// Scoped stable versioning for the Release workflow.
//
// master is out of pre mode. Only the packages in .github/release-scope.json release from a push to
// master; every other workspace package (still a beta, or held back for any other reason) keeps its
// version, its CHANGELOG and its pending changesets until a maintainer moves it into the scope.
//
// `changeset version` knows no package filter: it consumes every changeset and bumps every dependent.
// `version` here therefore
//   1. sets aside the part of each changeset that names a package outside the scope (a changeset that
//      names both is split: the in-scope lines are consumed, the rest is written back as a pending
//      changeset with the same name and text),
//   2. runs `changeset version`,
//   3. puts every out-of-scope package back (version, CHANGELOG) except its dependency pins on in-scope
//      packages, which follow the new in-scope versions so the workspace still links,
//   4. refuses the result unless each in-scope bump is a stable, same-major, higher version, the result
//      matches the locked inventory (`expect`, when set), and no in-scope package requires a
//      prerelease of a package outside the scope.
//
// usage: scoped-version.mjs <command> [options]
//   gate [<github-output>]        write `enabled=true|false` (the scope file's switch) and exit 0
//   check                         the scope file is well formed and every pending changeset names known packages
//   pending [<github-output>]      write `pending=<n>`: changesets that name an in-scope package
//   version [--root <dir>]         the scoped `changeset version` described above
//   plan                           run `version` on a throwaway copy of the working tree (tracked and new files) and print the inventory
//                                  (needs node_modules at the repository root for the changeset CLI)

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SCOPE_FILE = ".github/release-scope.json";
const WORKSPACE_DIRS = ["packages", "apps", "tests"];
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const RUNTIME_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];
const BUMP = /^\s*["']?([^"':]+?)["']?\s*:\s*(major|minor|patch)\s*$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const fail = (message) => {
  throw new Error(message);
};

function parseVersion(version) {
  const match = SEMVER.exec(String(version ?? ""));
  if (!match) return undefined;
  return { major: +match[1], minor: +match[2], patch: +match[3], prerelease: match[4] !== undefined };
}

function compare(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

// ---- scope file --------------------------------------------------------------------------------------------------

export function readScope(root = ".") {
  let scope;
  try {
    scope = JSON.parse(readFileSync(join(root, SCOPE_FILE), "utf8"));
  } catch (error) {
    fail(`${SCOPE_FILE} is missing or not JSON: ${error.message}`);
  }
  const problems = [];
  if (typeof scope.enabled !== "boolean") problems.push('"enabled" must be true or false');
  if (!Array.isArray(scope.packages) || scope.packages.length === 0 || scope.packages.some((name) => typeof name !== "string")) {
    problems.push('"packages" must be a non-empty list of package names');
  } else if (new Set(scope.packages).size !== scope.packages.length) problems.push('"packages" lists a package twice');
  const expect = scope.expect ?? {};
  if (typeof expect !== "object" || expect === null || Array.isArray(expect)) problems.push('"expect" must be an object of name -> version');
  else {
    for (const [name, version] of Object.entries(expect)) {
      if (!scope.packages?.includes(name)) problems.push(`"expect" names ${name}, which is not in "packages"`);
      const parsed = parseVersion(version);
      if (!parsed || parsed.prerelease) problems.push(`"expect" ${name}: ${JSON.stringify(version)} is not a stable version`);
    }
  }
  if (problems.length) fail(`${SCOPE_FILE}: ${problems.join("; ")}`);
  return { enabled: scope.enabled, packages: scope.packages, expect };
}

// ---- workspace ---------------------------------------------------------------------------------------------------

export function workspaceManifests(root = ".") {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (existsSync(join(path, "package.json"))) {
        const raw = readFileSync(join(path, "package.json"), "utf8");
        const manifest = JSON.parse(raw);
        if (manifest.name) found.push({ dir: path, file: join(path, "package.json"), raw, manifest });
      }
      walk(path);
    }
  };
  for (const dir of WORKSPACE_DIRS) if (existsSync(join(root, dir))) walk(join(root, dir));
  return found;
}

// ---- changesets --------------------------------------------------------------------------------------------------

// { bumps: [[name, level, line]], head, body } or undefined when `source` has no frontmatter.
export function parseChangeset(source) {
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return undefined;
  const bumps = [];
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parsed = BUMP.exec(line);
    if (!parsed) fail(`cannot read changeset line ${JSON.stringify(line)}`);
    bumps.push([parsed[1].trim(), parsed[2], line]);
  }
  return { bumps, body: match[2] };
}

const render = (lines, body) => `---\n${lines.join("\n")}\n---\n${body}`;

// Split one changeset into the text that stays for this release (in scope) and the text that is set aside (held).
export function splitChangeset(source, scope) {
  const parsed = parseChangeset(source);
  if (!parsed) fail("changeset has no frontmatter");
  const inScope = parsed.bumps.filter(([name]) => scope.includes(name));
  const held = parsed.bumps.filter(([name]) => !scope.includes(name));
  return {
    inScope: inScope.length ? render(inScope.map(([, , line]) => line), parsed.body) : undefined,
    held: held.length ? render(held.map(([, , line]) => line), parsed.body) : undefined,
    empty: parsed.bumps.length === 0,
    inScopeBumps: inScope.map(([name, level]) => [name, level]),
  };
}

function changesetFiles(root) {
  const dir = join(root, ".changeset");
  return readdirSync(dir).filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md").sort().map((name) => ({ name, path: join(dir, name) }));
}

export function pendingCount(root, scope) {
  return changesetFiles(root).filter(({ path }) => splitChangeset(readFileSync(path, "utf8"), scope.packages).inScope).length;
}

// ---- checks ------------------------------------------------------------------------------------------------------

export function checkScope(root, scope) {
  const manifests = workspaceManifests(root);
  const byName = new Map(manifests.map((m) => [m.manifest.name, m.manifest]));
  const problems = [];
  for (const name of scope.packages) {
    const manifest = byName.get(name);
    if (!manifest) problems.push(`${name} is not a workspace package`);
    else if (manifest.private === true) problems.push(`${name} is private and cannot release`);
    else if (!parseVersion(manifest.version) || parseVersion(manifest.version).prerelease) problems.push(`${name}@${manifest.version} is not a stable version`);
  }
  for (const { name, path } of changesetFiles(root)) {
    let parsed;
    try {
      parsed = parseChangeset(readFileSync(path, "utf8"));
      if (!parsed) problems.push(`.changeset/${name} has no frontmatter`);
    } catch (error) {
      problems.push(`.changeset/${name}: ${error.message}`);
    }
    for (const [pkg] of parsed?.bumps ?? []) if (!byName.has(pkg)) problems.push(`.changeset/${name} names ${pkg}, which is not a workspace package`);
  }
  return problems;
}

// In-scope packages whose runtime dependencies name a workspace package at a prerelease version: a stable release
// must not require a beta (the package would install a beta nobody approved).
export function prereleaseRuntimePins(manifests, scope) {
  const byName = new Map(manifests.map((m) => [m.manifest.name, m.manifest]));
  const problems = [];
  for (const name of scope) {
    const manifest = byName.get(name);
    if (!manifest) continue;
    for (const field of RUNTIME_FIELDS) {
      for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
        const target = byName.get(dep);
        if (!target || scope.includes(dep)) continue;
        const pinned = String(spec).startsWith("workspace:") ? target.version : String(spec).replace(/^[=^~v]/, "");
        if (parseVersion(pinned)?.prerelease) problems.push(`${name}@${manifest.version} requires ${dep}@${pinned} (${field}), a prerelease outside the release scope`);
      }
    }
  }
  return problems;
}

// What the run changed, judged against the versions before it: { name, from, to, level }[] for the in-scope packages.
export function releaseInventory(before, after, scope) {
  const out = [];
  for (const name of scope) {
    const from = before.get(name);
    const to = after.get(name);
    if (from === undefined || to === undefined || from === to) continue;
    const a = parseVersion(from);
    const b = parseVersion(to);
    out.push({ name, from, to, level: a && b ? (b.major > a.major ? "major" : b.minor > a.minor ? "minor" : "patch") : "unknown" });
  }
  return out;
}

export function verifyInventory({ inventory, expect, outOfScopeChanges }) {
  const problems = [];
  for (const { name, from, to } of inventory) {
    const a = parseVersion(from);
    const b = parseVersion(to);
    if (!a || !b) problems.push(`${name}: cannot read ${from} -> ${to}`);
    else if (b.prerelease) problems.push(`${name}: ${to} is a prerelease`);
    else if (b.major !== a.major) problems.push(`${name}: ${from} -> ${to} changes the major version`);
    else if (compare(b, a) <= 0) problems.push(`${name}: ${from} -> ${to} is not an increase`);
  }
  for (const name of outOfScopeChanges) problems.push(`${name} is outside the release scope but its version changed`);
  const locked = Object.entries(expect);
  if (locked.length) {
    const got = new Map(inventory.map(({ name, to }) => [name, to]));
    for (const [name, version] of locked) if (got.get(name) !== version) problems.push(`locked inventory expects ${name}@${version}, this release gives ${got.get(name) ?? "no new version"}`);
    for (const name of got.keys()) if (!(name in expect)) problems.push(`locked inventory does not list ${name}@${got.get(name)}`);
  }
  return problems;
}

// ---- version -----------------------------------------------------------------------------------------------------

function defaultChangesetVersion(root) {
  const result = spawnSync("bun", ["changeset", "version"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) fail(`changeset version failed (exit ${result.status})`);
}

// An out-of-scope manifest as it was, with its pins on in-scope packages moved to their new versions.
export function pinsFollow(raw, renamed) {
  const manifest = JSON.parse(raw);
  let moved = false;
  for (const field of DEP_FIELDS) {
    for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
      const move = renamed.get(dep);
      if (move && spec === move.from) {
        manifest[field][dep] = move.to;
        moved = true;
      }
    }
  }
  return moved ? `${JSON.stringify(manifest, null, 2)}\n` : raw;
}

export function scopedVersion(root, { scope, runChangesetVersion = defaultChangesetVersion, log = console.log } = {}) {
  scope ??= readScope(root);
  if (!scope.enabled) fail(`${SCOPE_FILE} has "enabled": false; refusing to version`);
  const problems = checkScope(root, scope);
  if (problems.length) fail(`release scope is not consistent:\n  ${problems.join("\n  ")}`);

  const before = workspaceManifests(root);
  const beforeVersions = new Map(before.map((m) => [m.manifest.name, m.manifest.version]));
  const held = before.filter((m) => !scope.packages.includes(m.manifest.name));
  const heldChangelogs = new Map(held.map((m) => [m.dir, existsSync(join(m.dir, "CHANGELOG.md")) ? readFileSync(join(m.dir, "CHANGELOG.md"), "utf8") : undefined]));

  // 1. set aside the held part of every changeset
  const setAside = [];
  for (const file of changesetFiles(root)) {
    const split = splitChangeset(readFileSync(file.path, "utf8"), scope.packages);
    if (split.empty) continue;
    if (split.held) setAside.push({ ...file, held: split.held });
    if (split.inScope) {
      if (split.held) writeFileSync(file.path, split.inScope);
    } else rmSync(file.path);
  }

  // 2. version
  runChangesetVersion(root);

  // 3. put every out-of-scope package back
  const after = workspaceManifests(root);
  const afterVersions = new Map(after.map((m) => [m.manifest.name, m.manifest.version]));
  const renamed = new Map();
  for (const name of scope.packages) {
    const from = beforeVersions.get(name);
    const to = afterVersions.get(name);
    if (from !== undefined && to !== undefined && from !== to) renamed.set(name, { from, to });
  }
  let putBack = 0;
  for (const m of held) {
    if (after.find((a) => a.dir === m.dir)?.manifest.version !== m.manifest.version) putBack += 1;
    writeFileSync(m.file, pinsFollow(m.raw, renamed));
    const changelog = heldChangelogs.get(m.dir);
    if (changelog !== undefined) writeFileSync(join(m.dir, "CHANGELOG.md"), changelog);
  }
  for (const entry of setAside) writeFileSync(entry.path, entry.held);

  // 4. verify
  const inventory = releaseInventory(beforeVersions, afterVersions, scope.packages);
  const final = workspaceManifests(root);
  const finalProblems = [
    ...verifyInventory({
      inventory,
      expect: scope.expect,
      outOfScopeChanges: held.filter((m) => final.find((f) => f.dir === m.dir)?.manifest.version !== m.manifest.version).map((m) => m.manifest.name),
    }),
    ...(inventory.length ? prereleaseRuntimePins(final, scope.packages) : []),
  ];
  log(`changeset version moved ${inventory.length} in-scope package(s); put back ${putBack} out-of-scope package(s) that it had bumped as dependents.`);
  for (const { name, from, to, level } of inventory) log(`  ${name} ${from} -> ${to} (${level})`);
  if (finalProblems.length) fail(`the scoped release is refused:\n  ${finalProblems.join("\n  ")}`);
  return { inventory, putBack };
}

// ---- command line ------------------------------------------------------------------------------------------------

function trackedCopy(root) {
  const copy = mkdtempSync(join(tmpdir(), "scoped-version-plan-"));
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\0").filter(Boolean);
  for (const file of files) {
    if (!existsSync(join(root, file))) continue;
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    cpSync(join(root, file), join(copy, file));
  }
  if (existsSync(join(root, "node_modules"))) symlinkSync(resolve(root, "node_modules"), join(copy, "node_modules"));
  return copy;
}

function main([command, ...args]) {
  const output = (key, value, path) => {
    console.log(`${key}=${value}`);
    if (path) appendFileSync(path, `${key}=${value}\n`);
  };
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 ? resolve(args[rootIndex + 1]) : process.cwd();
  if (command === "gate") {
    const scope = readScope(root);
    return output("enabled", String(scope.enabled), args[0]);
  }
  if (command === "check") {
    const problems = checkScope(root, readScope(root));
    if (problems.length) fail(`release scope is not consistent:\n  ${problems.join("\n  ")}`);
    return console.log("Release scope OK.");
  }
  if (command === "pending") return output("pending", String(pendingCount(root, readScope(root))), args[0]);
  if (command === "version") return void scopedVersion(root);
  if (command === "plan") {
    const copy = trackedCopy(root);
    try {
      const scope = { ...readScope(copy), enabled: true };
      console.log(`Dry run in ${copy} (the scope file's own switch is ${readScope(root).enabled ? "on" : "off"}).`);
      return void scopedVersion(copy, { scope });
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
  console.error("usage: scoped-version.mjs gate [<github-output>] | check | pending [<github-output>] | version [--root <dir>] | plan");
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (process.env.GITHUB_ACTIONS === "true") console.log(`::error title=scoped-version::${String(error.message).replace(/\n/g, " ")}`);
    console.error(error.message);
    process.exitCode = 1;
  }
}
