import { Command } from "commander";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, shouldOutputJson, formatTable } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { theme } from "../output/theme.js";

export function registerSpaceCommand(program: Command): void {
  const space = program.command("space").description("Space management");

  space
    .command("list")
    .description("List spaces")
    .action(async (_options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const result = await node.spaces.list();
        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        if (shouldOutputJson()) {
          outputJson({ spaces: result.data, count: result.data.length });
        } else {
          if (result.data.length === 0) {
            process.stdout.write(theme.muted("No spaces found.") + "\n");
          } else {
            const rows = result.data.map((s: any) => [
              s.id || s.spaceId || "—",
              s.name || "—",
              s.owner || "—",
            ]);
            process.stdout.write(formatTable(["Space ID", "Name", "Owner"], rows) + "\n");
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  space
    .command("create <name>")
    .alias("host")
    .description("Create (host) one of your owned spaces by name")
    .action(async (name: string, _options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const spaceId = await node.hostOwnedSpace(name);
        outputJson({ spaceId, name, hosted: true });
      } catch (error) {
        handleError(error);
      }
    });

  space
    .command("info [space-id]")
    .description("Get space info")
    .action(async (spaceId: string | undefined, _options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const targetId = spaceId ?? node.spaceId;
        if (!targetId) {
          throw new CLIError("NO_SPACE", "No space ID specified and no active space", ExitCode.ERROR);
        }

        const profile = await ProfileManager.getProfile(ctx.profile);
        outputJson({
          spaceId: targetId,
          name: profile.spaceName,
          owner: node.did,
          host: ctx.host,
        });
      } catch (error) {
        handleError(error);
      }
    });

  space
    .command("switch <name>")
    .description("Switch active space")
    .action(async (name: string, _options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);

        const profile = await ProfileManager.getProfile(ctx.profile);
        await ProfileManager.setProfile(ctx.profile, { ...profile, spaceName: name });

        outputJson({ profile: ctx.profile, spaceName: name, switched: true });
      } catch (error) {
        handleError(error);
      }
    });
}
