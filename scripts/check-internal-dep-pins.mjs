#!/usr/bin/env node
// Run after `changeset version`, before `changeset publish`. Fails when a non-private workspace package
// depends on another workspace package through a range that excludes that package's current version
// (a stale pin would publish a manifest pointing at an old or duplicate copy). Anything it cannot
// check fails too. Usage: node scripts/check-internal-dep-pins.mjs [repo-root]
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
// `semver` is not a declared dependency of this repo; it is hoisted from @changesets/cli.
const semver = createRequire(import.meta.url)("semver");

const WORKSPACE_DIRS = ["packages", "apps", "tests"];
const DEP_KINDS = ["dependencies", "peerDependencies", "optionalDependencies"];
// Specs that do not name a registry version.
const NON_REGISTRY_RANGE = /^(workspace|catalog|file|link|git|github|https?):/;
const SEMVER_RANGE_CHARS = /^[0-9A-Za-z.\-+^~<>=|*xX \t]+$/;
const VERSION_WORD = /^v?(\d+|[xX*])(\.(\d+|[xX*])){0,2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function manifests(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (existsSync(join(path, "package.json"))) found.push(join(path, "package.json"));
      walk(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

// The semver range a spec resolves to against its own registry name, or why it cannot be checked.
function registryRange(depName, spec) {
  if (typeof spec !== "string") return { problem: "not a string" };
  let range = spec;
  if (spec.startsWith("npm:")) {
    const body = spec.slice("npm:".length);
    const at = body.lastIndexOf("@");
    if (at <= 0) return { problem: "npm alias without a version" };
    const aliased = body.slice(0, at);
    if (aliased !== depName) return { problem: `npm alias of "${aliased}", not "${depName}"` };
    range = body.slice(at + 1);
  }
  if (range.trim() === "") return { problem: "empty range" };
  if (!SEMVER_RANGE_CHARS.test(range)) return { problem: "not a semver range" };
  const words = range.split(/[\s|<>=^~]+/).filter((w) => w !== "" && w !== "-");
  if (words.length === 0 || !words.every((w) => VERSION_WORD.test(w))) return { problem: "not a semver range" };
  if (semver.validRange(range) === null) return { problem: "not a semver range" };
  return { range };
}

function checkInternalDeps(packages) {
  const errors = [];
  const byName = new Map(packages.filter((p) => p.name).map((p) => [p.name, p]));
  for (const pkg of [...packages].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    if (pkg.private) continue;
    for (const kind of DEP_KINDS) {
      for (const [depName, spec] of Object.entries(pkg[kind] ?? {})) {
        const target = byName.get(depName);
        if (!target) continue;
        if (typeof spec === "string" && NON_REGISTRY_RANGE.test(spec)) continue;
        const resolved = registryRange(depName, spec);
        if ("problem" in resolved) {
          errors.push(`${pkg.name}@${pkg.version}: ${kind} "${depName}": cannot check ${JSON.stringify(spec)}: ${resolved.problem}`);
        } else if (typeof target.version !== "string" || !semver.satisfies(target.version, resolved.range)) {
          errors.push(`${pkg.name}@${pkg.version}: ${kind} "${depName}": "${spec}" does not include the current ${depName}@${target.version}`);
        }
      }
    }
  }
  return errors;
}

const packages = WORKSPACE_DIRS.flatMap((dir) => manifests(join(root, dir))).map((file) =>
  JSON.parse(readFileSync(file, "utf8")),
);
const errors = checkInternalDeps(packages);
if (errors.length > 0) {
  console.error("Internal dependency pins do not match the versions about to be published:");
  for (const error of errors) console.error(`::error::${error}`);
  process.exit(1);
}
console.log(`Internal dependency pins OK (${packages.length} workspace manifests checked).`);
