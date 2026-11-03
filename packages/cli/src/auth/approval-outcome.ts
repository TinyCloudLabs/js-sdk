/**
 * What the CLI says and exits with for each end of an approval run. The machine decides WHAT happened (`Outcome`) and which exit
 * number it carries (`APPROVAL_EXIT`, the only source of approval exit numbers); this table decides the code string and the
 * message. The code strings are the ones CLI 1.6.x already emitted (scripts and watchers grep them) plus `APPROVAL_DENIED`,
 * `APPROVAL_CLOCK` and `APPROVAL_STATE_UNREADABLE`: a string is never renamed.
 *
 * Nothing here reads a key: an outcome and the entry's phase and link are all it sees.
 */
import { exitCodeOf, type ApprovalEntry, type Outcome } from "@tinycloud/share-envelope/links";
import { CLIError, type ApprovalPending } from "../output/errors.js";
import { markClockDependent, markMaybeGranted } from "./refusal.js";

export const APPROVAL_ERROR_CODES: readonly string[] = [
  "APPROVAL_ACK_PENDING", "APPROVAL_CLOCK", "APPROVAL_DENIED", "APPROVAL_PENDING", "APPROVAL_REQUEST_CONTEXT_REQUIRED",
  "APPROVAL_REQUEST_EXPIRED", "APPROVAL_REQUEST_NOT_FOUND", "APPROVAL_REQUEST_UNAVAILABLE", "APPROVAL_RESULT_ACKNOWLEDGED",
  "APPROVAL_RESULT_EXPIRED", "APPROVAL_RESULT_INVALID", "APPROVAL_RESULT_NOT_FOUND", "APPROVAL_RESULT_UNAVAILABLE",
  "APPROVAL_STATE_UNREADABLE",
];

export interface OutcomeContext {
  /** The entry the run ended on: its phase says whether an approval exists, its link is what a pending approval hands out. */
  readonly entry: Pick<ApprovalEntry, "approvalUrl" | "phase">;
  /** Which approval of the command this is (`onboard` asks for several). */
  readonly step?: number;
  readonly of?: number;
  /** The error the CLI's own verification raised, for a `refused` outcome of kind `verification`. */
  readonly cause?: unknown;
}

const GRANT_SAVED = "This profile already holds the grant; only the acknowledgement to OpenKey is outstanding.";

function pendingFields(expiresAt: number, context: OutcomeContext): ApprovalPending {
  return { step: context.step ?? 1, of: context.of ?? 1, approvalUrl: context.entry.approvalUrl!, expiresAt: new Date(expiresAt).toISOString() };
}

function clockMessage(skewMs: number | undefined, grantSaved: boolean): string {
  const skew = skewMs === undefined ? "may be wrong"
    : `is about ${Math.round(Math.abs(skewMs) / 1000)} s ${skewMs >= 0 ? "ahead of" : "behind"} OpenKey's`;
  return `OpenKey rejected this machine's proof, and this machine's clock ${skew}. Fix the clock, then run the same command again; the saved request is kept.${grantSaved ? ` ${GRANT_SAVED}` : ""}`;
}

