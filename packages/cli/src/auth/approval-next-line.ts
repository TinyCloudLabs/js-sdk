import type { ApprovalPending } from "../output/errors.js";

/**
 * SEAM for TC-2360 (the agent-directed `Next:` line, js-sdk #834). The wording belongs to #834; until it lands there is no helper and
 * nothing is printed. The call sites (the exit-8 pending path in `handleError`, and the link the CLI itself prints) ask this seam
 * and print the line, as the LAST line on stderr, only when a helper returned one.
 */
export type NextLineHelper = (pending: ApprovalPending) => string | undefined;

let helper: NextLineHelper | undefined;

/** #834 registers its helper here; tests register a fake. `undefined` removes it. */
export function registerNextLineHelper(next: NextLineHelper | undefined): void {
  helper = next;
}

/** The `Next:` line for a pending approval, or `undefined` when no helper is registered (the default). */
export function approvalNextLine(pending: ApprovalPending): string | undefined {
  return helper?.(pending);
}
