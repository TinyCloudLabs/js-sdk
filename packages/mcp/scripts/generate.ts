import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const operationsCatalogPath = resolve(packageDirectory, "../operations/generated/operations.json");
const coveragePath = resolve(packageDirectory, "../operations/coverage.json");
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

interface CoverageEntry {
  readonly command: string;
  readonly status: "legacy" | "partially-migrated" | "migrated" | "excluded";
  readonly operationId?: string;
  readonly operationVersion?: number;
  readonly remainingLegacyInputs?: readonly string[];
}

const TOOL_NAMES: Record<string, string> = {
  "tinycloud.status.get": "tinycloud_status",
  "tinycloud.auth.status": "tinycloud_auth_status",
  "tinycloud.auth.capabilities": "tinycloud_auth_capabilities",
  "tinycloud.auth.request": "tinycloud_auth_request",
  "tinycloud.auth.import": "tinycloud_auth_import",
  "tinycloud.account.spaces.list": "tinycloud_account_spaces_list",
  "tinycloud.account.applications.list": "tinycloud_account_applications_list",
  "tinycloud.kv.list": "tinycloud_kv_list",
  "tinycloud.kv.get": "tinycloud_kv_get",
  "tinycloud.kv.head": "tinycloud_kv_head",
  "tinycloud.kv.put": "tinycloud_kv_put",
  "tinycloud.kv.delete": "tinycloud_kv_delete",
  "tinycloud.sql.schema.inspect": "tinycloud_sql_schema_inspect",
  "tinycloud.sql.query": "tinycloud_sql_query",
  "tinycloud.sql.execute": "tinycloud_sql_execute",
  "tinycloud.secrets.get": "tinycloud_secrets_get",
};

const catalog = JSON.parse(await readFile(operationsCatalogPath, "utf8")) as OperationsCatalog;
const coverage = JSON.parse(await readFile(coveragePath, "utf8")) as { commands: readonly CoverageEntry[] };
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
const counts = new Map<string, number>();
for (const entry of coverage.commands) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
const generatedCoverageBlock = [
  "<!-- BEGIN GENERATED TINYCloud operations coverage -->",
  "Coverage is generated from the Commander registration ledger; legacy commands are not MCP tools.",
  "",
  `- ${counts.get("migrated") ?? 0} migrated registration(s).`,
  `- ${counts.get("partially-migrated") ?? 0} partially migrated registration(s).`,
  `- ${counts.get("legacy") ?? 0} legacy registration(s) remain Commander-owned.`,
  ...coverage.commands
    .filter((entry) => entry.status === "migrated" || entry.status === "partially-migrated")
    .map((entry) => `- \`${entry.command}\` → \`${entry.operationId}@${entry.operationVersion}\` (${entry.status}${entry.remainingLegacyInputs ? `; remaining legacy inputs: ${entry.remainingLegacyInputs.join(", ")}` : ""}).`),
  "<!-- END GENERATED TINYCloud operations coverage -->",
].join("\n");

const existingSkill = await readFile(skillPath, "utf8");
const blockPattern = /<!-- BEGIN GENERATED TINYCloud operation facts -->[\s\S]*?<!-- END GENERATED TINYCloud operation facts -->/;
const coveragePattern = /<!-- BEGIN GENERATED TINYCloud operations coverage -->[\s\S]*?<!-- END GENERATED TINYCloud operations coverage -->/;
if (!blockPattern.test(existingSkill)) throw new Error("Skill is missing its generated facts markers.");
if (!coveragePattern.test(existingSkill)) throw new Error("Skill is missing its generated coverage markers.");
const generatedSkill = `${existingSkill.replace(blockPattern, generatedBlock).replace(coveragePattern, generatedCoverageBlock).trimEnd()}\n`;

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
