// src/bootstrap.ts
import { enterDiagnosticContext, emitDiagnostic as emitDiagnostic2 } from "@tinycloud/operations/diagnostics";

// src/command-token.ts
function firstCommandIndex(values) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") return index + 1;
    if (value.startsWith("--")) {
      if (value === "--profile" || value === "--host") index += 1;
      continue;
    }
    if (value.length > 1 && value.startsWith("-")) {
      for (let char = 1; char < value.length; char += 1) {
        if (value[char] !== "p" && value[char] !== "H") continue;
        if (char === value.length - 1) index += 1;
        break;
      }
      continue;
    }
    return index;
  }
  return -1;
}

// src/lib/diagnostics.ts
import {
  beginDiagnosticPhase,
  createDiagnosticRuntime,
  decodeDiagnosticContext,
  diagnosticId,
  emitDiagnostic,
  diagnosticClientProvenance,
  getDiagnosticContext,
  makeDiagnosticContext,
  withDiagnosticContext
} from "@tinycloud/operations/diagnostics";
var stateKey = /* @__PURE__ */ Symbol.for("tinycloud.cli.diagnostics.v1");
var globals = globalThis;
async function initializeCliDiagnostics() {
  try {
    globals[stateKey] = {
      started: performance.now(),
      finished: false,
      imported: false,
      parsed: false
    };
    process.once("exit", finishCliDiagnostics);
    const links = decodeDiagnosticContext(process.env.TC_DIAGNOSTICS_CONTEXT);
    if (links?.scope === "tc-apps") {
      return await activate();
    }
  } catch {
  }
}
async function activate(activity) {
  const state = globals[stateKey];
  if (!state || state.finished) return getDiagnosticContext();
  if (state.context) return state.context;
  try {
    const links = decodeDiagnosticContext(process.env.TC_DIAGNOSTICS_CONTEXT);
    state.runtime ??= createDiagnosticRuntime({
      source: "cli",
      descriptor: {
        descriptor_id: diagnosticId(),
        source: "cli",
        package: "@tinycloud/cli",
        ...true ? { version: "1.2.6-beta.3" } : {},
        ...diagnosticClientProvenance(links)
      }
    });
    const binding = await state.runtime.binding();
    if (!binding) return void 0;
    state.context = makeDiagnosticContext(binding, "cli", links);
    state.activity = activity;
    state.runtime.emit({ type: "invocation.start", activity: activity ?? "unknown" }, state.context);
    if (state.imported) state.runtime.emit({ type: "phase.finish", phase: "import" }, state.context);
    if (state.parsed) state.runtime.emit({ type: "phase.finish", phase: "parse" }, state.context);
    return state.context;
  } catch {
    return void 0;
  }
}
function finishCliDiagnostics(code = 0, signal) {
  const state = globals[stateKey];
  if (!state || state.finished) return;
  state.finished = true;
  try {
    if (state.context && state.runtime) {
      if (!state.imported || !state.parsed) {
        state.runtime.emit({
          type: "phase.finish",
          phase: state.imported ? "parse" : "import",
          activity: state.imported ? "parser" : "import",
          outcome: signal ? "interrupted" : code === 0 ? "complete" : "error"
        }, state.context);
      }
      state.runtime.emit({
        type: "invocation.finish",
        exit_code: code,
        activity: state.activity ?? "unknown",
        duration_ms: Math.max(0, Math.round(performance.now() - state.started)),
        business: "unknown",
        timing_scope: "invocation",
        ...signal ? { signal } : {}
      }, state.context);
      state.runtime.drainSync();
    }
  } catch {
  }
}

// src/bootstrap.ts
var args = process.argv.slice(2);
var commandIndex = firstCommandIndex(args);
var load = new Function("specifier", "return import(specifier)");
if (args[commandIndex] === "diagnostics") {
  const entry = await load(new URL("./diagnostics-entry.js", import.meta.url).href);
  await entry.runDiagnostics(args);
} else {
  const context = await initializeCliDiagnostics();
  if (context) enterDiagnosticContext(context);
  emitDiagnostic2({ type: "phase.start", phase: "import" });
  await load(new URL("./index.js", import.meta.url).href);
}
//# sourceMappingURL=bootstrap.js.map