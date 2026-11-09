import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const packageDirectory = new URL("..", import.meta.url).pathname;
const nodeBinary = process.env.NODE_BINARY ?? "node";
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) =>
    rm(fixture, { recursive: true, force: true })
  ));
});

test("packed ESM and CJS CLI entrypoints print the metadata version directly", async () => {
  const metadata = await Bun.file(new URL("../package.json", import.meta.url)).json() as { version: string };
  for (const entrypoint of ["dist/cli.js", "dist/cli.cjs"]) {
    const result = Bun.spawnSync(["node", `${packageDirectory}/${entrypoint}`, "--version"]);
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe(`${metadata.version}\n`);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
  }
});

test("packed ESM and CJS resolve the exact nested operations catalog", async () => {
  const fixture = await mkdtemp(join(packageDirectory, ".packed-layout-"));
  fixtures.push(fixture);
  const mcpDirectory = join(fixture, "node_modules/@tinycloud/mcp");
  const operationsDirectory = new URL("../../operations", import.meta.url).pathname;
  const nestedOperations = join(mcpDirectory, "node_modules/@tinycloud/operations");
  const hoistedOperations = join(fixture, "node_modules/@tinycloud/operations");

  for (const [source, destination] of [
    [packageDirectory, mcpDirectory],
    [operationsDirectory, nestedOperations],
  ]) {
    await mkdir(destination, { recursive: true });
    const packed = Bun.spawnSync([
      "npm", "pack", "--ignore-scripts", "--json", "--pack-destination", fixture,
    ], { cwd: source });
    expect(packed.exitCode).toBe(0);
    const [{ filename }] = JSON.parse(new TextDecoder().decode(packed.stdout)) as Array<{ filename: string }>;
    const extracted = Bun.spawnSync([
      "tar", "-xzf", join(fixture, filename!), "--strip-components=1", "-C", destination,
    ]);
    expect(extracted.exitCode).toBe(0);
  }

  // A valid but empty hoisted catalog must never replace MCP's nested dependency.
  await mkdir(join(hoistedOperations, "generated"), { recursive: true });
  await writeFile(join(hoistedOperations, "package.json"), JSON.stringify({
    name: "@tinycloud/operations",
    type: "module",
    exports: { "./operations.json": "./generated/operations.json" },
  }));
  await writeFile(
    join(hoistedOperations, "generated/operations.json"),
    JSON.stringify({ stableErrors: [], operations: [] }),
  );
  const probe = join(fixture, "probe.mjs");
  await writeFile(probe, `
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [format, modulePath] = process.argv.slice(2);
const loaded = format === "esm"
  ? await import(pathToFileURL(modulePath).href)
  : createRequire(import.meta.url)(modulePath);
const tools = [];
loaded.registerTinyCloudTools(
  { registerTool(name, definition) { tools.push({ name, title: definition.title }); } },
  { surface: "local", profile: "packed", explicitProfile: true, allowOwnerProfile: false },
  loaded.createJsonSchemaValidator(),
);
process.stdout.write(JSON.stringify(tools));
`);

  const catalog = (await Bun.file(
    new URL("../../operations/generated/operations.json", import.meta.url),
  ).json() as { operations: Array<{ id: string; title: string }> }).operations;
  const titlesByOperation = new Map(catalog.map((operation) => [operation.id, operation.title]));
  const operationByTool: Record<string, string> = {
    tinycloud_status: "tinycloud.status.get",
    tinycloud_auth_status: "tinycloud.auth.status",
    tinycloud_auth_capabilities: "tinycloud.auth.capabilities",
    tinycloud_auth_request: "tinycloud.auth.request",
    tinycloud_auth_read_scope: "tinycloud.auth.read_scope",
    tinycloud_auth_import: "tinycloud.auth.import",
    tinycloud_account_spaces_list: "tinycloud.account.spaces.list",
    tinycloud_account_applications_list: "tinycloud.account.applications.list",
    tinycloud_kv_list: "tinycloud.kv.list",
    tinycloud_kv_get: "tinycloud.kv.get",
    tinycloud_read: "tinycloud.read",
    tinycloud_kv_head: "tinycloud.kv.head",
    tinycloud_kv_put: "tinycloud.kv.put",
    tinycloud_kv_delete: "tinycloud.kv.delete",
    tinycloud_knowledge_list: "tinycloud.knowledge.list",
    tinycloud_knowledge_read: "tinycloud.knowledge.read",
    tinycloud_sql_schema_inspect: "tinycloud.sql.schema.inspect",
    tinycloud_sql_query: "tinycloud.sql.query",
    tinycloud_sql_execute: "tinycloud.sql.execute",
    tinycloud_secrets_get: "tinycloud.secrets.get",
    tinycloud_secrets_status: "tinycloud.secrets.status",
  };
  for (const format of ["esm", "cjs"] as const) {
    const result = Bun.spawnSync([
      nodeBinary, probe, format, join(mcpDirectory, `dist/tools.${format === "esm" ? "js" : "cjs"}`),
    ]);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    const tools = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(tools).toEqual(Object.entries(operationByTool).map(([name, operationId]) => ({
      name, title: titlesByOperation.get(operationId),
    })));
  }
}, 30_000);
