import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const operations = resolve(root, "packages/operations");
const cli = resolve(root, "packages/cli");
const mcp = resolve(root, "packages/mcp");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  }));
  return nested.flat();
}

function fail(message: string): never {
  throw new Error(`Operations/MCP boundary check failed: ${message}`);
}

const operationsManifest = JSON.parse(await readFile(resolve(operations, "package.json"), "utf8")) as Record<string, unknown>;
const forbiddenPackages = ["commander", "@modelcontextprotocol/server", "incur", "chalk", "ora", "open"];
const operationDependencies = Object.keys({
  ...(operationsManifest.dependencies as Record<string, unknown> | undefined),
  ...(operationsManifest.devDependencies as Record<string, unknown> | undefined),
});
for (const forbidden of forbiddenPackages) {
  if (operationDependencies.some((dependency) => dependency === forbidden || dependency.startsWith(`${forbidden}/`))) {
    fail(`operations depends on forbidden projection package ${forbidden}`);
  }
}

const operationSource = (await Promise.all([
  ...await sourceFiles(resolve(operations, "src")),
  ...await sourceFiles(resolve(operations, "scripts")),
].map((path) => readFile(path, "utf8")))).join("\n");
if (/from\s+["'](?:\.\.\/)+cli\//.test(operationSource)) fail("operations imports CLI-relative source");

const migratedCapabilities = ["tinycloud.kv/get", "tinycloud.encryption/decrypt"];
const projectionPaths = [resolve(cli, "src/commands/secrets.ts"), resolve(mcp, "src/tools.ts"), resolve(mcp, "src/results.ts")];
for (const path of projectionPaths) {
  const source = await readFile(path, "utf8");
  for (const capability of migratedCapabilities) {
    if (source.includes(JSON.stringify(capability))) fail(`${path} contains migrated capability literal ${capability}`);
  }
  if (path.startsWith(mcp) && source.includes("@tinycloud/node-sdk")) fail(`${path} calls node-sdk directly`);
  if (/\bconsole\.(?:log|error|warn|debug)\s*\(/.test(source)) fail(`${path} uses generic logging`);
}

const cliSecretSource = await readFile(resolve(cli, "src/commands/secrets.ts"), "utf8");
const adapterStart = cliSecretSource.indexOf("export function invokeCommanderSecretGetAdapter");
const adapterEnd = cliSecretSource.indexOf("function throwCanonicalSecretGetError", adapterStart);
if (adapterStart < 0 || adapterEnd < 0) fail("Commander conformance adapter is not discoverable");
const adapterSource = cliSecretSource.slice(adapterStart, adapterEnd);
if (/\b(?:node|secrets)\s*\.\s*[A-Za-z_$]+\s*\(/.test(adapterSource) || adapterSource.includes("TinyCloudNode")) {
  fail("migrated Commander adapter calls node-sdk directly");
}

const catalog = JSON.parse(await readFile(resolve(operations, "generated/operations.json"), "utf8")) as {
  operations: readonly { id: string; version: number }[];
};
const registered = new Set(catalog.operations.map((operation) => `${operation.id}@${operation.version}`));
for (const path of [resolve(cli, "src/commands/secrets.ts"), resolve(cli, "src/commands/auth.ts"), resolve(mcp, "src/tools.ts")]) {
  const source = await readFile(path, "utf8");
  const references = [
    ...source.matchAll(/invokeOperation\(\s*["'](tinycloud\.[a-z]+\.[a-z]+)["']\s*,\s*(\d+)/g),
    ...source.matchAll(/operationId:\s*["'](tinycloud\.[a-z]+\.[a-z]+)["'][\s\S]{0,120}?operationVersion:\s*(\d+)/g),
  ];
  for (const match of references) {
    const operationId = match[1]!;
    const version = match[2]!;
    if (!registered.has(`${operationId}@${version}`)) fail(`${path} references unregistered ${operationId}@${version}`);
  }
}

for (const [packagePath, name] of [[operations, "operations"], [cli, "CLI"], [mcp, "MCP"]] as const) {
  const manifest = JSON.parse(await readFile(resolve(packagePath, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  if (manifest.engines?.node !== ">=20") fail(`${name} must declare Node >=20`);
}

console.log("Operations, projection, registration, logging, and Node 20 boundary checks passed.");
