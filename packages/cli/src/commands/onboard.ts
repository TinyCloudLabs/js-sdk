import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { buildAuthUrl, delegationFromInput } from "../auth/browser-auth.js";
import { sessionStateIsUsable, storedSessionState } from "../auth/scoped-login.js";
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
    asks: "Read and change your apps' data for 30 days.",
    permissions: [{ service: "tinycloud.kv", space: "applications", path: "", actions: kv(["get", "list", "put", "del", "metadata"]) }],
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

/** The next approval is the owner's: here is its link. */
class ApprovalNeeded extends Error {
  constructor(readonly approvalUrl: string) {
    super("approval needed");
  }
}

export function registerOnboardCommand(program: Command): void {
  program
    .command("onboard")
    .description(`Set up this computer to act for its owner: a profile, the owner's OpenKey sign-in (or new account), and a starting grant for 30 days (read and change the applications space; read which spaces and apps exist). Each run does the next approval: it prints the approval link and exits ${ExitCode.PENDING}; run it again with the code OpenKey shows. Exits 0 when onboarding is complete.`)
    .option("--code <code>", "The code OpenKey showed after the owner approved the last link")
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
        // Never waits: the first approval this run meets uses the code, and
        // the next one ends the run with that approval's link.
        let code = typeof options.code === "string" && options.code.trim() !== "" ? options.code.trim() : undefined;
        const acquire: OpenKeyAcquisition = async (did, flow = {}) => {
          if (code === undefined) throw new ApprovalNeeded(buildAuthUrl(did, flow));
          const pasted = code;
          code = undefined;
          return delegationFromInput(pasted, did, flow);
        };

        for (const [index, step] of ONBOARD_STEPS.entries()) {
          const reason = `TinyCloud onboarding, step ${index + 1} of ${ONBOARD_STEPS.length}: ${step.asks}`;
          try {
            const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
            if (!sessionStateIsUsable(storedSessionState(session, profile).state)) {
              // No usable session: this approval signs the owner in and grants the step.
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
            // Signed in: add the step's grant unless the session or an earlier grant covers it.
            await ensureDelegationAuthority({
              ctx,
              profile,
              node: await ensureAuthenticated(ctx),
              requested: await resolvePermissionSpaces(step.permissions, ctx.profile),
              expiryOption: ONBOARD_EXPIRY,
              reason,
              yes: true,
              openKeyAcquisition: acquire,
            });
          } catch (error) {
            if (!(error instanceof ApprovalNeeded)) throw error;
            const next = `${CLI_NAME} --profile ${ctx.profile} onboard --code <code>`;
            output({
              onboarded: false,
              profile: ctx.profile,
              step: index + 1,
              steps: ONBOARD_STEPS.length,
              asks: step.asks,
              approvalUrl: error.approvalUrl,
              next,
            }, () => [
              `Step ${index + 1} of ${ONBOARD_STEPS.length}: ${step.asks}`,
              `Open this link, sign in or create an account, and approve:`,
              `  ${error.approvalUrl}`,
              `Then run: ${next}`,
            ].join("\n"));
            process.exitCode = ExitCode.PENDING;
            return;
          }
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
