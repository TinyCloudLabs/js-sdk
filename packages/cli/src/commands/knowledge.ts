import type { PermissionEntry } from "@tinycloud/node-sdk";
import { Command } from "commander";
import { invokeOperation, type OperationResult } from "@tinycloud/operations";
import { CLI_NAME } from "@tinycloud/operations/cli-name";

import { withSignInHint } from "../auth/session-expired.js";
import { ExitCode } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import { APPS_AGENT_PRESET, APPS_AGENT_SPACE } from "../lib/apps-agent-preset.js";
import { assertKnowledgeAppId, assertKnowledgeConcept } from "../lib/knowledge-input.js";
import { compactPermission } from "../lib/permissions.js";
import { CLIError, cliErrorFromService, handleError } from "../output/errors.js";
import { formatTable, outputJson, shouldOutputJson, withSpinner } from "../output/formatter.js";
import { knowledgeListRows, knowledgeReadParts } from "../lib/knowledge-render.js";
import { theme } from "../output/theme.js";

type KnowledgeResult = OperationResult<unknown>;

export function registerKnowledgeCommand(program: Command): void {
  const knowledge = program
    .command("knowledge")
    .description("Read the knowledge bundles of apps installed in a user's TinyCloud");

  knowledge
    .command("list")
    .description("List installed apps that carry a knowledge bundle (`<app_id>/knowledge/index.md` in the applications space)")
    .option("--app <app_id>", "Only this app; works with a grant scoped to that app")
    .action(async (options: { app?: string }, cmd: Command) => {
      try {
        const appId = options.app === undefined ? undefined : assertKnowledgeAppId(options.app);
        const ctx = await ProfileManager.resolveContext(cmd.optsWithGlobals());
        const result = await withSpinner("Listing installed apps...", () =>
          invokeOperation(
            "tinycloud.knowledge.list",
            1,
            { profile: ctx.profile, host: ctx.host, allowOwnerProfile: true },
            appId === undefined ? {} : { app_id: appId },
          ));
        if (result.status !== "ok") throw knowledgeFailure(result, ctx.profile, appId);
        const output = result.output as {
          apps: { app_id: string; name?: string; root: string; has_index: boolean; concepts: string[] }[];
          truncated: boolean;
        };
        if (shouldOutputJson()) {
          outputJson(result.output);
          return;
        }
        if (output.apps.length === 0) {
          process.stdout.write(theme.muted("No installed apps with a knowledge bundle found.") + "\n");
          return;
        }
        // App ids and names are written by other parties: the renderer escapes them.
        process.stdout.write(
          formatTable(["App ID", "Name", "Root", "Concepts"], knowledgeListRows(output.apps)) + "\n",
        );
        if (output.truncated) {
          process.stderr.write(theme.warn("The applications space has more keys than one listing covers; some apps may be missing.") + "\n");
        }
      } catch (error) {
        return handleError(error);
      }
    });

  knowledge
    .command("read <app_id> [concept]")
    .description("Read an app's knowledge index, or one concept (for example tables/meal.md), with frontmatter parsed")
    .action(async (appIdArgument: string, conceptArgument: string | undefined, _options: unknown, cmd: Command) => {
      try {
        const appId = assertKnowledgeAppId(appIdArgument);
        const concept = conceptArgument === undefined ? undefined : assertKnowledgeConcept(conceptArgument);
        const ctx = await ProfileManager.resolveContext(cmd.optsWithGlobals());
        const result = await withSpinner("Reading knowledge...", () =>
          invokeOperation(
            "tinycloud.knowledge.read",
            1,
            { profile: ctx.profile, host: ctx.host, allowOwnerProfile: true },
            { app_id: appId, ...(concept === undefined ? {} : { concept }) },
          ));
        if (result.status !== "ok") throw knowledgeFailure(result, ctx.profile, appId);
        const output = result.output as { key: string; frontmatter: unknown; body: string };
        if (shouldOutputJson()) {
          outputJson(result.output);
          return;
        }
        const parts = knowledgeReadParts(output);
        process.stdout.write(`${theme.heading(parts.heading)}\n`);
        if (parts.meta !== undefined) process.stdout.write(`${parts.meta}\n`);
        process.stdout.write(`\n${parts.body}`);
      } catch (error) {
        return handleError(error);
      }
    });
}

