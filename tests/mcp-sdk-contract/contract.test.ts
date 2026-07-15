import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv, AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { inputJsonSchema, outputJsonSchema } from "./schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "server.mjs");
const MCP_VERSION = "2.0.0-beta.4";
const NODE_MAJOR = 20;
const NODE = process.env.NODE_BINARY ?? "node";

async function findInstalledPackageRoot(packageName: string) {
  let current = dirname(fileURLToPath(import.meta.resolve(packageName)));

  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
      if (manifest.name === packageName) return { directory: current, manifest };
    } catch {
      // Package entry points commonly live below their package root.
    }

    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not find installed package root for ${packageName}`);
    current = parent;
  }
}

test("generates optional fields, a discriminated union, and an output schema", () => {
  expect(inputJsonSchema.type).toBe("object");
  expect(inputJsonSchema.required).toEqual(["target"]);
  expect(inputJsonSchema.properties.requestId).toBeDefined();
  expect(inputJsonSchema.properties.includeMetadata).toBeDefined();
  expect(inputJsonSchema.properties.target.anyOf).toHaveLength(2);
  expect(inputJsonSchema.properties.target.anyOf.map((variant) => variant.properties.kind.const)).toEqual(["secret", "space"]);
  expect(outputJsonSchema.required).toEqual(["status", "selected"]);
  expect(outputJsonSchema.properties.metadata).toBeDefined();
});

test("registers the generated schemas through fromJsonSchema and runs over official stdio", async () => {
  const transport = new StdioClientTransport({
    command: NODE,
    args: [SERVER],
    cwd: HERE,
    stderr: "pipe",
  });
  const client = new Client({ name: "tinycloud-mcp-sdk-contract-test", version: "0.0.0" }, {
    jsonSchemaValidator: new AjvJsonSchemaValidator(new Ajv({ strict: false })),
  });
  const stderr = transport.stderr;
  let stderrText = "";
  stderr?.on("data", (chunk) => { stderrText += String(chunk); });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]?.name).toBe("contract_echo");
    expect(listed.tools[0]?.inputSchema).toEqual(inputJsonSchema);
    expect(listed.tools[0]?.outputSchema).toEqual(outputJsonSchema);

    const result = await client.callTool({
      name: "contract_echo",
      arguments: {
        requestId: "req_contract",
        target: { kind: "secret", name: "ANTHROPIC_API_KEY" },
        includeMetadata: true,
      },
    });
    expect(result.structuredContent).toEqual({
      status: "ok",
      selected: "ANTHROPIC_API_KEY",
      metadata: { source: "mcp-sdk-contract", nodeMajor: NODE_MAJOR },
    });
    expect(result.content).toEqual([{ type: "text", text: "contract tool completed" }]);
    expect(JSON.stringify(result.content)).not.toContain("ANTHROPIC_API_KEY");
  } finally {
    await client.close();
  }

  expect(stderrText).not.toContain("ANTHROPIC_API_KEY");
});

test("server stdout contains protocol messages only", async () => {
  const child = spawn(NODE, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const toolsListed = new Promise<void>((resolve, reject) => {
    // The fixture is entirely local; this only allows for CI process scheduling.
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for tools/list response")), 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      for (const line of stdout.split("\n").filter(Boolean)) {
        try {
          if (JSON.parse(line).id === 2) {
            clearTimeout(timeout);
            resolve();
            return;
          }
        } catch {
          // A partial final line is completed by the next stdout chunk.
        }
      }
    });
  });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw-contract-test", version: "0.0.0" },
      },
    }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    await toolsListed;
  } finally {
    child.kill();
    await once(child, "close");
  }

  const lines = stdout.trim().split("\n").filter(Boolean);
  expect(lines.length).toBeGreaterThanOrEqual(2);
  for (const line of lines) {
    expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
  }
  expect(stderr).not.toContain("ANTHROPIC_API_KEY");
});

test("packed candidate packages retain the Node 20 engine requirement", async () => {
  const destination = await mkdtemp(join(tmpdir(), "tc-mcp-pack-"));
  try {
    for (const packageName of ["@modelcontextprotocol/server", "@modelcontextprotocol/client"]) {
      const installed = await findInstalledPackageRoot(packageName);
      expect(installed.manifest.version).toBe(MCP_VERSION);
      const packed = spawnSync("npm", ["pack", installed.directory, "--pack-destination", destination], {
        cwd: HERE,
        encoding: "utf8",
      });
      expect(packed.status, packed.stderr).toBe(0);
      const filename = packed.stdout.trim().split("\n").at(-1)!;
      const metadata = spawnSync("tar", ["-xOf", join(destination, filename), "package/package.json"], {
        encoding: "utf8",
      });
      expect(metadata.status, metadata.stderr).toBe(0);
      expect(JSON.parse(metadata.stdout).engines.node).toBe(">=20");
    }
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});
