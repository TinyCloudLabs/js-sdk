import { Command } from "commander";
import { registerShareCommand } from "./share.js";

export async function runShareCaptured(args: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = new Command();
  registerShareCommand(program);
  let stdout = "";
  let stderr = "";
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); return true; }) as typeof process.stderr.write;
  let exitCode = 0;
  try { await program.parseAsync(["node", "tc", ...args], { from: "node" }); }
  finally {
    exitCode = process.exitCode ?? 0;
    // Bun retains a numeric exitCode when assigned undefined.  Zero is the
    // actual successful reset and preserves a previously explicit zero.
    process.exitCode = previousExitCode ?? 0;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  return { stdout, stderr, exitCode };
}