/** Map a non-ok operation result to the CLI error: a grant that does not cover the request is exit 5 with what to ask for. */
function knowledgeFailure(
  result: Exclude<KnowledgeResult, { status: "ok" }>,
  profile: string,
  appId: string | undefined,
): CLIError {
  switch (result.status) {
    case "authority_required": {
      return new CLIError(
        "PERMISSION_DENIED",
        `This profile has no grant for that. Missing: ${result.missing.map((entry) => compactPermission(entry as unknown as PermissionEntry)).join("; ")}`,
        ExitCode.PERMISSION_DENIED,
        { hint: missingGrantHint(profile, appId) },
      );
    }
    case "setup_required":
      return new CLIError("SETUP_REQUIRED", "The operation needs setup before it can run.", ExitCode.ERROR);
    case "error": {
      if (result.error.code === "SESSION_NOT_FOUND" ||
        (result.error.code === "PROFILE_POSTURE_NOT_ALLOWED" && result.context.posture === "unauthenticated")) {
        return new CLIError("AUTH_REQUIRED", "Not signed in to TinyCloud.", ExitCode.AUTH_REQUIRED, {
          hint: `Sign in with: ${CLI_NAME} --profile ${result.context.profile} auth login`,
        });
      }
      if (result.error.code === "NODE_UNREACHABLE") {
        return new CLIError("NETWORK_ERROR", result.error.message, ExitCode.NETWORK_ERROR);
      }
      if (result.error.code === "KV_NOT_FOUND") {
        return new CLIError(
          "NOT_FOUND",
          "No such knowledge file. Run `knowledge list` for the installed apps, then `knowledge read <app_id>` for the index.",
          ExitCode.NOT_FOUND,
        );
      }
      if (result.error.code === "PERMISSION_DENIED") {
        return new CLIError("PERMISSION_DENIED", result.error.message, ExitCode.PERMISSION_DENIED, {
          hint: missingGrantHint(profile, appId),
        });
      }
      if (result.error.code === "INPUT_INVALID") {
        return new CLIError(
          "INVALID_ARGUMENT",
          "The app id or concept is not valid. An app id looks like xyz.example.app; a concept is a path inside the app's knowledge folder, such as app or tables/meal.md.",
          ExitCode.USAGE_ERROR,
        );
      }
      return withSignInHint(cliErrorFromService(result.error), result.context.profile, result.context.posture);
    }
  }
}

/** The ways to ask for access, narrowest first, with the real app id when the command knows it. */
function missingGrantHint(profile: string, appId: string | undefined): string {
  const request = `${CLI_NAME} --profile ${profile} auth request`;
  const lines = appId === undefined
    ? [
      `  ${request} --preset ${APPS_AGENT_PRESET} --emit req.json   (read-only, all installed apps)`,
      `  ${request} --cap tinycloud.kv:${APPS_AGENT_SPACE}::get,list --emit req.json   (all files, no table access)`,
      "To limit the grant to one app, add `--app` and that app's id to the first command (repeat `--app` for up to 5).",
    ]
    : [
      `  ${request} --preset ${APPS_AGENT_PRESET} --app ${appId} --emit req.json   (read-only: files and tables of ${appId})`,
      `  ${request} --cap tinycloud.kv:${APPS_AGENT_SPACE}:${appId}/knowledge/:get,list --emit req.json   (only ${appId}'s knowledge)`,
      `To change the app's data, ask for write access: ${request} --preset ${APPS_AGENT_PRESET} --write --app ${appId} --emit req.json`,
    ];
  return [
    "Ask the owner for a grant, narrowest first. Create the request:",
    ...lines,
    `The owner runs \`${CLI_NAME} auth grant req.json > grant.json\`; then import the result with \`${CLI_NAME} --profile ${profile} auth import grant.json\`.`,
  ].join("\n");
}
