#!/usr/bin/env node
// Fails on JavaScript and Node APIs that are newer than a package's Node floor
// (TC-4279). `bun test` runs in-process code under Bun, which has all of them,
// so a call like `Promise.withResolvers()` passes the tests and then throws on
// a user's Node 20.
//
//   node .github/scripts/check-node-floor.mjs [workspace-root]
//
// Which packages, at which floor:
// - Every workspace package (root package.json `workspaces`) with
//   `engines.node`: the floor is the lowest version the range allows, so ">=20"
//   is 20.0.0 and an API Node 20 gained in a minor release (URL.parse in
//   20.18.0) is flagged too.
// - A workspace package without `engines` that other workspace packages
//   depend on at runtime (`dependencies`, `peerDependencies`,
//   `optionalDependencies`) runs inside them, so it inherits the lowest floor
//   among those dependents, transitively (share-envelope runs in the cli).
//   One with no such dependent (web-sdk, the apps) has no Node floor and is
//   skipped. devDependencies don't count: a package bundled from one (the cli
//   bundles courier and replica) declares its own engines.
// - Only floors below Node 21 are checked.
// In each, `src/` is checked except tests (`*.test.*`, `*.spec.*`,
// `*.test-helper.*`, `test/`, `tests/`, `__tests__/`, `src/test-support/`) and
// the browser-only sources in BROWSER_ONLY. Sources are parsed with
// TypeScript, so comments, strings and type positions never match.
//
// Feature detection is allowed: `typeof X.y` and the optional call `X.y?.(…)`
// are not flagged (`X?.y()` is: it still throws when X exists). Anything else
// needs an escape comment, which covers exactly the next line:
//   // node-floor-ok: <why this is safe on the floor>
//   const signal = AbortSignal.any([a, b]);
// The escape is a comment that starts with `node-floor-ok:`; one with no
// reason is itself an error.
//
// Known limits, not detected: `globalThis.X.y` and `X["y"]`; an API reached
// through an alias (`const P = Promise; P.withResolvers()`), `require()` or a
// dynamic `import()`; iterator helpers on an iterator held in a variable (only
// a direct `.values()`, `.keys()`, `.entries()` or `.matchAll()` result is
// checked); `require(esm)`, which depends on the target module. Set and
// ArrayBuffer methods are matched by name, whatever the receiver's type,
// except on an imported binding (zod's `z.union`).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The first Node release with each API, including a backport to a 20.x minor:
// from the Node docs `added:` history, each probed on Node binaries just below
// and at that version (20.0.0, 20.4.0, 20.5.x, 20.6.0, 20.14.0 to 20.17.0,
// 20.20.2, 21.0.0, 21.7.3, 22.0.0, 22.23.2, 24.0.0).
// Every lookup table has a null prototype, so a name like `constructor` never matches.
const STATIC = {
  __proto__: null,
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
  "ReadableStream.from": { since: "20.6.0" },
  "process.getBuiltinModule": { since: "20.16.0" },
  "process.loadEnvFile": { since: "20.12.0" },
};
// Globals, flagged where a value is read from them (`navigator.x`, `new WebSocket()`, `x instanceof WebSocket`),
// unless the file declares or imports the name itself.
const GLOBALS = {
  __proto__: null,
  navigator: { since: "21.0.0" },
  WebSocket: { since: "22.0.0" },
};
const IMPORT_META = {
  __proto__: null,
  dirname: { since: "20.11.0", fix: "use dirname(fileURLToPath(import.meta.url))" },
  filename: { since: "20.11.0", fix: "use fileURLToPath(import.meta.url)" },
  resolve: { since: "20.6.0" },
};
// Members of built-in modules, reached by a named import or through the module object.
const FS_GLOB = { __proto__: null, glob: { since: "22.0.0" }, globSync: { since: "22.0.0" } };
const MODULE_MEMBERS = {
  __proto__: null,
  fs: FS_GLOB,
  "fs/promises": FS_GLOB,
  util: { __proto__: null, styleText: { since: "20.12.0" }, parseEnv: { since: "20.12.0" } },
  crypto: { __proto__: null, hash: { since: "20.12.0", fix: "use createHash()" } },
  process: { __proto__: null, getBuiltinModule: { since: "20.16.0" }, loadEnvFile: { since: "20.12.0" } },
  events: { __proto__: null, addAbortListener: { since: "20.5.0" } },
  zlib: { __proto__: null, crc32: { since: "20.15.0" } },
  path: { __proto__: null, matchesGlob: { since: "20.17.0" } },
};
// Methods matched by name on any receiver except an imported binding (zod's `z.union`, `z.intersection`).
const SET_METHOD = { since: "22.0.0" };
const ARRAY_BUFFER_TRANSFER = { since: "21.0.0" };
const METHODS = {
  __proto__: null,
  union: ["Set.prototype.union", SET_METHOD],
  intersection: ["Set.prototype.intersection", SET_METHOD],
  difference: ["Set.prototype.difference", SET_METHOD],
  symmetricDifference: ["Set.prototype.symmetricDifference", SET_METHOD],
  isSubsetOf: ["Set.prototype.isSubsetOf", SET_METHOD],
  isSupersetOf: ["Set.prototype.isSupersetOf", SET_METHOD],
  isDisjointFrom: ["Set.prototype.isDisjointFrom", SET_METHOD],
  transfer: ["ArrayBuffer.prototype.transfer", ARRAY_BUFFER_TRANSFER],
  transferToFixedLength: ["ArrayBuffer.prototype.transferToFixedLength", ARRAY_BUFFER_TRANSFER],
};
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
const RUNTIME_DEPENDENCIES = ["dependencies", "peerDependencies", "optionalDependencies"];
// The text of a comment, without its delimiters, that is an escape: group 1 is the reason.
const ESCAPE = /^\s*node-floor-ok:(.*)$/s;

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

