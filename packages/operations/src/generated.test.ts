import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

import { OPERATION_ERROR_CODES } from "./errors.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(sourceDirectory, "..");
const catalogPath = resolve(packageDirectory, "generated/operations.json");
const generatorPath = resolve(packageDirectory, "scripts/generate.ts");

async function runGenerator(...arguments_: readonly string[]): Promise<number> {
  const process = Bun.spawn({
    cmd: ["bun", "scripts/generate.ts", ...arguments_],
    cwd: packageDirectory,
    stdout: "ignore",
    stderr: "ignore",
  });

  return process.exited;
}

test("the I1 catalog is generated from internal registry material", async () => {
  const generator = await readFile(generatorPath, "utf8");

  expect(generator).toContain('from "../src/registry.ts"');
  expect(generator).not.toContain('from "../src/index.ts"');
});

test("the empty I1 catalog has the stable schema required by later operations", async () => {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
    schemaVersion: number;
    stableErrors: readonly string[];
    operations: readonly unknown[];
  };

  expect(catalog).toEqual({
    schemaVersion: 1,
    stableErrors: OPERATION_ERROR_CODES,
    operations: [],
  });
});

test("generation is byte-identical and generated checks do not repair drift", async () => {
  const original = await readFile(catalogPath, "utf8");

  try {
    expect(await runGenerator()).toBe(0);
    const firstGeneration = await readFile(catalogPath, "utf8");

    expect(await runGenerator()).toBe(0);
    expect(await readFile(catalogPath, "utf8")).toBe(firstGeneration);

    const driftedCatalog = `${firstGeneration} `;
    await writeFile(catalogPath, driftedCatalog);

    expect(await runGenerator("--check")).toBe(1);
    expect(await readFile(catalogPath, "utf8")).toBe(driftedCatalog);
  } finally {
    await writeFile(catalogPath, original);
  }
});
