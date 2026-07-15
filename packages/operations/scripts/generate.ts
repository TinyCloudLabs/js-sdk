import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  OperationDefinition,
  OperationEffect,
  OperationExposure,
  TinyCloudPosture,
} from "../src/contract.js";
import { OPERATION_ERROR_CODES, type OperationErrorCode } from "../src/errors.js";
import { operationDefinitionsForCatalog } from "../src/registry.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const catalogPath = resolve(scriptDirectory, "../generated/operations.json");

type JsonSchema = Readonly<Record<string, unknown>>;

interface CatalogOperation {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
  readonly postures: readonly TinyCloudPosture[];
  readonly effects: readonly OperationEffect[];
  readonly sensitivity: Readonly<{
    input: boolean;
    output: boolean;
  }>;
  readonly exposure: OperationExposure;
  readonly stableErrors: readonly OperationErrorCode[];
  readonly authority: Readonly<{
    description?: string;
    dynamic: boolean;
  }>;
}

interface OperationsCatalog {
  readonly schemaVersion: 1;
  readonly stableErrors: readonly OperationErrorCode[];
  readonly operations: readonly CatalogOperation[];
}

function registeredDefinitions(): readonly OperationDefinition<unknown, unknown>[] {
  return operationDefinitionsForCatalog();
}

function toCatalogOperation(
  definition: OperationDefinition<unknown, unknown>,
): CatalogOperation {
  return {
    id: definition.id,
    version: definition.version,
    title: definition.title,
    description: definition.description,
    input: zodToJsonSchema(definition.input, { target: "jsonSchema7" }),
    output: zodToJsonSchema(definition.output, { target: "jsonSchema7" }),
    postures: [...definition.postures],
    effects: [...definition.effects],
    sensitivity: {
      input: definition.sensitivity.input.length > 0,
      output: definition.sensitivity.output.length > 0,
    },
    exposure: definition.exposure,
    stableErrors: [...OPERATION_ERROR_CODES],
    authority: { dynamic: true },
  };
}

function createCatalog(): OperationsCatalog {
  return {
    schemaVersion: 1,
    stableErrors: [...OPERATION_ERROR_CODES],
    operations: registeredDefinitions()
      .map(toCatalogOperation)
      .sort((left, right) =>
        left.id.localeCompare(right.id) || left.version - right.version,
      ),
  };
}

const catalog = `${JSON.stringify(createCatalog(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const existingCatalog = await readFile(catalogPath, "utf8").catch(() => "");
  if (existingCatalog !== catalog) {
    console.error("Generated operations catalog is out of date. Run bun run generate.");
    process.exitCode = 1;
  }
} else {
  await writeFile(catalogPath, catalog);
}
