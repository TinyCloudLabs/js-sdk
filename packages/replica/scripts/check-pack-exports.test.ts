import { expect, test } from "bun:test";
import { exportTargets, missingExportTargets } from "./check-pack-exports";

const exportsMap = {
  ".": { types: "./dist/index.d.ts", import: "./dist/index.js", require: "./dist/index.cjs" },
  "./browser": { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
  "./package.json": "./package.json",
};

test("collects types, import and require targets and skips ./package.json", () => {
  expect(exportTargets(exportsMap)).toEqual([
    "dist/browser.d.ts",
    "dist/browser.js",
    "dist/index.cjs",
    "dist/index.d.ts",
    "dist/index.js",
  ]);
});

test("names a missing types file", () => {
  const packed = ["dist/index.d.ts", "dist/index.js", "dist/index.cjs", "dist/browser.js", "package.json"];
  expect(missingExportTargets(exportsMap, packed)).toEqual(["dist/browser.d.ts"]);
});

test("passes when every target is packed", () => {
  const packed = exportTargets(exportsMap);
  expect(missingExportTargets(exportsMap, packed)).toEqual([]);
});
