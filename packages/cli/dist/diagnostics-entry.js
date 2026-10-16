// src/diagnostics-entry.ts
import { CommanderError } from "commander";

// src/root-command.ts
import { readFileSync } from "fs";
import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
var CLI_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
).version;
function createRootCommand() {
  return new Command().name(CLI_NAME).description("TinyCloud CLI \u2014 self-sovereign storage from the terminal").version(CLI_VERSION).option("-p, --profile <name>", "Profile to use").option("-H, --host <url>", "TinyCloud node URL").option("-v, --verbose", "Enable verbose output").option("--no-cache", "Disable caching").option("-q, --quiet", "Suppress non-essential output").option("--json", "Force JSON output").option("--replication", "Enable read-through replication for this invocation").option("--no-replication", "Disable read-through replication for this invocation").option("--replication-debug", "Write replication diagnostics to stderr");
}

// src/diagnostics-entry.ts
import { DiagnosticDeletionError } from "@tinycloud/operations/diagnostics";

// src/commands/diagnostics.ts
import { spawn } from "child_process";
import {
  DiagnosticStore,
  diagnosticId as diagnosticId2,
  decodeDiagnosticContext as decodeDiagnosticContext2,
  encodeDiagnosticContext as encodeDiagnosticContext2,
  validateDiagnosticSelection,
  readDiagnosticJsonFile,
  exportDiagnosticBundle,
  importDiagnosticBundle,
  selectDiagnosticCase,
  reviewDiagnostics,
  compareDiagnostics,
  bundleDiagnosticCase
} from "@tinycloud/operations/diagnostics";

