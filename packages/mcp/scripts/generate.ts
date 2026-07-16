import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const operationsCatalogPath = resolve(packageDirectory, "../operations/generated/operations.json");
const factsPath = resolve(packageDirectory, "generated/mcp-facts.json");
const skillPath = resolve(packageDirectory, "skills/tinycloud-delegated-secrets/SKILL.md");

interface CatalogOperation {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly effects: readonly string[];
  readonly postures: readonly string[];
  readonly sensitivity: { readonly input: boolean; readonly output: boolean };
}

interface OperationsCatalog {
  readonly operations: readonly CatalogOperation[];
}

const TOOL_NAMES: Record<string, string> = {
  "tinycloud.status.get": "tinycloud_status",
  "tinycloud.auth.status": "tinycloud_auth_status",
  "tinycloud.auth.capabilities": "tinycloud_auth_capabilities",
  "tinycloud.auth.request": "tinycloud_auth_request",
  "tinycloud.auth.import": "tinycloud_auth_import",
  "tinycloud.secrets.get": "tinycloud_secrets_get",
};

const catalog = JSON.parse(await readFile(operationsCatalogPath, "utf8")) as OperationsCatalog;
const operations = [...catalog.operations].sort((left, right) =>
  left.id.localeCompare(right.id) || left.version - right.version,
);
const facts = {
  schemaVersion: 1,
  tools: operations.map((operation) => ({
    name: TOOL_NAMES[operation.id] ?? operation.id,
    operationId: operation.id,
    operationVersion: operation.version,
    effects: operation.effects,
    postures: operation.postures,
    sensitiveOutput: operation.sensitivity.output,
  })),
};
const serializedFacts = `${JSON.stringify(facts, null, 2)}\n`;
const generatedBlock = [
  "<!-- BEGIN GENERATED TINYCloud operation facts -->",
  "The following facts are generated from `@tinycloud/operations/operations.json`:",
  "",
  ...operations.map((operation) =>
    `- \`${TOOL_NAMES[operation.id] ?? operation.id}\` -> \`${operation.id}@${operation.version}\`; effects: ${operation.effects.join(", ")}; postures: ${operation.postures.join(", ")}; sensitive output: ${operation.sensitivity.output ? "yes" : "no"}.`,
  ),
  "<!-- END GENERATED TINYCloud operation facts -->",
].join("\n");

const existingSkill = await readFile(skillPath, "utf8");
const blockPattern = /<!-- BEGIN GENERATED TINYCloud operation facts -->[\s\S]*?<!-- END GENERATED TINYCloud operation facts -->/;
if (!blockPattern.test(existingSkill)) throw new Error("Skill is missing its generated facts markers.");
const generatedSkill = `${existingSkill.replace(blockPattern, generatedBlock).trimEnd()}\n`;

if (process.argv.includes("--check")) {
  const [existingFacts, currentSkill] = await Promise.all([
    readFile(factsPath, "utf8").catch(() => ""),
    readFile(skillPath, "utf8"),
  ]);
  if (existingFacts !== serializedFacts || currentSkill !== generatedSkill) {
    console.error("Generated MCP facts or skill block is out of date. Run bun run generate.");
    process.exitCode = 1;
  }
} else {
  await writeFile(factsPath, serializedFacts, "utf8");
  await writeFile(skillPath, generatedSkill, "utf8");
}
