import type { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createDiagnosticRuntime, decodeDiagnosticContext, diagnosticClientProvenance, diagnosticId, makeDiagnosticContext } from "@tinycloud/operations/diagnostics";

import { createJsonSchemaValidator, registerTinyCloudTools, type McpStartupSelection } from "./tools.js";
import { MCP_VERSION } from "./version.js";
import { DiagnosticMcpServer } from "./diagnostics.js";

export const MCP_SERVER_NAME = "tinycloud-mcp";
export { MCP_VERSION } from "./version.js";
/** The stdio server is always the local surface. */
export type LocalMcpSelection = Omit<McpStartupSelection, "surface">;

export function createTinyCloudMcpServer(selection: LocalMcpSelection): McpServer {
  const validator = createJsonSchemaValidator();
  const server = new DiagnosticMcpServer(
    { name: MCP_SERVER_NAME, version: MCP_VERSION },
    { jsonSchemaValidator: validator },
  );
  registerTinyCloudTools(server, { ...selection, surface: "local" }, validator);
  return server;
}

/** Start the only supported MCP transport: local stdio. */
export function serveTinyCloudMcp(selection: LocalMcpSelection): StdioServerHandle {
  const context = decodeDiagnosticContext(process.env.TC_DIAGNOSTICS_CONTEXT);
  const runtime = context?.scope === "tc-apps" ? createDiagnosticRuntime({
    source: "mcp_stdio",
    descriptor: { descriptor_id: diagnosticId(), source: "mcp_stdio", package: "@tinycloud/mcp", version: MCP_VERSION,
      ...diagnosticClientProvenance(context) },
  }) : undefined;
  const drain = () => { runtime?.drainSync(); };
  if (runtime !== undefined) process.once("exit", drain);
  const handle = serveStdio(
    () => {
      const server = createTinyCloudMcpServer(selection) as DiagnosticMcpServer;
      if (runtime !== undefined) {
        server.stdioDiagnosticContext = async () => {
          try {
            const binding = await runtime.binding();
            return binding === undefined ? undefined : makeDiagnosticContext(binding, "mcp_stdio", context);
          } catch { return undefined; /* Capture remains fail-open and never initializes a profile. */ }
        };
      }
      return server;
    },
    { onerror: () => writeBoundedDiagnostic("MCP transport error") },
  );
  return {
    async close() {
      try { await handle.close(); } finally {
        process.removeListener("exit", drain);
        await runtime?.close().catch(() => {});
      }
    },
  };
}

function writeBoundedDiagnostic(message: string): void {
  process.stderr.write(`[tinycloud-mcp] ${message}\n`);
}
