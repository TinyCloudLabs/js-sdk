import { shouldOutputJson } from "../output/formatter.js";

/** Help text for a `--yes` that no longer does anything; it stays accepted so scripts keep working. */
export const UNNEEDED_YES_DESCRIPTION = "No longer needed; accepted and ignored";

/**
 * One stderr line when `--yes` is still passed though nothing asks any more. JSON mode keeps
 * stderr machine-readable (a script may parse the error there), so the line is for terminals only.
 */
export function noteUnneededYes(yes: unknown): void {
  if (yes === true && !shouldOutputJson()) process.stderr.write("--yes is no longer needed and has no effect.\n");
}