// `typeof X.y` and `X.y?.()`: the code checks for the API before using it.
function isFeatureDetection(node) {
  const parent = node.parent;
  if (ts.isTypeOfExpression(parent)) return true;
  return ts.isCallExpression(parent) && parent.expression === node && parent.questionDotToken !== undefined;
}

// Whether an identifier reads a value from the global it names (not typeof, a declaration or a property name).
function readsGlobal(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) return parent.expression === node;
  if (ts.isNewExpression(parent) || ts.isCallExpression(parent)) return parent.expression === node;
  return ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.right === node;
}

// Line (0-based) each escape comment covers -> its reason ("" when it has none). Every comment is trivia
// before or after some token, so walking every token's comment ranges finds them all.
function escapeLines(source) {
  const covered = new Map();
  const seen = new Set();
  const text = source.text;
  const record = (pos, end, kind) => {
    if (seen.has(pos)) return;
    seen.add(pos);
    const body = kind === ts.SyntaxKind.SingleLineCommentTrivia ? text.slice(pos + 2, end) : text.slice(pos + 2, end - 2);
    const match = ESCAPE.exec(body);
    if (match) covered.set(source.getLineAndCharacterOfPosition(end).line + 1, match[1].trim());
  };
  const visit = (node) => {
    ts.forEachLeadingCommentRange(text, node.pos, record);
    ts.forEachTrailingCommentRange(text, node.end, record);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return covered;
}

/** Problems in one source file for the given floor ([major, minor, patch]). */
export function checkSource(text, fileName, floor) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const imported = new Set();
  const declared = new Set();
  const moduleObjects = new Map(); // local name -> module name (default, namespace, or `promises`)
  const hits = [];

  const hit = (node, api, rule) => {
    if (compare(parseVersion(rule.since), floor) <= 0) return;
    hits.push({ node, api, rule });
  };

  // First pass: the names this file binds, so a local `navigator` or an imported `z` isn't taken for a global.
  const bind = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.name) imported.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) imported.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) imported.add(element.name.text);
    } else if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isBindingElement(node)) &&
      node.name && ts.isIdentifier(node.name)
    ) {
      declared.add(node.name.text);
    }
    ts.forEachChild(node, bind);
  };
  bind(source);

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = nodeModule(node.moduleSpecifier.text);
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
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
    } else if (ts.isIdentifier(node) && GLOBALS[node.text]) {
      if (readsGlobal(node) && !imported.has(node.text) && !declared.has(node.text)) hit(node, `global ${node.text}`, GLOBALS[node.text]);
    } else if (ts.isPropertyAccessExpression(node) && !isFeatureDetection(node)) {
      const name = node.name.text;
      const target = node.expression;
      if (ts.isMetaProperty(target) && target.keywordToken === ts.SyntaxKind.ImportKeyword && IMPORT_META[name]) {
        hit(node, `import.meta.${name}`, IMPORT_META[name]);
      } else if (ts.isIdentifier(target) && STATIC[`${target.text}.${name}`]) {
        hit(node, `${target.text}.${name}`, STATIC[`${target.text}.${name}`]);
      } else if (METHODS[name]?.[1] === ARRAY_BUFFER_TRANSFER && target.getText(source) === "ArrayBuffer.prototype") {
        hit(node, METHODS[name][0], ARRAY_BUFFER_TRANSFER);
      } else {
        const root = rootIdentifier(target);
        const module = root === undefined ? undefined : moduleObjects.get(root);
        if (module && MODULE_MEMBERS[module][name] && (ts.isIdentifier(target) || (ts.isPropertyAccessExpression(target) && target.name.text === "promises"))) {
          hit(node, `${target.getText(source)}.${name}`, MODULE_MEMBERS[module][name]);
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && !node.questionDotToken) {
      const callee = node.expression;
      const name = callee.name.text;
      const receiver = callee.expression;
      if (Object.hasOwn(METHODS, name) && !(ts.isIdentifier(receiver) && imported.has(receiver.text)) && receiver.getText(source) !== "ArrayBuffer.prototype") {
        hit(callee.name, METHODS[name][0], METHODS[name][1]);
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
  if (hits.length === 0) return [];

  const escapes = escapeLines(source);
  const problems = [];
  for (const { node, api, rule } of hits) {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    const where = `${fileName}:${line + 1}:${character + 1}`;
    const reason = escapes.get(line);
    if (reason) continue;
    if (reason === "") problems.push(`${where}: the node-floor-ok escape on the line above needs a reason after the colon`);
    else problems.push(`${where}: ${api} needs Node ${rule.since}${rule.fix ? `; ${rule.fix}` : ""}`);
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

function workspacePackages(root) {
  const { workspaces = [] } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const patterns = Array.isArray(workspaces) ? workspaces : workspaces.packages ?? [];
  const dirs = patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [join(root, pattern)];
    const parent = join(root, pattern.slice(0, -2));
    try {
      return readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(parent, e.name));
    } catch {
      return [];
    }
  });
  const packages = [];
  for (const dir of dirs) {
    try {
      packages.push({ dir, pkg: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) });
    } catch {
      // Not a package.
    }
  }
  return packages;
}

/**
 * The Node floor of each workspace package: name -> { floor, range, via? }. A package without `engines`
 * inherits the lowest floor among the workspace packages that depend on it at runtime (`via` names that one).
 */
export function packageFloors(packages, root, problems = []) {
  const floors = new Map();
  for (const { dir, pkg } of packages) {
    const range = pkg.engines?.node;
    if (range === undefined) continue;
    const floor = rangeFloor(range);
    if (floor) floors.set(pkg.name, { floor, range });
    else problems.push(`${relative(root, join(dir, "package.json"))}: can't read engines.node ${JSON.stringify(range)}`);
  }
  const unpinned = packages.filter(({ pkg }) => pkg.engines?.node === undefined);
  for (let changed = true; changed;) {
    changed = false;
    for (const { pkg } of unpinned) {
      for (const { pkg: dependent } of packages) {
        const inherited = floors.get(dependent.name);
        if (!inherited || !RUNTIME_DEPENDENCIES.some((field) => dependent[field]?.[pkg.name] !== undefined)) continue;
        const current = floors.get(pkg.name);
        if (current && compare(inherited.floor, current.floor) >= 0) continue;
        floors.set(pkg.name, { floor: inherited.floor, range: inherited.range, via: inherited.via ?? dependent.name });
        changed = true;
      }
    }
  }
  return floors;
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
  const workspace = workspacePackages(root);
  const problems = [];
  const floors = packageFloors(workspace, root, problems);
  const packages = [];
  let files = 0;
  for (const { dir, pkg } of workspace) {
    const entry = floors.get(pkg.name);
    if (!entry || entry.floor[0] > 20 || !isDirectory(join(dir, "src"))) continue;
    const label = entry.via ? `node ${entry.range} via ${entry.via}` : `node ${entry.range}`;
    packages.push(`${pkg.name} (${label})`);
    for (const file of sourceFiles(join(dir, "src"))) {
      const path = relative(root, file);
      if (BROWSER_ONLY.some((prefix) => path.startsWith(prefix))) continue;
      files += 1;
      problems.push(...checkSource(readFileSync(file, "utf8"), path, entry.floor).map((p) => `${p} (${pkg.name} runs on ${label})`));
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
    console.error(`${problems.length} problem(s). Escape a use that is safe on the floor with // node-floor-ok: <reason> on the line above.`);
    process.exit(1);
  }
}
