import type { PermissionEntry } from "@tinycloud/node-sdk";
import { invokeOperation } from "@tinycloud/operations";
import { Command } from "commander";

import { ExitCode } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import { compactPermission } from "../lib/permissions.js";
import { CLIError, cliErrorFromService, handleError } from "../output/errors.js";
import { outputJson } from "../output/formatter.js";

export function registerPersonHistoryCommand(program: Command): void {
  program.command("person-history <person>")
    .description("Read your Contacts and Inbox history with a person as JSON")
    .option("--limit <count>", "Conversations per page (1–50, default 20)")
    .option("--cursor <token>", "Continue the same lookup from nextCursor")
    .option("--no-previews", "Do not read Inbox message bodies")
    .action(async (person: string, options: { limit?: string; cursor?: string; previews: boolean }, cmd: Command) => {
      try {
        const { profile, host } = await ProfileManager.resolveContext(cmd.optsWithGlobals());
        const result = await invokeOperation("tinycloud.person.history", 1, { profile, host, allowOwnerProfile: true }, {
          person,
          ...(options.limit === undefined ? {} : { limit: Number(options.limit) }),
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          includePreviews: options.previews,
        });
        switch (result.status) {
          case "ok":
            outputJson(result.output);
            return;
          case "authority_required": {
            const missing = result.missing.map((entry) => compactPermission(entry as unknown as PermissionEntry)).join("; ");
            throw new CLIError("PERMISSION_DENIED", `The selected profile needs the owner's approval to read: ${missing}`, ExitCode.PERMISSION_DENIED);
          }
          case "setup_required":
            throw new CLIError("SETUP_REQUIRED", "Person history needs a scoped TinyCloud profile.", ExitCode.ERROR);
          case "error":
            if (result.error.code === "INPUT_INVALID") {
              throw new CLIError("INVALID_ARGUMENT", "Use a name, email, or @handle; choose a limit from 1 to 50 and a cursor from the same lookup.", ExitCode.USAGE_ERROR);
            }
            if (result.error.code === "SESSION_NOT_FOUND" || result.context.posture === "unauthenticated") {
              throw new CLIError("AUTH_REQUIRED", "Sign in to the selected profile with the owner's scoped history grants.", ExitCode.AUTH_REQUIRED);
            }
            throw cliErrorFromService(result.error);
        }
      } catch (error) {
        return handleError(error);
      }
    });
}
