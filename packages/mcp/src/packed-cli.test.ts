import { afterEach, expect, test } from "bun:test";
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  const mcpDist = join(fixture, "node_modules/@tinycloud/mcp/dist");
  const operationsDirectory = new URL("../../operations", import.meta.url).pathname;
  const nestedOperations = join(fixture, "node_modules/@tinycloud/mcp/node_modules/@tinycloud/operations");
  const hoistedOperations = join(fixture, "node_modules/@tinycloud/operations");
  await Promise.all([
    mkdir(mcpDist, { recursive: true }),
    mkdir(join(nestedOperations, "generated"), { recursive: true }),
    mkdir(join(hoistedOperations, "generated"), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(join(packageDirectory, "dist/tools.js"), join(mcpDist, "tools.js")),
    copyFile(join(packageDirectory, "dist/tools.cjs"), join(mcpDist, "tools.cjs")),
    copyFile(join(operationsDirectory, "package.json"), join(nestedOperations, "package.json")),
    copyFile(
      join(operationsDirectory, "generated/operations.json"),
      join(nestedOperations, "generated/operations.json"),
    ),
    cp(join(operationsDirectory, "dist"), join(nestedOperations, "dist"), { recursive: true }),
    writeFile(join(hoistedOperations, "package.json"), JSON.stringify({
      name: "@tinycloud/operations",
      type: "module",
      exports: { "./operations.json": "./generated/operations.json" },
    })),
    writeFile(
      join(hoistedOperations, "generated/operations.json"),
      JSON.stringify({ operations: [] }),
    ),
  ]);

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
  { profile: "packed", explicitProfile: true, allowOwnerProfile: false },
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
    tinycloud_auth_import: "tinycloud.auth.import",
    tinycloud_secrets_get: "tinycloud.secrets.get",
  };
  for (const format of ["esm", "cjs"] as const) {
    const result = Bun.spawnSync([
      nodeBinary,
      probe,
      format,
      join(mcpDist, `tools.${format === "esm" ? "js" : "cjs"}`),
    ]);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    const tools = JSON.parse(new TextDecoder().decode(result.stdout)) as Array<{
      name: string;
      title: string;
    }>;
    expect(tools).toHaveLength(6);
    expect(tools.map((tool) => tool.title)).toEqual(
      tools.map((tool) => titlesByOperation.get(operationByTool[tool.name]!)!),
    );
  }
});
