#!/usr/bin/env node
// Fails on JavaScript and Node APIs that are newer than a package's Node floor
// (TC-4279). `bun test` runs in-process code under Bun, which has all of them,
// so a call like `Promise.withResolvers()` passes the tests and then throws on
// a user's Node 20.
//
//   node .github/scripts/check-node-floor.mjs [workspace-root]
//
// Checks the `src/` of every workspace package (root package.json
// `workspaces`) whose `engines.node` allows Node 20. The floor is the lowest
// version the range allows: ">=20" is 20.0.0, so an API Node 20 gained in a
// minor release (URL.parse in 20.18.0) is flagged too. Tests (`*.test.*`,
// `*.spec.*`, `*.test-helper.*`, `test/`, `tests/`, `__tests__/`,
// `src/test-support/`) and the browser-only sources in BROWSER_ONLY are skipped.
// Sources are parsed with TypeScript, so comments, strings and type positions
// never match.
//
// Feature detection is allowed: `typeof X.y`, `X.y?.(…)` and `X?.y` are not
// flagged. Anything else needs a comment on the same line or the line above:
//   // node-floor-ok: <why this is safe on the floor>
// An escape with no reason is itself an error.
//
// Not covered: `require(esm)` (it depends on what the target module is, not on
// the call) and APIs reached through a dynamic `import()`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The first Node release with each API, including a backport to a 20.x minor
// (from the Node docs `added:` history; each was probed on 20.0.0, 20.20.2,
// 22.0.0, 22.23.2 and 24.0.0).
const STATIC = {
  "Promise.withResolvers": { since: "22.0.0", fix: "use the executor form, as courier/src/defer.ts does" },
  "Promise.try": { since: "23.0.0" },
  "Array.fromAsync": { since: "22.0.0", fix: "collect with for await" },
  "Iterator.from": { since: "22.0.0" },
  "Iterator.prototype": { since: "22.0.0" },
  "RegExp.escape": { since: "24.0.0" },
  "Error.isError": { since: "24.0.0", fix: "use instanceof Error" },
  "Atomics.pause": { since: "24.0.0" },
  "Intl.DurationFormat": { since: "23.0.0" },
  "Object.groupBy": { since: "21.0.0" },
  "Map.groupBy": { since: "21.0.0" },
  "URL.parse": { since: "20.18.0", fix: "use new URL() in a try/catch" },
  "AbortSignal.any": { since: "20.3.0" },
  "process.getBuiltinModule": { since: "20.16.0" },
  "process.loadEnvFile": { since: "20.12.0" },
};
const IMPORT_META = {
  dirname: { since: "20.11.0", fix: "use dirname(fileURLToPath(import.meta.url))" },
  filename: { since: "20.11.0", fix: "use fileURLToPath(import.meta.url)" },
  resolve: { since: "20.6.0" },
};
// Members of built-in modules, reached by a named import or through the module object.
const FS_GLOB = { glob: { since: "22.0.0" }, globSync: { since: "22.0.0" } };
const MODULE_MEMBERS = {
  fs: FS_GLOB,
  "fs/promises": FS_GLOB,
  util: { styleText: { since: "20.12.0" }, parseEnv: { since: "20.12.0" } },
  crypto: { hash: { since: "20.12.0", fix: "use createHash()" } },
  process: { getBuiltinModule: { since: "20.16.0" }, loadEnvFile: { since: "20.12.0" } },
};
// Set.prototype methods (Node 22.0.0). Any receiver except an imported binding
// (zod's `z.union`, `z.intersection`).
const SET_METHODS = new Set(["union", "intersection", "difference", "symmetricDifference", "isSubsetOf", "isSupersetOf", "isDisjointFrom"]);
// Iterator helpers (Node 22.0.0), called on what `.values()`, `.keys()`, `.entries()` or `.matchAll()` returns.
const ITERATOR_SOURCES = new Set(["values", "keys", "entries", "matchAll"]);
const ITERATOR_HELPERS = new Set(["map", "filter", "take", "drop", "flatMap", "reduce", "toArray", "forEach", "some", "every", "find"]);

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec|test-helper)\.[^/]+$/;
const TEST_DIRS = new Set(["test", "tests", "__tests__", "node_modules"]);
// Test fixtures and helpers that live in `src/` but are in no package entry (node-sdk, mcp): only `src/test-support/`.
const SRC_TEST_SUPPORT = "test-support";
// Source that only ships in browser bundles (tsup `platform: "browser"`), where the Node floor doesn't apply.
const BROWSER_ONLY = ["packages/replica/src/browser/", "packages/replica/src/kv-storage/", "packages/replica/src/worker.ts"];
const ESCAPE = /node-floor-ok:?(.*)/;

