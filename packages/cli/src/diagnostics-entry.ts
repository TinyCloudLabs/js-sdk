import { CommanderError } from "commander";
import { createRootCommand } from "./root-command.js";
import { DiagnosticDeletionError } from "@tinycloud/operations/diagnostics";
import { registerDiagnosticsCommand } from "./commands/diagnostics.js";

export async function runDiagnostics(args: readonly string[]): Promise<void> {
  const program = createRootCommand().enablePositionalOptions().exitOverride();
  registerDiagnosticsCommand(program);
  try {
    await program.parseAsync([...args], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    // Never echo selected inputs or filesystem exception paths in error output.
    process.stderr.write(error instanceof DiagnosticDeletionError
      ? `${JSON.stringify({ error: "diagnostic_deletion_incomplete", incomplete: true, message: "Diagnostic deletion incomplete; inspect capture status." })}\n`
      : "Diagnostic operation failed; check the selection, policy, expiry and private destination.\n");
    process.exitCode = 1;
  }
}
