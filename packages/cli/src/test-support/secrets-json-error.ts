/**
 * Test harness: runs the real `handleError` in its own process on one
 * `CLIError` described by argv[2] as JSON `{code, message, exitCode, metadata?}`,
 * so tests see the exact stderr envelope and exit status a command produces.
 */
import { CLIError, handleError } from "../output/errors.js";
import { setJsonOutputRequested } from "../output/formatter.js";

const spec = JSON.parse(process.argv[2] ?? "{}") as {
  code: string;
  message: string;
  exitCode: number;
  metadata?: Record<string, unknown>;
};
setJsonOutputRequested(true);
handleError(new CLIError(spec.code, spec.message, spec.exitCode, spec.metadata));