const compare = (a, b) => {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
const parseVersion = (text) => text.split(".").map(Number);

/** The lowest Node version an `engines.node` range allows, or undefined if the range can't be read. */
export function rangeFloor(range) {
  let floor;
  for (const alternative of String(range).split("||")) {
    const first = alternative.trim().split(/\s+/)[0] ?? "";
    const match = /^(?:>=|\^|~|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(first);
    if (!match) return undefined;
    const version = [match[1], match[2], match[3]].map((part) => (part === undefined || part === "x" || part === "*" ? 0 : Number(part)));
    if (floor === undefined || compare(version, floor) < 0) floor = version;
  }
  return floor;
}

const nodeModule = (specifier) => specifier.replace(/^node:/, "");

function rootIdentifier(node) {
  while (ts.isPropertyAccessExpression(node)) node = node.expression;
  return ts.isIdentifier(node) ? node.text : undefined;
}

// `typeof X.y`, `X.y?.()`, `X?.y`: the code checks for the API before using it.
function isFeatureDetection(node) {
  if (node.questionDotToken) return true;
  const parent = node.parent;
  if (ts.isTypeOfExpression(parent)) return true;
  if (ts.isCallExpression(parent) && parent.expression === node && parent.questionDotToken) return true;
  return false;
}

/** Problems in one source file for the given floor ([major, minor, patch]). */
export function checkSource(text, fileName, floor) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lines = text.split("\n");
  const imported = new Set();
  const moduleObjects = new Map(); // local name -> module name (default, namespace, or `promises`)
  const hits = [];

  const hit = (node, api, rule) => {
    if (compare(parseVersion(rule.since), floor) <= 0) return;
    hits.push({ node, api, rule });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = nodeModule(node.moduleSpecifier.text);
      const clause = node.importClause;
      if (clause?.name) imported.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) imported.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) imported.add(element.name.text);
      const members = MODULE_MEMBERS[module];
      if (members && !clause?.isTypeOnly) {
        if (clause?.name) moduleObjects.set(clause.name.text, module);
        if (bindings && ts.isNamespaceImport(bindings)) moduleObjects.set(bindings.name.text, module);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const name = (element.propertyName ?? element.name).text;
            if (name === "promises" && module === "fs") moduleObjects.set(element.name.text, "fs/promises");
            else if (members[name] && !element.isTypeOnly) hit(element, `${name} from "${node.moduleSpecifier.text}"`, members[name]);
          }
        }
      }
    } else if (ts.isPropertyAccessExpression(node) && !isFeatureDetection(node)) {
      const name = node.name.text;
      const target = node.expression;
      if (ts.isMetaProperty(target) && target.keywordToken === ts.SyntaxKind.ImportKeyword && IMPORT_META[name]) {
        hit(node, `import.meta.${name}`, IMPORT_META[name]);
      } else if (ts.isIdentifier(target) && STATIC[`${target.text}.${name}`]) {
        hit(node, `${target.text}.${name}`, STATIC[`${target.text}.${name}`]);
      } else {
        const root = rootIdentifier(target);
        const module = root === undefined ? undefined : moduleObjects.get(root);
        if (module && MODULE_MEMBERS[module][name] && (ts.isIdentifier(target) || (ts.isPropertyAccessExpression(target) && target.name.text === "promises"))) {
          hit(node, `${target.getText(source)}.${name}`, MODULE_MEMBERS[module][name]);
        }
      }
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && !node.questionDotToken && !node.expression.questionDotToken) {
      const callee = node.expression;
      const name = callee.name.text;
      const receiver = callee.expression;
      if (SET_METHODS.has(name) && !(ts.isIdentifier(receiver) && imported.has(receiver.text))) {
        hit(callee.name, `Set.prototype.${name}`, { since: "22.0.0" });
      } else if (
        ITERATOR_HELPERS.has(name) &&
        ts.isCallExpression(receiver) &&
        ts.isPropertyAccessExpression(receiver.expression) &&
        ITERATOR_SOURCES.has(receiver.expression.name.text) &&
        (receiver.expression.name.text === "matchAll" || receiver.arguments.length === 0)
      ) {
        hit(callee.name, `Iterator.prototype.${name} (on .${receiver.expression.name.text}())`, { since: "22.0.0", fix: "spread into an array first" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const problems = [];
  for (const { node, api, rule } of hits) {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    const escape = [lines[line], line > 0 ? lines[line - 1] : ""].map((l) => ESCAPE.exec(l ?? "")).find(Boolean);
    const where = `${fileName}:${line + 1}:${character + 1}`;
    if (escape && escape[1].replace(/\*\/.*$/, "").trim().length > 0) continue;
    if (escape) {
      problems.push(`${where}: node-floor-ok needs a reason after the colon`);
      continue;
    }
    problems.push(`${where}: ${api} needs Node ${rule.since}${rule.fix ? `; ${rule.fix}` : ""}`);
  }
  return problems;
}

function sourceFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!TEST_DIRS.has(entry.name) && !(current === dir && entry.name === SRC_TEST_SUPPORT)) walk(path);
      } else if (SOURCE_EXTENSIONS.test(entry.name) && !entry.name.endsWith(".d.ts") && !TEST_FILE.test(entry.name)) {
        files.push(path);
      }
    }
  };
  walk(dir);
  return files.sort();
}

