import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import { createJsonSchemaValidator, registerTinyCloudTools, type McpStartupSelection } from "./tools.js";
import { MCP_VERSION } from "./version.js";

export const MCP_SERVER_NAME = "tinycloud-mcp";
export { MCP_VERSION } from "./version.js";
export function createTinyCloudMcpServer(selection: McpStartupSelection): McpServer {
  const validator = createJsonSchemaValidator();
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_VERSION },
    { jsonSchemaValidator: validator },
  );
  registerTinyCloudTools(server, selection, validator);
  return server;
}

/** Start the only supported MCP transport: local stdio. */
export function serveTinyCloudMcp(selection: McpStartupSelection): StdioServerHandle {
  return serveStdio(
    () => createTinyCloudMcpServer(selection),
    { onerror: () => writeBoundedDiagnostic("MCP transport error") },
  );
}

function writeBoundedDiagnostic(message: string): void {
  process.stderr.write(`[tinycloud-mcp] ${message}\n`);
}