// src/lib/diagnostic-wrapper.ts
import {
  createDiagnosticRuntime,
  decodeDiagnosticContext,
  diagnosticClientProvenance,
  diagnosticDataObject,
  diagnosticId,
  encodeDiagnosticContext,
  isDiagnosticId,
  makeDiagnosticContext,
  METADATA_RETENTION_MS
} from "@tinycloud/operations/diagnostics";
var STATE_FIELDS = {
  version: true,
  activity: true,
  source_id: true,
  generation: true,
  wrapper_id: true,
  started_ns: true,
  context: true,
  ordinal: true,
  attempt_id: true,
  attempt_started_ns: true
};
var MAX_STATE_BYTES = 4096;
var MAX_INTERVAL_NS = BigInt(METADATA_RETENTION_MS) * 1000000n;
function wrapperState(raw, now) {
  if (!raw || Buffer.byteLength(raw) > MAX_STATE_BYTES) return void 0;
  try {
    const value = diagnosticDataObject(JSON.parse(raw), 10);
    if (!value || Object.keys(value).some((key) => !Object.prototype.hasOwnProperty.call(STATE_FIELDS, key)) || value.version !== 1 || value.activity !== "kv" && value.activity !== "sql" || !isDiagnosticId(value.source_id) || !isDiagnosticId(value.wrapper_id) || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1) return void 0;
    const context = value.context;
    if (!encodeDiagnosticContext(context) || context.scope !== "tc-apps") return void 0;
    for (const field of ["started_ns", "attempt_started_ns"]) {
      const stamp = value[field];
      if (field === "attempt_started_ns" && stamp === void 0) continue;
      if (typeof stamp !== "string" || !/^[0-9]{1,20}$/.test(stamp)) return void 0;
      const elapsed = now - BigInt(stamp);
      if (elapsed < 0n || elapsed > MAX_INTERVAL_NS) return void 0;
    }
    if (value.ordinal !== void 0 && (!Number.isInteger(value.ordinal) || Number(value.ordinal) < 1 || Number(value.ordinal) > 3)) return void 0;
    if (value.attempt_id === void 0 !== (value.attempt_started_ns === void 0)) return void 0;
    if (value.attempt_id !== void 0 && (!isDiagnosticId(value.attempt_id) || value.ordinal === void 0 || BigInt(value.attempt_started_ns) < BigInt(value.started_ns))) return void 0;
    return value;
  } catch {
    return void 0;
  }
}
async function observeDiagnosticWrapper(stage, value, exitCode, decision) {
  let runtime;
  let output;
  let expected = 0;
  try {
    const now = process.hrtime.bigint();
    const inherited = decodeDiagnosticContext(process.env.TC_DIAGNOSTICS_CONTEXT);
    let state;
    if (stage === "begin") {
      if (inherited?.scope !== "tc-apps" || value !== "kv" && value !== "sql" || exitCode !== void 0 || decision !== void 0) return;
    } else {
      if (stage !== "child" && stage !== "finish") return;
      state = wrapperState(process.env.TC_DIAGNOSTICS_WRAPPER_STATE, now);
      if (!state || !value || !/^[1-3]$/.test(value)) return;
      if (stage === "child" && (exitCode !== void 0 || decision !== void 0 || state.attempt_id !== void 0 || Number(value) !== (state.ordinal ?? 0) + 1)) return;
      if (stage === "finish" && (!state.attempt_id || Number(value) !== state.ordinal || !exitCode || !/^(?:0|[1-9][0-9]{0,2})$/.test(exitCode) || Number(exitCode) > 255 || decision !== "retry" && decision !== "stop" || decision === "retry" && (Number(exitCode) === 0 || state.ordinal === 3))) return;
    }
    runtime = createDiagnosticRuntime({ source: "wrapper", descriptor: {
      descriptor_id: diagnosticId(),
      source: "wrapper",
      package: "tc-apps",
      wrapper_revision: "1.0.0",
      ...diagnosticClientProvenance(state?.context ?? inherited)
    } });
    const binding = await runtime.binding();
    if (!binding || state && (state.source_id !== binding.source_id || state.generation !== binding.generation)) return;
    if (stage === "begin") {
      const context = makeDiagnosticContext(binding, "wrapper", inherited);
      const environment = {
        ...inherited,
        workflow_id: inherited.workflow_id ?? context.invocation_id
      };
      state = {
        version: 1,
        activity: value,
        source_id: binding.source_id,
        generation: binding.generation,
        wrapper_id: context.invocation_id,
        started_ns: now.toString(),
        context: environment
      };
      expected = 1;
      if (runtime.emit({ type: "invocation.start", activity: state.activity, business: "not_applicable" }, {
        ...context,
        workflow_id: environment.workflow_id
      })) output = JSON.stringify(state);
    } else {
      const current = state;
      const context = makeDiagnosticContext(binding, "wrapper", { ...current.context, invocation_id: current.wrapper_id });
      if (stage === "child") {
        const attempt = diagnosticId();
        const ordinal = Number(value);
        state = { ...current, ordinal, attempt_id: attempt, attempt_started_ns: process.hrtime.bigint().toString() };
        expected = 1;
        if (runtime.emit({
          type: "attempt.start",
          activity: current.activity,
          layer: "wrapper_child",
          ordinal,
          attempt_id: attempt,
          parent_id: current.wrapper_id
        }, context)) {
          const environment = encodeDiagnosticContext({
            ...current.context,
            wrapper_id: current.wrapper_id,
            child_ordinal: ordinal,
            parent_id: attempt
          });
          if (environment) output = `${JSON.stringify(state)}
${environment}`;
        }
      } else {
        const code = Number(exitCode);
        const accepted = runtime.emit({
          type: "attempt.finish",
          activity: current.activity,
          layer: "wrapper_child",
          attempt_id: current.attempt_id,
          parent_id: current.wrapper_id,
          ordinal: current.ordinal,
          exit_code: code,
          outcome: code === 0 ? "complete" : "error",
          timing_scope: "wrapper_child",
          duration_ms: Number(now - BigInt(current.attempt_started_ns)) / 1e6
        }, context);
        expected = 2;
        if (decision === "retry") {
          const scheduled = runtime.emit({
            type: "retry.scheduled",
            activity: current.activity,
            layer: "wrapper_child",
            attempt_id: current.attempt_id,
            parent_id: current.wrapper_id,
            ordinal: current.ordinal,
            delay_ms: current.ordinal * 2e3,
            outcome: "pending"
          }, context);
          if (accepted && scheduled) {
            const { attempt_id: _attempt, attempt_started_ns: _started, ...next } = current;
            output = JSON.stringify(next);
          }
        } else {
          runtime.emit({
            type: "invocation.finish",
            activity: current.activity,
            exit_code: code,
            business: "not_applicable",
            timing_scope: "invocation",
            duration_ms: Number(now - BigInt(current.started_ns)) / 1e6
          }, context);
        }
      }
    }
  } catch {
  } finally {
    try {
      const drain = runtime?.drainSync();
      if (output && Buffer.byteLength(output) <= MAX_STATE_BYTES + 2048 + 1 && drain?.acknowledged === expected && drain.pending === 0 && drain.dropped === 0) process.stdout.write(`${output}
`);
    } catch {
    }
  }
}

