import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DiagnosticDeletionError } from "@tinycloud/operations/diagnostics";

import { diagnosticsAdmin } from "./diagnostics-admin.js";
import type { HostedServerEntrypoint } from "./http-server.js";

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.umask(0o077);
  if (arguments_[0] === "diagnostics") {
    const result = await diagnosticsAdmin(arguments_.slice(1));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (arguments_.length !== 0) throw new Error("Invalid command line.");
  // Runtime-selected ESM/CJS sibling: a static import would load business SDK/
  // WASM before offline controls, even when bundled with splitting disabled.
  const entry = typeof __dirname === "string"
    ? pathToFileURL(join(__dirname, "http-server.cjs")).href
    : new URL(import.meta.url.endsWith(".ts") ? "./http-server.ts" : "./http-server.js", import.meta.url).href;
  const server: HostedServerEntrypoint = await import(entry);
  await server.startHostedServer();
}


void main().catch((error) => {
  process.stderr.write(error instanceof DiagnosticDeletionError
    ? `${JSON.stringify({ error: "diagnostic_deletion_incomplete", incomplete: true, message: "Diagnostic deletion incomplete; inspect capture status." })}\n`
    : "[tinycloud-mcp-http] Startup failed.\n");
  process.exitCode = 1;
});
