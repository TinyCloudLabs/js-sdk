import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import type { PermissionEntry, TinyCloudNode } from "@tinycloud/node-sdk";
import { startAuthFlow, delegationFromInput } from "../auth/browser-auth.js";
import { sessionStateIsUsable, storedSessionState } from "../auth/scoped-login.js";
import { completeApprovalResult } from "../auth/approval-request.js";
import { APPROVAL_TIMEOUT_OPTION_DESCRIPTION, parseApprovalTimeout, spaceSetupTimeoutMs } from "../auth/approval-wait.js";
import { onboardingHandoff } from "../auth/onboarding-handoff.js";
import { onboardingPlan } from "../auth/onboarding-scope.js";
import { createSpaceRecheck, ensureSpaceSetup } from "../auth/space-setup.js";
import { ExitCode } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import { resolveProfilePosture } from "../config/types.js";
import { resolvePermissionSpaces } from "../lib/permissions.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { CLIError, handleError } from "../output/errors.js";
import { output } from "../output/formatter.js";
import { ensureDelegationAuthority, refreshOpenKeySession, type OpenKeyAcquisition } from "./auth.js";
import { createKeyOnlyProfile } from "./init.js";


export function registerOnboardCommand(program: Command): void {
  program
    .command("onboard")
    .description("Sets up this computer with its owner's OpenKey approval: a 7-day starting grant that renews for up to 30 days (with --with feed, only what the Feed needs). Prints a short approval link, then collects, checks and saves the result. An interrupted run resumes when the same command runs again.")
    .option("--with <tasks>", "Tasks to authorize: apps (default), feed (the Feed only) or apps,feed (keeps the account listing that apps needs)")
    .option("--expiry <duration>", "How long the approval lasts: a number and m, h, d or w, at most 30d. Default 7d, renewing for up to 30 days unless the owner approves without renewal; at 30d there is no renewal")
    .option("--code <code>", "Manual fallback return code only; automatic short-link approvals do not produce a code")
    .option("--timeout <duration>", APPROVAL_TIMEOUT_OPTION_DESCRIPTION)
    .action(async (options, cmd) => {
      try {
        // Refused before anything is created or contacted. One deadline bounds the whole command, every approval in it.
        const plan = onboardingPlan(options.with, options.expiry);
        const { permissions } = plan;
        const steps = [{ permissions }];
        const deadlineMs = options.timeout === undefined ? undefined : Date.now() + parseApprovalTimeout(options.timeout);
        if (options.timeout !== undefined && typeof options.code === "string" && options.code.trim() !== "") {
          throw new CLIError(
            "INVALID_OPTIONS",
            "--timeout can't be used with --code.",
            ExitCode.USAGE_ERROR,
          );
        }
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts, { storedSession: "unused" });
        const created = await ProfileManager.profileExists(ctx.profile) ? undefined : await createKeyOnlyProfile(ctx.profile, ctx.host);
        let profile = await ProfileManager.getProfile(ctx.profile);
        if (resolveProfilePosture(profile) !== "owner-openkey") {
          throw new CLIError(
            "PROFILE_NOT_ONBOARDABLE",
            `Profile "${ctx.profile}" doesn't sign in with OpenKey, so onboarding can't use it. Run \`${CLI_NAME} --profile <new name> onboard\` instead.`,
            ExitCode.USAGE_ERROR,
          );
        }
        await completeApprovalResult(ctx.profile);
        let code = typeof options.code === "string" && options.code.trim() !== "" ? options.code.trim() : undefined;
        let currentStep = 1;
        let approvalCid: string | undefined;
        const acquire: OpenKeyAcquisition = async (did, flow = {}) => {
          const pasted = code;
          code = undefined;
          const approval = pasted !== undefined ? await delegationFromInput(pasted, did, flow) : await startAuthFlow(did, {
            ...flow, profileName: ctx.profile, noPopup: true,
            ...(deadlineMs === undefined ? {} : { approvalWait: { deadlineMs, step: currentStep, of: steps.length } }),
            onApprovalRequest: ({ approvalUrl }) => {
              console.error(`Approve in OpenKey (open the complete link):\n${approvalUrl}\n${deadlineMs === undefined ? "\nWaiting for approval. Re-run this command after an interruption; no code is needed." : ""}`);
            },
          });
          approvalCid = approval.delegationCid;
          return approval;
        };

        // A re-run after SPACE_SETUP_PENDING has a usable session on a space the node does not host yet; the session's space is asked once per run.
        const spaceRecheck = createSpaceRecheck();
        let onboardedNode: TinyCloudNode | undefined;
        let addedGrant = false;
        for (const [index, step] of steps.entries()) {
          // A replica profile signs in through a prepared hand-off, which cannot carry the owner's renewal lease.
          const leaseable = !profile.replication?.prefixes.length;
          currentStep = index + 1;
          const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
          if (!sessionStateIsUsable(storedSessionState(session, profile).state)) {
            const { delegationData } = await refreshOpenKeySession(ctx.profile, ctx.host, {
              permissions: step.permissions,
              reason: leaseable ? plan.asks : plan.finiteAsks,
              expiry: plan.expiry,
              renew: leaseable ? plan.renewalLeaseSeconds ?? false : false,
              persistHost: globalOpts.host !== undefined,
              openKeyAcquisition: acquire,
              ...(created === undefined ? {} : { createdProfile: { previousDefaultProfile: created.previousDefaultProfile } }),
            });
            // A new account's space can take OpenKey a minute or two to host; under --timeout the wait ends with the call's bound.
            await ensureSpaceSetup({ profile: ctx.profile, host: ctx.host }, delegationData, delegationData.permissions as PermissionEntry[] | undefined,
              deadlineMs === undefined ? undefined : spaceSetupTimeoutMs({ deadlineMs, step: currentStep, of: steps.length }));
            // OpenKey's report has decided about the space for this run; no later step asks the node again.
            spaceRecheck.settle();
            profile = await ProfileManager.getProfile(ctx.profile);
            continue;
          }
          await spaceRecheck.check({ profile: ctx.profile, host: ctx.host }, String(session?.spaceId), step.permissions,
            deadlineMs === undefined ? {} : { timeoutMs: spaceSetupTimeoutMs({ deadlineMs, step: currentStep, of: steps.length }) });
          const node = await ensureAuthenticated(ctx);
          const requested = await resolvePermissionSpaces(step.permissions, ctx.profile);
          // ensureDelegationAuthority returns nothing on the OpenKey path, so whether it adds a grant is decided here, as it decides.
          const needsGrant = !node.hasRuntimePermissions(requested);
          await ensureDelegationAuthority({
            ctx,
            profile,
            node,
            requested,
            expiryOption: plan.grant.expiry,
            reason: plan.grant.asks,
            exactApproval: true,
            ...(deadlineMs === undefined ? {} : { spaceSetupTimeoutMs: () => spaceSetupTimeoutMs({ deadlineMs, step: currentStep, of: steps.length }) }),
            openKeyAcquisition: acquire,
          });
          addedGrant ||= needsGrant;
          // A saved grant can cover the task before OpenKey has finished hosting every space.
          // Re-running onboarding rechecks each route even when no new approval is needed.
          await ensureSpaceSetup(ctx, {
            requestedSpaces: [...new Set(requested.map(p => p.space!))].map(spaceId => ({
              space: spaceId, spaceId, spaceReady: null, spacePending: true,
            })),
          }, requested, deadlineMs === undefined ? undefined : spaceSetupTimeoutMs({ deadlineMs, step: currentStep, of: steps.length }),
          async () => ({ node }));
          onboardedNode = node;
        }

        profile = await ProfileManager.getProfile(ctx.profile);
        const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
        // A grant added to an existing sign-in has no lease; a sign-in renews only when its saved session holds the owner's lease.
        const asks = addedGrant ? plan.grant.asks : session?.renewal !== undefined ? plan.asks : plan.finiteAsks;
        const handoff = await onboardingHandoff(permissions, approvalCid, async () => onboardedNode ?? ensureAuthenticated(ctx));
        output({
          onboarded: true,
          profile: ctx.profile,
          ownerDid: profile.ownerDid ?? null,
          host: ctx.host,
          granted: [...new Set(permissions.map(p => p.space))].map(space => ({ space, asks })),
          expiresAt: storedSessionState(session, profile).expiresAt,
          handoff,
        }, () => `Onboarded: profile ${ctx.profile} acts for ${profile.ownerDid ?? "the owner"}.\n  ${asks}\n${"url" in handoff ? handoff.url : handoff.message}`);
      } catch (error) {
        return handleError(error);
      }
    });
}
