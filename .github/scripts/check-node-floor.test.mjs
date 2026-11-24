import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { checkSource, checkWorkspace, rangeFloor } from "./check-node-floor.mjs";

const script = fileURLToPath(new URL("./check-node-floor.mjs", import.meta.url));
const NODE_20 = [20, 0, 0];

// Writes a workspace: packages maps a directory under packages/ to { engines, files }.
function withWorkspace(packages, fn) {
  const root = mkdtempSync(join(tmpdir(), "node-floor-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
    for (const [name, { engines, files }] of Object.entries(packages)) {
      const dir = join(root, "packages", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@fx/${name}`, ...(engines ? { engines: { node: engines } } : {}) }));
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const flagged = (text, floor = NODE_20) => checkSource(text, "src/x.ts", floor);

test("flags APIs newer than Node 20.0.0, at their line", () => {
  const cases = [
    ["const d = Promise.withResolvers<void>();", "Promise.withResolvers"],
    ["const all = await Array.fromAsync(gen());", "Array.fromAsync"],
    ["const u = a.union(b);", "Set.prototype.union"],
    ["const ok = a.isDisjointFrom(b);", "Set.prototype.isDisjointFrom"],
    ["const m = process.getBuiltinModule('fs');", "process.getBuiltinModule"],
    ["import { glob } from 'node:fs/promises';", 'glob from "node:fs/promises"'],
    ["import * as fs from 'node:fs';\nfs.glob('*', () => {});", "fs.glob"],
    ["import fs from 'fs';\nawait fs.promises.glob('*');", "fs.promises.glob"],
    ["const it = Iterator.from(source);", "Iterator.from"],
    ["const xs = map.values().map((v) => v * 2);", "Iterator.prototype.map (on .values())"],
    ["const e = RegExp.escape(s);", "RegExp.escape"],
    ["if (Error.isError(e)) {}", "Error.isError"],
    ["await Promise.try(() => f());", "Promise.try"],
    ["Atomics.pause();", "Atomics.pause"],
    ["const url = URL.parse(input);", "URL.parse"],
    ["const g = Object.groupBy(xs, f);", "Object.groupBy"],
    ["const s = AbortSignal.any([a, b]);", "AbortSignal.any"],
    ["const here = import.meta.dirname;", "import.meta.dirname"],
    ["import { styleText } from 'node:util';", 'styleText from "node:util"'],
  ];
  for (const [code, api] of cases) {
    const problems = flagged(`// leading line\n${code}\n`);
    assert.equal(problems.length, 1, `${code}: ${JSON.stringify(problems)}`);
    assert.match(problems[0], new RegExp(`^src/x\\.ts:\\d+:\\d+: ${api.replace(/[.()]/g, "\\$&")} needs Node \\d+\\.\\d+\\.\\d+`));
  }
  assert.match(flagged("\n\nPromise.withResolvers();")[0], /^src\/x\.ts:3:1: /);
});

test("does not flag comments, strings, types, feature detection, the executor form or imported zod", () => {
  const source = `
import { z } from "zod";
// Executor form: Node 20 lacks Promise.withResolvers.
/* URL.parse is Node 20.18 */
const message = "Promise.withResolvers and AbortSignal.any";
type R = ReturnType<typeof Promise.withResolvers>;
const done = new Promise<void>((resolve) => setTimeout(resolve, 1));
const schema = z.union([z.string(), z.number()]).and(z.intersection(a, b));
if (typeof Promise.withResolvers === "function") {}
const parsed = URL.parse?.(input) ?? null;
const builtin = process.getBuiltinModule?.("fs");
const doubled = Object.values(record).map((v) => v * 2);
const list = [...map.values()].map((v) => v);
`;
  assert.deepEqual(flagged(source), []);
});

test("the floor decides: an API at or below it passes", () => {
  assert.equal(flagged("AbortSignal.any([a]);", [20, 3, 0]).length, 0);
  assert.equal(flagged("AbortSignal.any([a]);", [20, 2, 0]).length, 1);
  assert.equal(flagged("URL.parse(x);", [20, 18, 0]).length, 0);
  assert.equal(flagged("Promise.withResolvers();", [22, 0, 0]).length, 0);
});

test("an escape comment needs a reason", () => {
  assert.deepEqual(flagged("// node-floor-ok: only reached on Node 22, after a version check\nPromise.withResolvers();"), []);
  assert.deepEqual(flagged("Promise.withResolvers(); // node-floor-ok: guarded by the caller"), []);
  const bare = flagged("// node-floor-ok:\nPromise.withResolvers();");
  assert.equal(bare.length, 1);
  assert.match(bare[0], /needs a reason/);
  // An escape two lines up does not count.
  assert.equal(flagged("// node-floor-ok: too far\n\nPromise.withResolvers();").length, 1);
});

test("rangeFloor reads the lowest version an engines range allows", () => {
  assert.deepEqual(rangeFloor(">=20"), [20, 0, 0]);
  assert.deepEqual(rangeFloor(">=20.3.0"), [20, 3, 0]);
  assert.deepEqual(rangeFloor("^20.11 || >=22"), [20, 11, 0]);
  assert.deepEqual(rangeFloor("20.x"), [20, 0, 0]);
  assert.equal(rangeFloor("latest"), undefined);
});

const BAD = "export const d = Promise.withResolvers<void>();\n";

test("checks src of packages that allow Node 20, skipping tests, src/test-support and browser-only replica sources", () => {
  withWorkspace({
    cli: {
      engines: ">=20",
      files: {
        "src/index.ts": BAD,
        "src/lib/test-support/helper.ts": BAD,
        "src/index.test.ts": BAD,
        "src/feed/restore.test-helper.ts": BAD,
        "src/test-support/local-node.ts": BAD,
        "src/__tests__/a.ts": BAD,
        "test/a.ts": BAD,
        "scripts/a.ts": BAD,
      },
    },
    replica: {
      engines: ">=20",
      files: { "src/browser/index.ts": BAD, "src/kv-storage/client.ts": BAD, "src/worker.ts": BAD, "src/sqlite/index.ts": BAD },
    },
    vfs: { engines: ">=22", files: { "src/index.ts": BAD } },
    web: { files: { "src/index.ts": BAD } },
  }, (root) => {
    const { problems, packages } = checkWorkspace(root);
    assert.deepEqual(packages.sort(), ["@fx/cli (node >=20)", "@fx/replica (node >=20)"]);
    assert.deepEqual(problems.map((p) => p.split(":")[0]).sort(), [
      "packages/cli/src/index.ts",
      "packages/cli/src/lib/test-support/helper.ts",
      "packages/replica/src/sqlite/index.ts",
    ]);
  });
});

test("the script exits 1 on a hit and 0 on a clean workspace", () => {
  withWorkspace({ cli: { engines: ">=20", files: { "src/index.ts": BAD } } }, (root) => {
    const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /packages\/cli\/src\/index\.ts:1:\d+: Promise\.withResolvers needs Node 22\.0\.0/);
  });
  withWorkspace({ cli: { engines: ">=20", files: { "src/index.ts": "export const d = new Promise<void>((r) => r());\n" } } }, (root) => {
    const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Checked 1 source files in 1 packages/);
  });
});