function workspaceDirs(root) {
  const { workspaces = [] } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const patterns = Array.isArray(workspaces) ? workspaces : workspaces.packages ?? [];
  return patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [join(root, pattern)];
    const parent = join(root, pattern.slice(0, -2));
    try {
      return readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(parent, e.name));
    } catch {
      return [];
    }
  });
}

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Checks every Node-20 workspace package under `root`; returns { packages, files, problems }. */
export function checkWorkspace(root) {
  const packages = [];
  const problems = [];
  let files = 0;
  for (const dir of workspaceDirs(root)) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const range = pkg.engines?.node;
    if (range === undefined) continue;
    const floor = rangeFloor(range);
    if (!floor) {
      problems.push(`${relative(root, join(dir, "package.json"))}: can't read engines.node ${JSON.stringify(range)}`);
      continue;
    }
    if (floor[0] > 20 || !isDirectory(join(dir, "src"))) continue;
    packages.push(`${pkg.name} (node ${range})`);
    for (const file of sourceFiles(join(dir, "src"))) {
      const path = relative(root, file);
      if (BROWSER_ONLY.some((prefix) => path.startsWith(prefix))) continue;
      files += 1;
      problems.push(...checkSource(readFileSync(file, "utf8"), path, floor).map((p) => `${p} (${pkg.name} supports node ${range})`));
    }
  }
  return { packages, files, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)));
  const { packages, files, problems } = checkWorkspace(root);
  for (const problem of problems) console.error(problem);
  console.log(`Checked ${files} source files in ${packages.length} packages: ${packages.join(", ")}`);
  if (problems.length > 0) {
    console.error(`${problems.length} use(s) of APIs newer than the package's Node floor. Escape a safe one with // node-floor-ok: <reason>`);
    process.exit(1);
  }
}
