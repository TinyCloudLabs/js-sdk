import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { startAuthFlow, delegationFromInput } from "../auth/browser-auth.js";
import { sessionStateIsUsable, storedSessionState } from "../auth/scoped-login.js";
import { completeApprovalResult } from "../auth/approval-request.js";
import { ensureSpaceSetup } from "../auth/space-setup.js";
import { ExitCode } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import { resolveProfilePosture } from "../config/types.js";
import { resolvePermissionSpaces } from "../lib/permissions.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { CLIError, handleError } from "../output/errors.js";
import { output } from "../output/formatter.js";
import { ensureDelegationAuthority, refreshOpenKeySession, type OpenKeyAcquisition } from "./auth.js";
import { createKeyOnlyProfile } from "./init.js";

/** Lifetime of every onboarding approval: OpenKey's maximum. */
const ONBOARD_EXPIRY = "30d";

const kv = (actions: string[]) => actions.map((action) => `tinycloud.kv/${action}`);
const sql = (actions: string[]) => actions.map((action) => `tinycloud.sql/${action}`);

/**
 * The starting grant, one OpenKey approval per space: OpenKey signs one space
 * per approval. The first approval also signs the owner in (or lets them
 * create an account) and hosts their spaces.
 */
export const ONBOARD_STEPS: ReadonlyArray<{
  space: string;
  /** What the approval gives, in the owner's words. */
  asks: string;
  permissions: PermissionEntry[];
}> = [
  {
    space: "applications",
    asks: "Read, change and delete your apps' data for 30 days.",
    permissions: [
      { service: "tinycloud.kv", space: "applications", path: "", actions: kv(["get", "list", "put", "del", "metadata"]) },
      { service: "tinycloud.sql", space: "applications", path: "", actions: sql(["read", "write"]) },
    ],
  },
  {
    space: "account",
    asks: "See which spaces and apps you have, read-only, for 30 days.",
    permissions: [
      { service: "tinycloud.kv", space: "account", path: "spaces/", actions: kv(["get", "list"]) },
      { service: "tinycloud.kv", space: "account", path: "applications/", actions: kv(["get", "list"]) },
    ],
  },
];


export function registerOnboardCommand(program: Command): void {
  program
    .command("onboard")
    .description("Set up this computer with its owner's OpenKey approvals and a starting grant for 30 days. Prints a short approval link, automatically retrieves and verifies the result, saves it durably, then acknowledges delivery. Re-run an interrupted command to resume.")
    .option("--code <code>", "Manual fallback return code only; automatic short-link approvals do not produce a code")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts, { storedSession: "unused" });
        if (!await ProfileManager.profileExists(ctx.profile)) await createKeyOnlyProfile(ctx.profile, ctx.host);
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
        const acquire: OpenKeyAcquisition = async (did, flow = {}) => {
          if (code !== undefined) {
            const pasted = code;
            code = undefined;
            return delegationFromInput(pasted, did, flow);
          }
          return startAuthFlow(did, {
            ...flow, profileName: ctx.profile, noPopup: true,
            onApprovalRequest: ({ approvalUrl }) => {
              console.error(`${flow.reason}\nApprove in OpenKey: ${approvalUrl}\nWaiting for approval. Re-run this command after an interruption; no code is needed.`);
            },
          });
        };

        for (const [index, step] of ONBOARD_STEPS.entries()) {
          const reason = `TinyCloud onboarding, step ${index + 1} of ${ONBOARD_STEPS.length}: ${step.asks}`;
          const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
          if (!sessionStateIsUsable(storedSessionState(session, profile).state)) {
            const { delegationData } = await refreshOpenKeySession(ctx.profile, ctx.host, {
              permissions: step.permissions,
              expiry: ONBOARD_EXPIRY,
              reason,
              persistHost: globalOpts.host !== undefined,
              openKeyAcquisition: acquire,
            });
            await ensureSpaceSetup({ profile: ctx.profile, host: ctx.host }, delegationData, delegationData.permissions as PermissionEntry[] | undefined);
            profile = await ProfileManager.getProfile(ctx.profile);
            continue;
          }
          await ensureDelegationAuthority({
            ctx,
            profile,
            node: await ensureAuthenticated(ctx),
            requested: await resolvePermissionSpaces(step.permissions, ctx.profile),
            expiryOption: ONBOARD_EXPIRY,
            reason,
            yes: true,
            exactApproval: true,
            openKeyAcquisition: acquire,
          });
        }

        profile = await ProfileManager.getProfile(ctx.profile);
        const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
        output({
          onboarded: true,
          profile: ctx.profile,
          ownerDid: profile.ownerDid ?? null,
          host: ctx.host,
          granted: ONBOARD_STEPS.map(({ space, asks }) => ({ space, asks })),
          expiresAt: storedSessionState(session, profile).expiresAt,
        }, () => `Onboarded: profile ${ctx.profile} acts for ${profile.ownerDid ?? "the owner"}.\n${ONBOARD_STEPS.map(({ asks }) => `  ${asks}`).join("\n")}`);
      } catch (error) {
        return handleError(error);
      }
    });
}
