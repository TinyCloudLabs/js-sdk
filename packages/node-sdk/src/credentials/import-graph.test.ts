import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

// Static import graph of the browser-safe credential driver. Type-only imports
// are erased and skipped; bare specifiers are reported as externals.

const SRC = resolve(import.meta.dir, "..");
const NODE_BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));
// The only Node built-ins the browser-safe `./credentials` graph may reference.
const ALLOWED_BUILTINS = new Set(["buffer", "crypto"]);

interface Graph {
  readonly files: ReadonlySet<string>;
  readonly externals: ReadonlySet<string>;
}

function resolveRelative(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`unresolved relative import ${spec} from ${fromFile}`);
}

function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (stmt.importClause?.isTypeOnly) continue;
      specs.push((stmt.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      if (stmt.isTypeOnly) continue;
      specs.push((stmt.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return specs;
}

function walk(entry: string): Graph {
  const files = new Set<string>();
  const externals = new Set<string>();
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    for (const spec of runtimeSpecifiers(file)) {
      if (spec.startsWith(".")) queue.push(resolveRelative(file, spec));
      else externals.add(spec);
    }
  }
  return { files, externals };
}

function nodeBuiltinExternals(externals: ReadonlySet<string>): string[] {
  return [...externals]
    .map((spec) => spec.replace(/^node:/, ""))
    .filter((spec) => NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(spec.split("/")[0]));
}

const rel = (file: string) => relative(SRC, file);

describe("browser-safe credential import graph", () => {
  test("./credentials graph references only buffer and crypto as Node built-ins", () => {
    const graph = walk(resolve(SRC, "credentials/index.ts"));
    const offending = nodeBuiltinExternals(graph.externals).filter((spec) => !ALLOWED_BUILTINS.has(spec));
    expect(offending).toEqual([]);
  });

  test("./credentials graph never reaches the node file store", () => {
    const graph = walk(resolve(SRC, "credentials/index.ts"));
    expect([...graph.files].map(rel)).not.toContain("credential-pending-store.ts");
  });

  test("narrow credentials-core graph excludes email-proof, store, and the full barrel", () => {
    const files = [...walk(resolve(SRC, "credentials/core.ts")).files].map(rel);
    expect(files).toContain("credentials/interpreter.ts");
    expect(files).toContain("credentials/transport.ts");
    expect(files).not.toContain("credentials/email-proof.ts");
    expect(files).not.toContain("credential-pending-store.ts");
    expect(files).not.toContain("credentials/index.ts");
  });
});
