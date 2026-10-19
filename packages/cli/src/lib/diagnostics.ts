import {
  beginDiagnosticPhase, createDiagnosticRuntime, decodeDiagnosticContext, diagnosticId, emitDiagnostic,
  diagnosticClientProvenance, getDiagnosticContext, makeDiagnosticContext, withDiagnosticContext,
} from "@tinycloud/operations/diagnostics";
import type { DiagnosticContext, DiagnosticFields, DiagnosticPhase, DiagnosticRuntime } from "@tinycloud/operations/diagnostics";

declare const __TC_CLI_PACKAGE_VERSION__: string;

interface CliDiagnosticState {
  runtime?: DiagnosticRuntime;
  context?: DiagnosticContext;
  started: number;
  finished: boolean;
  imported: boolean;
  parsed: boolean;
  activity?: "kv" | "sql";
}
const stateKey = Symbol.for("tinycloud.cli.diagnostics.v1");
const globals = globalThis as typeof globalThis & { [stateKey]?: CliDiagnosticState };

/** No argv, profile, input, output or resource values enter this state. */
export function initializeCliDiagnostics(): void {
  try {
    globals[stateKey] = {
      started: performance.now(), finished: false, imported: false, parsed: false,
    };
    process.once("exit", finishCliDiagnostics);
  } catch { /* Capture cannot change business execution. */ }
}

async function activate(activity?: "kv" | "sql"): Promise<DiagnosticContext | undefined> {
  const state = globals[stateKey];
  if (!state || state.finished) return getDiagnosticContext();
  if (state.context) return state.context;
  try {
    const links = decodeDiagnosticContext(process.env.TC_DIAGNOSTICS_CONTEXT);
    state.runtime ??= createDiagnosticRuntime({
      source: "cli",
      descriptor: {
        descriptor_id: diagnosticId(), source: "cli", package: "@tinycloud/cli",
        ...(typeof __TC_CLI_PACKAGE_VERSION__ === "string" ? { version: __TC_CLI_PACKAGE_VERSION__ } : {}),
        ...diagnosticClientProvenance(links),
      },
    });
    const binding = await state.runtime.binding();
    if (!binding) return undefined;
    state.context = makeDiagnosticContext(binding, "cli", { ...links, scope: "tc-apps" });
    state.activity = activity;
    // Do not install signal handlers: even a re-raising listener can turn an
    // otherwise fatal startup signal into a natural exit before its JS callback.
    // Existing business handlers may report a signal at their own exit boundary.
    // Explicit context is necessary across separately bundled entrypoints and
    // await boundaries. The caller enters it in its own execution continuation.
    state.runtime.emit({ type: "invocation.start", activity: activity ?? "unknown" }, state.context);
    if (state.imported) state.runtime.emit({ type: "phase.finish", phase: "import" }, state.context);
    if (state.parsed) state.runtime.emit({ type: "phase.finish", phase: "parse" }, state.context);
    return state.context;
  } catch { return undefined; }
}

/** Called only after the business parser has accepted the target. */
export async function cliDiagnosticScope(service: "kv" | "sql", target: string | undefined): Promise<DiagnosticContext | undefined> {
  if (typeof target !== "string"
    || !(service === "kv" ? target.startsWith("xyz.tinycloud.agent-data/") : target === "xyz.tinycloud.agent-data.index")) return undefined;
  const state = globals[stateKey];
  const context = getDiagnosticContext() ?? state?.context;
  if (context?.scope === "tc-apps") {
    if (state) state.activity = service;
    return context;
  }
  return activate(service);
}

/** Approval work is scoped by its accepted request, never by a shared profile or launch marker. */
export async function cliDiagnosticPermissions(
  permissions: readonly { service: string; path?: string; actions: readonly string[] }[] | undefined,
): Promise<DiagnosticContext | undefined> {
  if (!permissions?.length) return undefined;
  let activity: "kv" | "sql" | undefined;
  for (const permission of permissions) {
    if (permission.service === "tinycloud.capabilities" && permission.path === ""
      && permission.actions.every((action) => action === "tinycloud.capabilities/read")) continue;
    if (permission.service === "tinycloud.kv" && permission.path?.startsWith("xyz.tinycloud.agent-data/")) activity = "kv";
    else if (permission.service === "tinycloud.sql" && permission.path === "xyz.tinycloud.agent-data.index") activity = "sql";
    else return undefined;
  }
  return activity === undefined ? undefined : activate(activity);
}

/** One immutable child scope for a CLI phase and its actual SDK dispatches. */
export async function withCliDiagnosticPhase<T>(
  phase: DiagnosticPhase,
  fields: DiagnosticFields,
  action: () => Promise<T>,
  completed?: (value: T) => DiagnosticFields,
): Promise<T> {
  const current = getDiagnosticContext();
  if (!current) return action();
  let operationId: string;
  try { operationId = diagnosticId(); } catch { return action(); }
  const parentId = current.operation_id ?? current.invocation_id;
  return withDiagnosticContext({
    ...current, operation_id: operationId, parent_id: parentId,
    ...(fields.role ? { role: fields.role, role_provenance: "observed" as const } : {}),
  }, async () => {
    const finish = beginDiagnosticPhase(phase, { ...fields, operation_id: operationId, parent_id: parentId });
    try {
      const value = await action();
      try { finish({ outcome: "complete", ...completed?.(value) }); }
      catch { finish({ outcome: "complete" }); }
      return value;
    } catch (error) {
      finish({ outcome: "error" });
      throw error;
    }
  });
}

export function cliDiagnosticImported(): void {
  const state = globals[stateKey];
  if (!state) return;
  state.imported = true;
  emitDiagnostic({ type: "phase.finish", phase: "import", outcome: "complete" });
  emitDiagnostic({ type: "phase.start", phase: "parse" });
}

export function cliDiagnosticParsed(): void {
  const state = globals[stateKey];
  if (!state || state.parsed) return;
  state.parsed = true;
  emitDiagnostic({ type: "phase.finish", phase: "parse", outcome: "complete" });
}

/** The synchronous exit event includes Commander's and legacy direct exits. */
export function finishCliDiagnostics(code = 0, signal?: "SIGINT" | "SIGTERM" | "SIGHUP"): void {
  const state = globals[stateKey];
  if (!state || state.finished) return;
  state.finished = true;
  try {
    if (state.context && state.runtime) {
      if (!state.imported || !state.parsed) {
        state.runtime.emit({
          type: "phase.finish", phase: state.imported ? "parse" : "import",
          activity: state.imported ? "parser" : "import",
          outcome: signal ? "interrupted" : code === 0 ? "complete" : "error",
        }, state.context);
      }
      state.runtime.emit({
        type: "invocation.finish", exit_code: code,
        activity: state.activity ?? "unknown",
        duration_ms: Math.max(0, Math.round(performance.now() - state.started)),
        business: "unknown",
        timing_scope: "invocation", ...(signal ? { signal } : {}),
      }, state.context);
      state.runtime.drainSync();
    }
  } catch { /* Never replace the original exit or its output. */ }
}
