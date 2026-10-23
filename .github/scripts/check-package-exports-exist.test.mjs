import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { checkExports } from "./check-package-exports-exist.mjs";

const script = fileURLToPath(new URL("./check-package-exports-exist.mjs", import.meta.url));

// Writes a package with the given `exports` and files (path -> content).
function fixture(exports, files) {
  const dir = mkdtempSync(join(tmpdir(), "exports-exist-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fx", exports }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const withFixture = (exports, files, fn) => {
  const dir = fixture(exports, files);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const exportsMap = {
  ".": { types: "./dist/index.d.ts", import: "./dist/index.mjs", require: "./dist/index.cjs", default: "./dist/index.mjs" },
  "./sub": { types: "./dist/sub.d.ts", import: "./dist/sub.mjs" },
  "./package.json": "./package.json",
};
const allFiles = {
  "dist/index.d.ts": "x",
  "dist/index.mjs": "x",
  "dist/index.cjs": "x",
  "dist/sub.d.ts": "x",
  "dist/sub.mjs": "x",
};

test("passes when every target exists and is non-empty", () => {
  withFixture(exportsMap, allFiles, (dir) => {
    const r = checkExports(dir);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.checked.sort(), [
      "./dist/index.cjs", "./dist/index.d.ts", "./dist/index.mjs", "./dist/index.mjs",
      "./dist/sub.d.ts", "./dist/sub.mjs", "./package.json",
    ]);
  });
});

test("one missing types file fails and names the subpath, condition and file", () => {
  const { "dist/sub.d.ts": _, ...files } = allFiles;
  withFixture(exportsMap, files, (dir) => {
    const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /exports\["\.\/sub"\]\["types"\]: \.\/dist\/sub\.d\.ts is missing or empty/);
    assert.equal((r.stderr.match(/is missing or empty/g) ?? []).length, 2); // ::error line + summary line, one problem
  });
});

test("reports every missing path, not just the first", () => {
  withFixture(exportsMap, { "dist/index.mjs": "x" }, (dir) => {
    const { problems } = checkExports(dir);
    assert.deepEqual(problems.map((p) => p.split(": ")[1].split(" ")[0]).sort(), [
      "./dist/index.cjs", "./dist/index.d.ts", "./dist/sub.d.ts", "./dist/sub.mjs",
    ]);
  });
});

test("an empty file counts as missing", () => {
  withFixture({ ".": "./dist/index.js" }, { "dist/index.js": "" }, (dir) => {
    assert.equal(checkExports(dir).problems.length, 1);
  });
});

test("a directory is not a valid target", () => {
  withFixture({ ".": "./dist" }, { "dist/index.js": "x" }, (dir) => {
    assert.equal(checkExports(dir).problems.length, 1);
  });
});

test("nested conditions and fallback arrays are walked", () => {
  const nested = {
    ".": {
      node: { import: "./a.mjs", require: "./a.cjs" },
      browser: { development: { default: "./deep.js" } },
      default: ["./fallback-1.js", "./fallback-2.js"],
      excluded: null,
    },
  };
  withFixture(nested, { "a.mjs": "x", "a.cjs": "x", "deep.js": "x", "fallback-1.js": "x" }, (dir) => {
    const { problems } = checkExports(dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /exports\["\."\]\["default"\]\[1\]: \.\/fallback-2\.js/);
  });
  withFixture(nested, { "a.mjs": "x", "a.cjs": "x", "fallback-1.js": "x", "fallback-2.js": "x" }, (dir) => {
    const { problems } = checkExports(dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /\["browser"\]\["development"\]\["default"\]: \.\/deep\.js/);
  });
});

test("string-form and array-form `exports` are handled", () => {
  withFixture("./index.js", {}, (dir) => assert.equal(checkExports(dir).problems.length, 1));
  withFixture("./index.js", { "index.js": "x" }, (dir) => assert.deepEqual(checkExports(dir).problems, []));
});

test("wildcard targets are skipped, not checked, and reported as skipped", () => {
  withFixture({ "./*": "./dist/*.js", ".": "./dist/index.js" }, { "dist/index.js": "x" }, (dir) => {
    const r = checkExports(dir);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.skipped.map((s) => s.target), ["./dist/*.js"]);
    assert.deepEqual(r.checked, ["./dist/index.js"]);
  });
});

test("targets that are not ./-relative or escape the package are problems", () => {
  withFixture({ ".": "dist/index.js", "./x": "./../outside.js" }, {}, (dir) => {
    const { problems } = checkExports(dir);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /not a "\.\/" relative path/);
    assert.match(problems[1], /escapes the package directory/);
  });
});

test("a package with no exports field fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "exports-exist-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fx" }));
    assert.match(checkExports(dir).problems[0], /no `exports` field/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: exits 0 on success and 2 without a directory", () => {
  withFixture({ ".": "./i.js" }, { "i.js": "x" }, (dir) => {
    assert.equal(spawnSync(process.execPath, [script, dir]).status, 0);
  });
  assert.equal(spawnSync(process.execPath, [script]).status, 2);
});
