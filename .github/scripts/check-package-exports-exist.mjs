#!/usr/bin/env node
// Every file a package's `exports` map points at must exist and be non-empty
// once the package is built. A broken target only shows up for consumers
// (a missing `types` file, a subpath whose bundle was never emitted), so check
// the built package itself.
//
//   node .github/scripts/check-package-exports-exist.mjs <package-dir>
//
// Walks `exports` recursively: subpaths, every condition key (`types`,
// `import`, `require`, `default`, nested conditions) and fallback arrays.
// `null` targets (explicit exclusions) are ignored; a package with no
// checkable target at all (`exports` null, `{}`) fails rather than passing vacuously. Wildcard targets
// (`./*`, `./features/*.js`) are not expanded: they are reported as skipped
// and not checked.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Collect every string target in an `exports` value, with a readable key path.
export function collectTargets(value, path = "exports") {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [{ path, target: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => collectTargets(v, `${path}[${i}]`));
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => collectTargets(v, `${path}[${JSON.stringify(k)}]`));
  }
  return [{ path, target: value }];
}

function isNonEmptyFile(file) {
  try {
    const s = statSync(file);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

// Returns { checked, skipped, problems } for the package at `packageDir`.
export function checkExports(packageDir) {
  const root = resolve(packageDir);
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (pkg.exports === undefined) {
    return { checked: [], skipped: [], problems: ["package.json has no `exports` field"] };
  }
  const checked = [];
  const skipped = [];
  const problems = [];
  for (const { path, target } of collectTargets(pkg.exports)) {
    if (typeof target !== "string" || !target.startsWith("./")) {
      problems.push(`${path}: target ${JSON.stringify(target)} is not a "./" relative path`);
      continue;
    }
    if (target.includes("*")) {
      skipped.push({ path, target });
      continue;
    }
    const file = resolve(root, target);
    const rel = relative(root, file);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      problems.push(`${path}: ${target} escapes the package directory`);
      continue;
    }
    checked.push(target);
    if (!isNonEmptyFile(file)) problems.push(`${path}: ${target} is missing or empty`);
  }
  // An empty map (`null`, `{}`, only `null` targets) would pass vacuously.
  if (checked.length + skipped.length === 0 && problems.length === 0) {
    problems.push("`exports` has no checkable targets (null, `{}`, or only null targets)");
  }
  return { checked, skipped, problems };
}

function main(argv) {
  const [packageDir, ...rest] = argv;
  if (!packageDir || rest.length > 0) {
    console.error("usage: check-package-exports-exist.mjs <package-dir>");
    return 2;
  }
  const { checked, skipped, problems } = checkExports(packageDir);
  for (const { path, target } of skipped) {
    console.log(`::notice::skipped wildcard export target ${target} (${path}); wildcards are not expanded`);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::${p}`);
    console.error(`\n${problems.length} export problem(s) in ${packageDir}:`);
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  console.log(`All ${checked.length} export target file(s) in ${packageDir} exist and are non-empty (${skipped.length} wildcard skipped).`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
