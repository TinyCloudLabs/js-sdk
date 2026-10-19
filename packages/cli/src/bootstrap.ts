import { firstCommandIndex } from "./command-token.js";
import { initializeCliDiagnostics } from "./lib/diagnostics.js";
import type * as DiagnosticsEntry from "./diagnostics-entry.js";

const args = process.argv.slice(2);
const commandIndex = firstCommandIndex(args);
// Keep both graphs truly lazy in the published bundle, including WASM/auth.
const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
if (args[commandIndex] === "diagnostics") {
  const entry = await load(new URL("./diagnostics-entry.js", import.meta.url).href) as typeof DiagnosticsEntry;
  await entry.runDiagnostics(args);
} else {
  initializeCliDiagnostics();
  // Startup retains native failures. Capture begins only after a command
  // accepts a tc-apps target or approval request.
  await load(new URL("./index.js", import.meta.url).href);
}