/** The CLI error for an outcome, or `undefined` when the run did not fail (completed, or removed by the caller itself). */
export function approvalOutcomeError(outcome: Outcome, context: OutcomeContext): CLIError | undefined {
  const exit = exitCodeOf(outcome);
  const result = context.entry.phase === "open" ? "REQUEST" : "RESULT";
  switch (outcome.kind) {
    case "completed":
    case "abandoned":
      return undefined;
    case "pending": {
      const pending = pendingFields(outcome.expiresAt, context);
      return new CLIError("APPROVAL_PENDING",
        `Still waiting for the owner to approve in OpenKey. Run the same command again to keep waiting; the link stays valid until ${pending.expiresAt}.`,
        exit, { pending });
    }
    case "unreachable":
      return outcome.resultExpiresAt === undefined
        ? new CLIError("APPROVAL_REQUEST_UNAVAILABLE", "OpenKey could not be reached to check this approval request. The request is saved and nothing was lost. Retry the command to resume.", exit)
        : new CLIError("APPROVAL_RESULT_UNAVAILABLE", "OpenKey could not be reached to fetch this approved result. It is saved by reference. Retry the command to resume.", exit);
    case "unexpected":
      return outcome.grantSaved === true
        ? new CLIError("APPROVAL_ACK_PENDING", `Approval is saved. ${GRANT_SAVED} OpenKey answered the acknowledgement unexpectedly. Retry this command to acknowledge the same result.`, exit)
        : new CLIError(`APPROVAL_${result}_UNAVAILABLE`,
          `OpenKey could not ${result === "REQUEST" ? "discover this request" : "fetch this result"} (unexpected answers). It is saved. Retry the command to resume.`, exit);
    case "lapsed":
      return outcome.reason === "not_found"
        ? new CLIError("APPROVAL_REQUEST_NOT_FOUND", "OpenKey cannot find this approval request. Start a new request.", exit)
        : new CLIError("APPROVAL_REQUEST_EXPIRED", "This approval request expired before it was approved. Start a new request.", exit);
    case "gone":
      switch (outcome.reason) {
        case "not_found": return new CLIError("APPROVAL_RESULT_NOT_FOUND", "OpenKey cannot find this approval result. Start a new request.", exit);
        case "acknowledged":
          return new CLIError("APPROVAL_RESULT_ACKNOWLEDGED",
            "OpenKey has already collected this result (it was acknowledged). If this device has no grant, start a new request.", exit);
        // The CLI's own verification found the delegation already over: its AUTH_EXPIRED says so, and keeps its code.
        case "ended": return context.cause instanceof CLIError ? context.cause
          : new CLIError("APPROVAL_RESULT_EXPIRED", "The approved delegation had already ended before it could be saved. Start a new request.", exit);
        case "purged": return new CLIError("APPROVAL_RESULT_EXPIRED", "The approved result was not collected in time and the saved request was removed. Start a new request.", exit);
        case "expired_result": return new CLIError("APPROVAL_RESULT_EXPIRED", "The approved result expired before it was saved. Start a new request.", exit);
      }
      return undefined;
    case "refused": {
      if (outcome.reason === "verification" && context.cause instanceof CLIError) return context.cause;
      const message = outcome.reason === "request_invalid" ? "OpenKey refused this approval request as invalid. Start a new request."
        : "OpenKey rejected the request or requester binding.";
      const error = new CLIError("APPROVAL_RESULT_INVALID", message, exit);
      // From the poll the CLI never learned whether, or what, the owner granted.
      return outcome.grantMayBeLive === "maybe" ? markMaybeGranted(error) : error;
    }
    case "denied":
      return new CLIError("APPROVAL_DENIED", "The owner declined this approval request in OpenKey. Nothing was granted. Start a new request only if they want to try again.", exit);
    case "clock":
      // A clock-dependent ceiling found by the CLI's own check keeps its code STRING and message (OPENKEY_EXPIRY_EXCEEDED...) but exits
      // with the machine's clock number (spec T21); the request is only held. Marked so `refusing()` never reads it as a permanent refusal.
      if (context.cause instanceof CLIError) {
        const held = new CLIError(context.cause.code, context.cause.message, exit, context.cause.metadata);
        markClockDependent(held);
        return held;
      }
      return new CLIError("APPROVAL_CLOCK", clockMessage(outcome.skewMs, outcome.grantSaved === true), exit);
    case "internal":
      return new CLIError("APPROVAL_REQUEST_UNAVAILABLE", "The saved approval request could not be resumed. Retry the command to resume.", exit);
  }
}

/** The stderr warning of a run that completed with something outstanding (exit 0), or `undefined`. */
export function approvalOutcomeWarning(outcome: Outcome): string | undefined {
  if (outcome.kind !== "completed" || outcome.warning === undefined) return undefined;
  switch (outcome.warning) {
    case "ack-pending": return "warning: Approval is saved. OpenKey did not confirm the acknowledgement; it is sent again the next time a command resumes this approval.";
    case "ack-conflict": return "warning: Approval is saved. OpenKey already holds a different acknowledgement for this result; nothing more is needed.";
    case "ack-expired": return "warning: Approval is saved. The acknowledgement was not confirmed before OpenKey stopped keeping the result; nothing more is needed.";
  }
}
