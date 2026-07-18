import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

import { OPERATION_ERROR_CODES } from "./errors.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(sourceDirectory, "..");
const catalogPath = resolve(packageDirectory, "generated/operations.json");
const generatorPath = resolve(packageDirectory, "scripts/generate.ts");

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

test("the catalog is generated from internal registry material", async () => {
  const generator = await readFile(generatorPath, "utf8");

  expect(generator).toContain('from "../src/registry.js"');
  expect(generator).not.toContain('from "../src/index.ts"');
});

test("the catalog contains exactly the registered v1 definitions", async () => {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
    schemaVersion: number;
    stableErrors: readonly string[];
    operations: CatalogOperation[];
  };

  expect(catalog.schemaVersion).toBe(1);
  expect(catalog.stableErrors).toEqual(OPERATION_ERROR_CODES);
  expect(catalog.operations.map((operation) => `${operation.id}@${operation.version}`)).toEqual([
    "tinycloud.account.applications.list@1",
    "tinycloud.account.spaces.list@1",
    "tinycloud.auth.capabilities@1",
    "tinycloud.auth.import@1",
    "tinycloud.auth.request@1",
    "tinycloud.auth.status@1",
    "tinycloud.kv.delete@1",
    "tinycloud.kv.get@1",
    "tinycloud.kv.head@1",
    "tinycloud.kv.list@1",
    "tinycloud.kv.put@1",
    "tinycloud.secrets.get@1",
    "tinycloud.sql.query@1",
    "tinycloud.sql.schema.inspect@1",
    "tinycloud.status.get@1",
  ]);
  expect(new Set(catalog.operations.map((operation) => operation.id)).size).toBe(15);
  expect(catalog.operations).toHaveLength(15);

  for (const operation of catalog.operations) {
    expect(operation.input).toBeDefined();
    expect(operation.output).toBeDefined();
    expect(operation.output.additionalProperties).toBe(false);
    expect(operation.result).toBeDefined();
    expect(operation.result.anyOf).toHaveLength(4);
    expect(operation.effects.length).toBeGreaterThan(0);
    expect(operation.postures.length).toBeGreaterThan(0);
    expect(Object.keys(operation.exposure).sort()).toEqual(["cli", "docs", "mcp", "skill"]);
    expect(operation.sensitivity).toBeDefined();
    expect(operation.stableErrors).toEqual(OPERATION_ERROR_CODES);
    expect(operation.authority).toEqual({ dynamic: true });
  }

  const byId = new Map(catalog.operations.map((operation) => [operation.id, operation]));
  for (const operationId of ["tinycloud.auth.capabilities", "tinycloud.auth.status", "tinycloud.status.get"]) {
    expect(byId.get(operationId)?.input.additionalProperties).toBe(false);
  }
  expect(byId.get("tinycloud.auth.import")?.input.additionalProperties).toBe(false);
  const requestInput = byId.get("tinycloud.auth.request")?.input.anyOf as Array<Record<string, unknown>>;
  expect(requestInput).toHaveLength(2);
  expect(requestInput.every((branch) => branch.additionalProperties === false)).toBe(true);

  const secretGet = byId.get("tinycloud.secrets.get");
  expect(secretGet?.sensitivity).toEqual({ input: false, output: true });
  expect(secretGet?.effects).toEqual(["read", "local_write"]);
});

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
