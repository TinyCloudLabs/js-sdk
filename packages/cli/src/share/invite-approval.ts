import { setTimeout as wait } from "node:timers/promises";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { requestInvitationApproval, type InvitationApprovalOutcome } from "@tinycloud/operations/invitation-approval";
import { APPROVAL_POLL_INTERVAL_MS } from "../auth/approval-wait.js";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import { tryOpenBrowser } from "../lib/browser.js";
import { CLIError } from "../output/errors.js";

/** What an approved invitation gives the share: the key id (from the signed grant only). The grant itself is installed on the profile's node. */
export interface EmailInviteKey {
  shareId: string;
  /** The access expiry the owner was shown and signed (inside the request body). It is the file's own expiry, never shortened or extended. */
  accessExpiresAt: string;
  /** The approval continued an open request for the same relative expiry: the share is issued with ITS absolute access date, not a recomputed one. */
  resumed: boolean;
}

export interface EmailInviteApprovalRequest {
  node: TinyCloudNode;
  profile: string;
  recipientEmail: string;
  /** The shared file name (or session name), shown to the approver with the recipient and dates. */
  subjectName: string;
  subjectKind: "file" | "session";
  /** When the shared content stops being readable by the recipient. */
  accessExpiresAt: Date;
  /** sha256 of the shared bytes: a rerun of the same file (same recipient and name) resumes its own open approval. */
  contentSha256?: string;
  /** The relative expiry the user chose, in milliseconds (absent for a date): the same choice on a rerun resumes this approval. */
  requestedDurationMs?: number;
  onApprovalRequest?: (request: { approvalUrl: string; requestId: string; expiresAt: string }) => void;
}

export type EmailInviteApprover = (request: EmailInviteApprovalRequest) => Promise<EmailInviteKey>;

/** Test seams: the approval call, the pause between two asks, and the profile read. */
export interface EmailInviteApproverDeps {
  requestApproval?: typeof requestInvitationApproval;
  sleep?: (ms: number) => Promise<void>;
  getProfile?: (profile: string) => Promise<{ ownerDid?: string; openkeyHost?: string }>;
}

/** How many answers in a row OpenKey may fail to give before the wait ends; the request stays saved and the next run resumes it. */
const MAX_CONSECUTIVE_UNAVAILABLE = 5;

/** The CLI's own error for each stable operations error an invitation approval can end with. */
const CLI_ERRORS: Readonly<Record<string, { code: string; exitCode: number }>> = {
  APPROVAL_RESULT_INVALID: { code: "APPROVAL_RESULT_INVALID", exitCode: ExitCode.PERMISSION_DENIED },
  APPROVAL_REQUEST_EXPIRED: { code: "APPROVAL_REQUEST_EXPIRED", exitCode: ExitCode.AUTH_REQUIRED },
  APPROVAL_RESULT_EXPIRED: { code: "APPROVAL_RESULT_EXPIRED", exitCode: ExitCode.AUTH_REQUIRED },
  APPROVAL_UNAVAILABLE: { code: "APPROVAL_REQUEST_UNAVAILABLE", exitCode: ExitCode.PENDING },
  NODE_UNREACHABLE: { code: "UNAVAILABLE", exitCode: ExitCode.NETWORK_ERROR },
  AUTH_REQUIRED: { code: "AUTH_REQUIRED", exitCode: ExitCode.AUTH_REQUIRED },
  INPUT_INVALID: { code: "APPROVAL_REQUEST_CONTEXT_REQUIRED", exitCode: ExitCode.USAGE_ERROR },
  PROFILE_NOT_FOUND: { code: "PROFILE_NOT_FOUND", exitCode: ExitCode.NOT_FOUND },
};

/** The stable operations error a call ended with (the operations package bundles its own error class per entry point, so read its shape). */
function operationFailure(error: unknown): { code: string; message: string } | undefined {
  if (!(error instanceof Error) || error.name !== "OperationInvocationError" || !("operationError" in error)) return undefined;
  const { operationError } = error;
  if (typeof operationError !== "object" || operationError === null || !("code" in operationError) || !("message" in operationError)) return undefined;
  const { code, message } = operationError;
  return typeof code === "string" && typeof message === "string" ? { code, message } : undefined;
}

