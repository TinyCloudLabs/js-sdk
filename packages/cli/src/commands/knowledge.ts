import { Command } from "commander";
import { invokeOperation, type OperationResult } from "@tinycloud/operations";
import { CLI_NAME } from "@tinycloud/operations/cli-name";

import { withSignInHint } from "../auth/session-expired.js";
import { ExitCode } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import { APPS_AGENT_PRESET, APPS_AGENT_SPACE } from "../lib/apps-agent-preset.js";
import { compactPermission } from "../lib/permissions.js";
import { CLIError, cliErrorFromService, handleError } from "../output/errors.js";
import { formatTable, outputJson, shouldOutputJson, withSpinner } from "../output/formatter.js";
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
        const ctx = await ProfileManager.resolveContext(cmd.optsWithGlobals());
        const result = await withSpinner("Listing installed apps...", () =>
          invokeOperation(
            "tinycloud.knowledge.list",
            1,
            { profile: ctx.profile, host: ctx.host, allowOwnerProfile: true },
            options.app === undefined ? {} : { app_id: options.app },
          ));
        if (result.status !== "ok") throw knowledgeFailure(result, ctx.profile);
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
        process.stdout.write(
          formatTable(
            ["App ID", "Name", "Root", "Concepts"],
            output.apps.map((app) => [
              app.app_id,
              app.name ?? "—",
              app.has_index ? app.root : `${app.root} (no index)`,
              String(app.concepts.length),
            ]),
          ) + "\n",
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
    .action(async (appId: string, concept: string | undefined, _options: unknown, cmd: Command) => {
      try {
        const ctx = await ProfileManager.resolveContext(cmd.optsWithGlobals());
        const result = await withSpinner("Reading knowledge...", () =>
          invokeOperation(
            "tinycloud.knowledge.read",
            1,
            { profile: ctx.profile, host: ctx.host, allowOwnerProfile: true },
            { app_id: appId, ...(concept === undefined ? {} : { concept }) },
          ));
        if (result.status !== "ok") throw knowledgeFailure(result, ctx.profile);
        const output = result.output as { key: string; frontmatter: unknown; body: string };
        if (shouldOutputJson()) {
          outputJson(result.output);
          return;
        }
        process.stdout.write(`${theme.heading(output.key)}\n`);
        if (output.frontmatter !== null) process.stdout.write(`${JSON.stringify(output.frontmatter)}\n`);
        process.stdout.write(`\n${output.body}${output.body.endsWith("\n") ? "" : "\n"}`);
      } catch (error) {
        return handleError(error);
      }
    });
}

/** Map a non-ok operation result to the CLI error: missing grant is exit 5 with the `--cap` to request. */
function knowledgeFailure(result: Exclude<KnowledgeResult, { status: "ok" }>, profile: string): CLIError {
  switch (result.status) {
    case "authority_required": {
      const caps = result.missing.map((entry) => `--cap ${compactPermission(entry as never)}`);
      return new CLIError(
        "PERMISSION_DENIED",
        `This profile has no grant for that. Missing: ${result.missing.map((entry) => compactPermission(entry as never)).join("; ")}`,
        ExitCode.PERMISSION_DENIED,
        { hint: missingGrantHint(profile, caps) },
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
          hint: missingGrantHint(profile, []),
        });
      }
      return withSignInHint(cliErrorFromService(result.error), result.context.profile, result.context.posture);
    }
  }
}

function missingGrantHint(profile: string, caps: readonly string[]): string {
  const exact = caps.length === 0
    ? `--cap tinycloud.kv:${APPS_AGENT_SPACE}::get,list`
    : caps.join(" ");
  const request = `${CLI_NAME} --profile ${profile} auth request`;
  return [
    `Ask the owner for a grant, narrowest first. Create the request:`,
    `  ${request} ${exact} --emit req.json`,
    `  ${request} --preset ${APPS_AGENT_PRESET} --app <app_id> --emit req.json   (one app, recommended)`,
    `  ${request} --preset ${APPS_AGENT_PRESET} --emit req.json   (all installed apps)`,
    `The owner runs \`${CLI_NAME} auth grant req.json\`; then import the result with \`${CLI_NAME} --profile ${profile} auth import <grant.json>\`.`,
  ].join("\n");
}
