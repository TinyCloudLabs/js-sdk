import { enterDiagnosticContext, emitDiagnostic } from "@tinycloud/operations/diagnostics";
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
  const context = await initializeCliDiagnostics();
  if (context) enterDiagnosticContext(context);
  emitDiagnostic({ type: "phase.start", phase: "import" });
  // Unhandled import errors retain Node's original reporting and exit status;
  // the synchronous exit observer records whichever boundary was reached.
  await load(new URL("./index.js", import.meta.url).href);
}