function cliError(failure: { code: string; message: string }): CLIError {
  const mapped = CLI_ERRORS[failure.code];
  return new CLIError(mapped?.code ?? failure.code, failure.message, mapped?.exitCode ?? ExitCode.ERROR);
}

/** Tell the owner where to approve: the caller's own hook, or the link on stderr, and the browser unless a popup is off. */
async function showApprovalLink(request: EmailInviteApprovalRequest, link: { approvalUrl: string; requestId: string; expiresAt: string }): Promise<void> {
  if (request.onApprovalRequest) {
    request.onApprovalRequest(link);
    return;
  }
  console.error(`Approve this request in OpenKey (open the complete link):\n${link.approvalUrl}\nThe link is valid until ${link.expiresAt}.\n`);
  if (process.env.TC_AUTH_NO_POPUP !== "1" && process.env.TC_NO_POPUP !== "1") await tryOpenBrowser(link.approvalUrl);
}

/**
 * Ask the owner for one approval for this invitation's Share key, wait for it, verify the owner-signed grant for THIS request and
 * install it on the profile's own node as a runtime delegation (the same path the CLI's escalation grants use). Nothing is created
 * before the approval. A rerun while the approval is open continues the same request; the approval can be taken once. The approval
 * itself is `@tinycloud/operations`'s `requestInvitationApproval`; this waits for it by asking again at the approval poll interval.
 */
export function createEmailInviteApprover(deps: EmailInviteApproverDeps = {}): EmailInviteApprover {
  const ask = deps.requestApproval ?? requestInvitationApproval;
  const pause = deps.sleep ?? ((ms: number) => wait(ms));
  const readProfile = deps.getProfile ?? ((name: string) => ProfileManager.getProfile(name));
  return async (request) => {
    const { node, profile } = request;
    const profileConfig = await readProfile(profile);
    // The owner is the profile's own account (did:pkh), never the session key's did:key.
    const ownerDid = profileConfig.ownerDid;
    if (typeof ownerDid !== "string" || !/^did:pkh:eip155:\d+:0x[0-9a-fA-F]{40}$/.test(ownerDid)) {
      throw new CLIError("APPROVAL_REQUEST_CONTEXT_REQUIRED", "This profile has no recorded owner account to check an invitation approval against.", ExitCode.USAGE_ERROR);
    }
    let requestId: string | undefined;
    let unavailable = 0;
    for (;;) {
      let outcome: InvitationApprovalOutcome;
      try {
        outcome = await ask({
          profile, node, ownerDid, recipientEmail: request.recipientEmail, subjectName: request.subjectName, subjectKind: request.subjectKind,
          accessExpiresAt: request.accessExpiresAt,
          ...(request.contentSha256 === undefined ? {} : { contentSha256: request.contentSha256 }),
          ...(request.requestedDurationMs === undefined ? {} : { requestedDurationMs: request.requestedDurationMs }),
          openkeyHost: process.env.TC_OPENKEY_HOST ?? profileConfig.openkeyHost,
        });
      } catch (error) {
        const failure = operationFailure(error);
        if (failure === undefined) throw error;
        // OpenKey not answering is not "still pending" and not a refusal: ask again a few times, then leave the saved request for the next run.
        if (failure.code === "APPROVAL_UNAVAILABLE" && requestId !== undefined) unavailable += 1;
        if (failure.code === "APPROVAL_UNAVAILABLE" && requestId !== undefined && unavailable < MAX_CONSECUTIVE_UNAVAILABLE) {
          await pause(APPROVAL_POLL_INTERVAL_MS);
          continue;
        }
        throw cliError(failure);
      }
      unavailable = 0;
      if (outcome.status === "approved") return { shareId: outcome.shareId, accessExpiresAt: outcome.accessExpiresAt, resumed: outcome.resumed };
      if (requestId === undefined) {
        requestId = outcome.requestId;
        await showApprovalLink(request, outcome);
      } else if (outcome.requestId !== requestId) {
        // The request this wait showed lapsed unanswered and a new one was made: its link was never shown, and nobody is waiting on it.
        throw new CLIError("APPROVAL_REQUEST_EXPIRED",
          "This approval request expired before it was approved. Run the command again: the next run makes a new request with a new link.", ExitCode.AUTH_REQUIRED);
      }
      await pause(APPROVAL_POLL_INTERVAL_MS);
    }
  };
}

export const approveEmailInviteKey: EmailInviteApprover = createEmailInviteApprover();