// src/commands/diagnostics.ts
async function selectionFile(path) {
  const selection = validateDiagnosticSelection(await readDiagnosticJsonFile(path));
  if (!selection) throw new Error("invalid_selection");
  return selection;
}
function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}
`);
}
async function runChild(executable, args, scope, role) {
  if (scope !== void 0 && scope !== "tc-apps") throw new Error("invalid_scope");
  if (role !== void 0 && scope !== "tc-apps") throw new Error("scope_required_for_role");
  const inherited = decodeDiagnosticContext2(process.env.TC_DIAGNOSTICS_CONTEXT);
  const context = {
    version: 1,
    run_id: scope === "tc-apps" ? inherited?.run_id ?? diagnosticId2() : diagnosticId2(),
    ...inherited?.turn_id ? { turn_id: inherited.turn_id } : {},
    ...inherited?.task_id ? { task_id: inherited.task_id } : {},
    ...scope === "tc-apps" ? {
      scope: "tc-apps",
      workflow_id: inherited?.workflow_id ?? diagnosticId2(),
      ...role !== void 0 ? { role } : {},
      ...inherited?.parent_id ? { parent_id: inherited.parent_id } : {},
      adapter: inherited?.adapter ?? "explicit_launcher",
      adapter_revision: inherited?.adapter_revision ?? 1,
      ...inherited?.client_version ? { client_version: inherited.client_version } : {}
    } : {
      ...inherited?.workflow_id ? { workflow_id: inherited.workflow_id } : {},
      adapter: "explicit_launcher",
      adapter_revision: 1
    }
  };
  const encoded = encodeDiagnosticContext2(context);
  if (encoded === void 0) throw new Error("invalid_context");
  const env = { ...process.env, TC_DIAGNOSTICS_CONTEXT: encoded };
  const child = spawn(executable, args, { env, stdio: "inherit" });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const listeners = signals.map((signal) => {
    const listener = () => {
      child.kill(signal);
    };
    process.on(signal, listener);
    return listener;
  });
  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => {
      process.stderr.write("Diagnostic launcher could not start the child.\n");
      resolve({ code: error.code === "ENOENT" ? 127 : 126, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  signals.forEach((signal, index) => process.removeListener(signal, listeners[index]));
  if (outcome.signal) {
    process.kill(process.pid, outcome.signal);
  } else {
    process.exitCode = outcome.code ?? 1;
  }
}
function registerDiagnosticsCommand(program) {
  const diagnostics = program.command("diagnostics").description("Private local diagnostic history (capture is disabled by default)").enablePositionalOptions();
  diagnostics.command("status").option("--json", "JSON status").action(async () => print(await new DiagnosticStore().inspect()));
  diagnostics.command("enable").requiredOption("--scope <scope>", "Selected activity scope: tc-apps").option("--detail-policy <policy>", "Explicit encrypted-excluded-backups policy for selected detail").action(async (options) => {
    if (options.scope !== "tc-apps" || options.detailPolicy !== void 0 && options.detailPolicy !== "encrypted-excluded-backups") throw new Error("invalid_policy");
    print(await new DiagnosticStore().control("enable", { scope: "tc-apps", detail_policy: options.detailPolicy }));
  });
  for (const action of ["pause", "resume", "disable"]) {
    diagnostics.command(action).action(async () => print(await new DiagnosticStore().control(action)));
  }
  diagnostics.command("run <executable> [args...]").description("Attribute a child run; --scope is only for a selected tc-apps command/block, never a whole client").option("--scope <scope>", "Explicit selected-block scope: tc-apps").option("--role <role>", "Selected-block workflow hint: catalog, record, verification, copy, approval or context").passThroughOptions().action(async (executable, args, options) => runChild(executable, args, options.scope, options.role));
  diagnostics.command("_wrapper <stage> [value] [exitCode] [decision]", { hidden: true }).action(observeDiagnosticWrapper);
  diagnostics.command("export").requiredOption("--selection <file>", "Exact authorized selection JSON").requiredOption("--out <directory>", "Managed export destination, or explicit external output").requiredOption("--expires-at <UTC>", "Explicit export expiry").option("--external", "Acknowledge this copy is outside automatic cleanup and deletion").action(async (options) => print(await exportDiagnosticBundle(new DiagnosticStore(), {
    selection: await selectionFile(options.selection),
    out: options.out,
    expires_at: options.expiresAt,
    external: options.external
  })));
  diagnostics.command("import <directory>").action(async (directory) => print(await importDiagnosticBundle(new DiagnosticStore(), directory)));
  diagnostics.command("select").requiredOption("--manifest <file>", "Exact selected passages, purpose, links and expiry").action(async (options) => print(await selectDiagnosticCase(new DiagnosticStore(), options.manifest)));
  diagnostics.command("review").requiredOption("--selection <file>", "Exact evidence selection JSON").option("--json", "JSON review").action(async (options) => print(await reviewDiagnostics(new DiagnosticStore(), await selectionFile(options.selection))));
  diagnostics.command("compare").requiredOption("--left <selection>", "Left selection JSON").requiredOption("--right <selection>", "Right selection JSON").action(async (options) => print(await compareDiagnostics(new DiagnosticStore(), await selectionFile(options.left), await selectionFile(options.right))));
  diagnostics.command("bundle").requiredOption("--case <id>", "Reviewed case ID").requiredOption("--fixture <file>", "Explicit synthetic fixture JSON").requiredOption("--out <directory>", "Managed bundle destination, or explicit external output").requiredOption("--expires-at <UTC>", "Explicit bundle expiry").option("--external", "Acknowledge this copy is outside automatic cleanup and deletion").action(async (options) => print(await bundleDiagnosticCase(new DiagnosticStore(), {
    case_id: options.case,
    fixture: options.fixture,
    out: options.out,
    expires_at: options.expiresAt,
    external: options.external
  })));
  diagnostics.command("delete").requiredOption("--selection <file>", "Exact evidence selection JSON").option("--confirm", "Authorize deletion of this exact selection; otherwise preview only").option("--pause-after", "Leave capture paused after deletion (required decision for all)").option("--keep-enabled", "Do not leave capture paused after deletion (required decision for all)").action(async (options) => {
    const store = new DiagnosticStore();
    const selection = await selectionFile(options.selection);
    if (options.pauseAfter && options.keepEnabled) throw new Error("invalid_pause_decision");
    if (!options.confirm) {
      const snapshot = await store.snapshot(selection);
      print({
        preview: true,
        selection,
        event_ids: snapshot.events.map((event) => event.event_id),
        controlled_derivatives: "referencing_selection_removed_or_rewritten",
        gaps: snapshot.gaps
      });
      return;
    }
    if (selection.all && !options.pauseAfter && !options.keepEnabled) throw new Error("pause_decision_required");
    const pauseAfter = options.pauseAfter ? true : options.keepEnabled ? false : void 0;
    print(await store.delete(selection, pauseAfter === void 0 ? {} : { pause_after: pauseAfter }));
  });
}

// src/diagnostics-entry.ts
async function runDiagnostics(args) {
  const program = createRootCommand().enablePositionalOptions().exitOverride();
  registerDiagnosticsCommand(program);
  try {
    await program.parseAsync([...args], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(error instanceof DiagnosticDeletionError ? `${JSON.stringify({ error: "diagnostic_deletion_incomplete", incomplete: true, message: "Diagnostic deletion incomplete; inspect capture status." })}
` : "Diagnostic operation failed; check the selection, policy, expiry and private destination.\n");
    process.exitCode = 1;
  }
}
export {
  runDiagnostics
};
//# sourceMappingURL=diagnostics-entry.js.map