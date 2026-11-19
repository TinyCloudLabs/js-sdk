import { homedir } from "node:os";
import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { startAuthFlow, delegationFromInput } from "../auth/browser-auth.js";
import { sessionStateIsUsable, storedSessionState } from "../auth/scoped-login.js";
import { completeApprovalResult } from "../auth/approval-request.js";
import { APPROVAL_TIMEOUT_OPTION_DESCRIPTION, parseApprovalTimeout, spaceSetupTimeoutMs } from "../auth/approval-wait.js";
import { ensureSpaceSetup } from "../auth/space-setup.js";
import { ExitCode } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import { resolveProfilePosture } from "../config/types.js";
import { resolvePermissionSpaces } from "../lib/permissions.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { CLIError, handleError } from "../output/errors.js";
import { output } from "../output/formatter.js";
import { ensureDelegationAuthority, refreshOpenKeySession, type OpenKeyAcquisition } from "./auth.js";
import { onboardGuideLine } from "../output/next.js";
import { createKeyOnlyProfile } from "./init.js";
import { parseDuration } from "../lib/duration.js";

/** The default lifetime of an onboarding approval, and the longest one: OpenKey's maximum. */
const ONBOARD_EXPIRY = "30d";
/** The default lifetime of a goal-scoped onboarding (`--for feed`). */
const GOAL_EXPIRY = "7d";
const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

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

type OnboardStep = (typeof ONBOARD_STEPS)[number];

// The databases of the Feed and the notifications of new answers: the same set `feed connect` needs from the
// owner (the first access request in the /feed guide), and nothing else. Keep in step with FEED_PREFIX and
// REGISTRY in feed.ts.
const FEED_REGISTRY = "xyz.tinycloud.tinychat/home_feed";
const FEED_DATABASES = "xyz.tinycloud.tinychat/feed/";

/** `--for feed`: one approval on the applications space for the feed set only; no account step. */
function feedSteps(lifetime: string): OnboardStep[] {
  return [{
    space: "applications",
    asks: `Create and use your agents' feed databases, and hear about new answers, for ${lifetime}.`,
    permissions: [
      { service: "tinycloud.sql", space: "applications", path: FEED_REGISTRY, actions: sql(["read", "write", "schema"]) },
      { service: "tinycloud.sql", space: "applications", path: FEED_DATABASES, actions: sql(["read", "write", "schema"]) },
      { service: "tinycloud.hooks", space: "applications", path: `sql/${FEED_DATABASES}`, actions: ["tinycloud.hooks/subscribe"] },
    ],
  }];
}

/** `--expiry` as a lifetime in the owner's words (`7 days`), after checking it is a plain number of minutes, hours, days or weeks, no longer than OpenKey allows. */
function parseOnboardExpiry(raw: unknown): { expiry: string; words: string } | undefined {
  if (raw === undefined) return undefined;
  const match = typeof raw === "string" ? /^([1-9]\d*)([mhdw])$/.exec(raw.trim()) : null;
  if (!match) {
    throw new CLIError("INVALID_EXPIRY", `--expiry takes a number and a unit, such as 12h, 7d or 2w (m, h, d or w), not ${JSON.stringify(raw)}.`, ExitCode.USAGE_ERROR);
  }
  const expiry = match[0];
  if (parseDuration(expiry) > MAX_EXPIRY_MS) {
    throw new CLIError("INVALID_EXPIRY", `--expiry can be at most 30 days (30d): that is the longest an OpenKey approval lasts.`, ExitCode.USAGE_ERROR);
  }
  const unit = { m: "minute", h: "hour", d: "day", w: "week" }[match[2]!]!;
  return { expiry, words: `${match[1]} ${unit}${match[1] === "1" ? "" : "s"}` };
}

/** What this run asks for: the starting grant (default) or one goal's set, for the default or the requested lifetime. Refused before anything is created. */
export function onboardPlan(goal: unknown, expiryOption: unknown): { steps: OnboardStep[]; expiry: string } {
  if (goal !== undefined && goal !== "feed") {
    throw new CLIError("INVALID_OPTIONS", `--for takes "feed" (the only goal so far), not ${JSON.stringify(goal)}. Leave it out for the full starting grant.`, ExitCode.USAGE_ERROR);
  }
  const requested = parseOnboardExpiry(expiryOption);
  const expiry = requested?.expiry ?? (goal === undefined ? ONBOARD_EXPIRY : GOAL_EXPIRY);
  const words = requested?.words ?? (goal === undefined ? "30 days" : "7 days");
  if (goal === "feed") return { steps: feedSteps(words), expiry };
  return { steps: ONBOARD_STEPS.map((step) => ({ ...step, asks: step.asks.replace(/ for 30 days\.$/, ` for ${words}.`) })), expiry };
}


