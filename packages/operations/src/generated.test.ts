import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(sourceDirectory, "..");
const catalogPath = resolve(packageDirectory, "generated/operations.json");

type CatalogOperation = {
  id: string;
  version: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  result: Record<string, unknown>;
  effects: readonly string[];
  postures: readonly string[];
  exposure: Record<string, unknown>;
  sensitivity: { input: boolean; output: boolean };
  stableErrors: readonly string[];
  authority: { dynamic: boolean };
};

async function runGenerator(...arguments_: readonly string[]): Promise<number> {
  const process = Bun.spawn({
    cmd: ["bun", "scripts/generate.ts", ...arguments_],
    cwd: packageDirectory,
    stdout: "ignore",
    stderr: "ignore",
  });

  return process.exited;
}

test("generated authority results require the complete strict request artifact", async () => {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
    operations: CatalogOperation[];
  };
  const resultSchema = catalog.operations.find((operation) =>
    operation.id === "tinycloud.secrets.get"
  )!.result as { $defs: Record<string, Record<string, unknown>> };
  const requestSchema = resultSchema.$defs.permissionRequest;

  expect(requestSchema).not.toHaveProperty("anyOf");
  expect(requestSchema.additionalProperties).toBe(false);
  expect(requestSchema.required).toEqual([
    "kind",
    "version",
    "requestId",
    "createdAt",
    "profile",
    "posture",
    "operatorType",
    "host",
    "sessionDid",
    "requested",
  ]);
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
