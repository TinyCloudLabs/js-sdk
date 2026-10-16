import { Command } from "commander";
import { spawn } from "node:child_process";
import {
  DiagnosticStore, diagnosticId, decodeDiagnosticContext, encodeDiagnosticContext,
  validateDiagnosticSelection, readDiagnosticJsonFile, exportDiagnosticBundle,
  importDiagnosticBundle, selectDiagnosticCase, reviewDiagnostics,
  compareDiagnostics, bundleDiagnosticCase,
} from "@tinycloud/operations/diagnostics";
import type { DiagnosticEnvironmentContext, DiagnosticSelection } from "@tinycloud/operations/diagnostics";
import { observeDiagnosticWrapper } from "../lib/diagnostic-wrapper.js";

async function selectionFile(path: string): Promise<DiagnosticSelection> {
  const selection = validateDiagnosticSelection(await readDiagnosticJsonFile(path));
  if (!selection) throw new Error("invalid_selection");
  return selection;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Attribution is not scope or enablement. The child owns its streams. */
async function runChild(executable: string, args: string[], scope: unknown, role: unknown): Promise<void> {
  if (scope !== undefined && scope !== "tc-apps") throw new Error("invalid_scope");
  if (role !== undefined && scope !== "tc-apps") throw new Error("scope_required_for_role");
  const inherited = decodeDiagnosticContext(process.env.TC_DIAGNOSTICS_CONTEXT);
  const context: DiagnosticEnvironmentContext = {
    version: 1,
    run_id: scope === "tc-apps" ? inherited?.run_id ?? diagnosticId() : diagnosticId(),
    ...(inherited?.turn_id ? { turn_id: inherited.turn_id } : {}),
    ...(inherited?.task_id ? { task_id: inherited.task_id } : {}),
    ...(scope === "tc-apps" ? {
      scope: "tc-apps", workflow_id: inherited?.workflow_id ?? diagnosticId(),
      ...(role !== undefined ? { role: role as DiagnosticEnvironmentContext["role"] } : {}),
      ...(inherited?.parent_id ? { parent_id: inherited.parent_id } : {}),
      adapter: inherited?.adapter ?? "explicit_launcher",
      adapter_revision: inherited?.adapter_revision ?? 1,
      ...(inherited?.client_version ? { client_version: inherited.client_version } : {}),
    } : {
      ...(inherited?.workflow_id ? { workflow_id: inherited.workflow_id } : {}),
      adapter: "explicit_launcher", adapter_revision: 1,
    }),
  };
  const encoded = encodeDiagnosticContext(context);
  if (encoded === undefined) throw new Error("invalid_context");
  const env = { ...process.env, TC_DIAGNOSTICS_CONTEXT: encoded };
  const child = spawn(executable, args, { env, stdio: "inherit" });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const listeners = signals.map((signal) => {
    const listener = () => { child.kill(signal); };
    process.on(signal, listener);
    return listener;
  });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      process.stderr.write("Diagnostic launcher could not start the child.\n");
      resolve({ code: error.code === "ENOENT" ? 127 : 126, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  signals.forEach((signal, index) => process.removeListener(signal, listeners[index]!));
  if (outcome.signal) {
    // Re-raise instead of translating signal death into a normal exit code.
    process.kill(process.pid, outcome.signal);
  } else {
    process.exitCode = outcome.code ?? 1;
  }
}

/** Register without touching profiles, authentication or business SDKs. */
export function registerDiagnosticsCommand(program: Command): void {
  const diagnostics = program.command("diagnostics")
    .description("Private local diagnostic history (capture is disabled by default)")
    .enablePositionalOptions();
  diagnostics.command("status").option("--json", "JSON status")
    .action(async () => print(await new DiagnosticStore().inspect()));
  diagnostics.command("enable").requiredOption("--scope <scope>", "Selected activity scope: tc-apps")
    .option("--detail-policy <policy>", "Explicit encrypted-excluded-backups policy for selected detail")
    .action(async (options) => {
      if (options.scope !== "tc-apps" || (options.detailPolicy !== undefined && options.detailPolicy !== "encrypted-excluded-backups")) throw new Error("invalid_policy");
      print(await new DiagnosticStore().control("enable", { scope: "tc-apps", detail_policy: options.detailPolicy }));
    });
  for (const action of ["pause", "resume", "disable"] as const) {
    diagnostics.command(action).action(async () => print(await new DiagnosticStore().control(action)));
  }
  diagnostics.command("run <executable> [args...]")
    .description("Attribute a child run; --scope is only for a selected tc-apps command/block, never a whole client")
    .option("--scope <scope>", "Explicit selected-block scope: tc-apps")
    .option("--role <role>", "Selected-block workflow hint: catalog, record, verification, copy, approval or context")
    .passThroughOptions()
    .action(async (executable: string, args: string[], options) => runChild(executable, args, options.scope, options.role));
  diagnostics.command("_wrapper <stage> [value] [exitCode] [decision]", { hidden: true })
    .action(observeDiagnosticWrapper);
  diagnostics.command("export")
    .requiredOption("--selection <file>", "Exact authorized selection JSON")
    .requiredOption("--out <directory>", "Managed export destination, or explicit external output")
    .requiredOption("--expires-at <UTC>", "Explicit export expiry")
    .option("--external", "Acknowledge this copy is outside automatic cleanup and deletion")
    .action(async (options) => print(await exportDiagnosticBundle(new DiagnosticStore(), {
      selection: await selectionFile(options.selection), out: options.out,
      expires_at: options.expiresAt, external: options.external,
    })));
  diagnostics.command("import <directory>")
    .action(async (directory: string) => print(await importDiagnosticBundle(new DiagnosticStore(), directory)));
  diagnostics.command("select").requiredOption("--manifest <file>", "Exact selected passages, purpose, links and expiry")
    .action(async (options) => print(await selectDiagnosticCase(new DiagnosticStore(), options.manifest)));
  diagnostics.command("review").requiredOption("--selection <file>", "Exact evidence selection JSON")
    .option("--json", "JSON review")
    .action(async (options) => print(await reviewDiagnostics(new DiagnosticStore(), await selectionFile(options.selection))));
  diagnostics.command("compare")
    .requiredOption("--left <selection>", "Left selection JSON")
    .requiredOption("--right <selection>", "Right selection JSON")
    .action(async (options) => print(await compareDiagnostics(new DiagnosticStore(), await selectionFile(options.left), await selectionFile(options.right))));
  diagnostics.command("bundle")
    .requiredOption("--case <id>", "Reviewed case ID")
    .requiredOption("--fixture <file>", "Explicit synthetic fixture JSON")
    .requiredOption("--out <directory>", "Managed bundle destination, or explicit external output")
    .requiredOption("--expires-at <UTC>", "Explicit bundle expiry")
    .option("--external", "Acknowledge this copy is outside automatic cleanup and deletion")
    .action(async (options) => print(await bundleDiagnosticCase(new DiagnosticStore(), {
      case_id: options.case, fixture: options.fixture, out: options.out,
      expires_at: options.expiresAt, external: options.external,
    })));
  diagnostics.command("delete")
    .requiredOption("--selection <file>", "Exact evidence selection JSON")
    .option("--confirm", "Authorize deletion of this exact selection; otherwise preview only")
    .option("--pause-after", "Leave capture paused after deletion (required decision for all)")
    .option("--keep-enabled", "Do not leave capture paused after deletion (required decision for all)")
    .action(async (options) => {
      const store = new DiagnosticStore();
      const selection = await selectionFile(options.selection);
      if (options.pauseAfter && options.keepEnabled) throw new Error("invalid_pause_decision");
      if (!options.confirm) {
        const snapshot = await store.snapshot(selection);
        print({
          preview: true, selection, event_ids: snapshot.events.map((event) => event.event_id),
          controlled_derivatives: "referencing_selection_removed_or_rewritten",
          gaps: snapshot.gaps,
        });
        return;
      }
      if (selection.all && !options.pauseAfter && !options.keepEnabled) throw new Error("pause_decision_required");
      const pauseAfter = options.pauseAfter ? true : options.keepEnabled ? false : undefined;
      print(await store.delete(selection, pauseAfter === undefined ? {} : { pause_after: pauseAfter }));
    });
}