export function registerOnboardCommand(program: Command): void {
  program
    .command("onboard")
    .description("Set up this computer with its owner's OpenKey approvals and a starting grant for 30 days; with --for feed, only what the Feed needs, for 7 days. OpenKey displays the requested permissions separately; no generated free-text reason is sent. Prints a short approval link, automatically retrieves and verifies the result, saves it durably, then acknowledges delivery. Re-run an interrupted command to resume.")
    .option("--code <code>", "Manual fallback return code only; automatic short-link approvals do not produce a code")
    .option("--timeout <duration>", APPROVAL_TIMEOUT_OPTION_DESCRIPTION)
    .option("--for <goal>", "Ask only for what one goal needs: feed (the Feed's databases and answer notifications, no account step; 7 days unless --expiry)")
    .option("--expiry <duration>", "How long the approval lasts: a number and m, h, d or w, at most 30d (default 30d; 7d with --for feed)")
    .action(async (options, cmd) => {
      try {
        // Refused before anything is created or contacted. One deadline bounds the whole command, every approval in it.
        const deadlineMs = options.timeout === undefined ? undefined : Date.now() + parseApprovalTimeout(options.timeout);
        if (options.timeout !== undefined && typeof options.code === "string" && options.code.trim() !== "") {
          throw new CLIError(
            "INVALID_OPTIONS",
            `--code and --timeout cannot be used together: running the command again would send the same code to the next approval step. Run \`${CLI_NAME} onboard --code <code>\` without --timeout.`,
            ExitCode.USAGE_ERROR,
          );
        }
        const plan = onboardPlan(options.for, options.expiry);
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
        const acquire: OpenKeyAcquisition = async (did, flow = {}) => {
          if (code !== undefined) {
            const pasted = code;
            code = undefined;
            return delegationFromInput(pasted, did, flow);
          }
          return startAuthFlow(did, {
            ...flow, profileName: ctx.profile, noPopup: true,
            ...(deadlineMs === undefined ? {} : { approvalWait: { deadlineMs, step: currentStep, of: plan.steps.length } }),
            onApprovalRequest: ({ approvalUrl }) => {
              console.error(`Approve in OpenKey (open the complete link):\n${approvalUrl}\n${deadlineMs === undefined ? "\nWaiting for approval. Re-run this command after an interruption; no code is needed." : ""}`);
            },
          });
        };

        for (const [index, step] of plan.steps.entries()) {
          currentStep = index + 1;
          const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
          if (!sessionStateIsUsable(storedSessionState(session, profile).state)) {
            const { delegationData } = await refreshOpenKeySession(ctx.profile, ctx.host, {
              permissions: step.permissions,
              expiry: plan.expiry,
              persistHost: globalOpts.host !== undefined,
              openKeyAcquisition: acquire,
              ...(created === undefined ? {} : { createdProfile: { previousDefaultProfile: created.previousDefaultProfile } }),
            });
            // A new account's space can take OpenKey a minute or two to host; under --timeout the wait ends with the call's bound.
            await ensureSpaceSetup({ profile: ctx.profile, host: ctx.host }, delegationData, delegationData.permissions as PermissionEntry[] | undefined,
              deadlineMs === undefined ? undefined : spaceSetupTimeoutMs({ deadlineMs, step: currentStep, of: plan.steps.length }));
            profile = await ProfileManager.getProfile(ctx.profile);
            continue;
          }
          await ensureDelegationAuthority({
            ctx,
            profile,
            node: await ensureAuthenticated(ctx),
            requested: await resolvePermissionSpaces(step.permissions, ctx.profile),
            expiryOption: plan.expiry,
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
          granted: plan.steps.map(({ space, asks }) => ({ space, asks })),
          expiresAt: storedSessionState(session, profile).expiresAt,
        }, () => `Onboarded: profile ${ctx.profile} acts for ${profile.ownerDid ?? "the owner"}.\n${plan.steps.map(({ asks }) => `  ${asks}`).join("\n")}`);
        if (globalOpts.quiet !== true) {
          const next = onboardGuideLine({ home: homedir(), env: process.env });
          if (next !== undefined) process.stderr.write(`${next}\n`);
        }
      } catch (error) {
        return handleError(error);
      }
    });
}
