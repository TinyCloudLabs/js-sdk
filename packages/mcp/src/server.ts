import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import { registerTinyCloudTools, type McpStartupSelection } from "./tools.js";

export const MCP_SERVER_NAME = "tinycloud-mcp";
export const MCP_VERSION = "0.1.0-beta.0";

export function createTinyCloudMcpServer(selection: McpStartupSelection): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_VERSION });
  registerTinyCloudTools(server, selection);
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
