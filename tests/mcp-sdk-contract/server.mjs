import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Ajv, AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { inputJsonSchema, outputJsonSchema, inputSchema, outputSchema } from "./schema.mjs";

function createServer() {
  const validator = new AjvJsonSchemaValidator(new Ajv({ strict: false }));
  const server = new McpServer({ name: "tinycloud-mcp-sdk-contract", version: "0.0.0" }, {
    jsonSchemaValidator: validator,
  });
  server.registerTool(
    "contract_echo",
    {
      description: "I0 MCP SDK contract fixture",
      inputSchema: fromJsonSchema(inputJsonSchema, validator),
      outputSchema: fromJsonSchema(outputJsonSchema, validator),
    },
    async (input) => {
      const parsed = inputSchema.parse(input);
      const output = outputSchema.parse({
        status: "ok",
        selected: parsed.target.kind === "secret" ? parsed.target.name : parsed.target.space,
        ...(parsed.includeMetadata ? { metadata: { source: "mcp-sdk-contract" } } : {}),
      });
      return {
        content: [{ type: "text", text: "contract tool completed" }],
        structuredContent: output,
      };
    },
  );
  return server;
}

serveStdio(createServer, {
  onerror: (error) => process.stderr.write(`[mcp-sdk-contract] ${error.message}\n`),
});
