import { Command } from "commander";
import { loginWithDeviceAuthorization } from "../auth/device-auth.js";
import { DEFAULT_SHARE_ORIGIN } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import { handleError } from "../output/errors.js";
import { output } from "../output/formatter.js";
import { sharePublishingPermissions } from "../share/publishing-manifest.js";

export function registerEnableCommand(program: Command): void {
  const enable = program.command("enable").description("Enable a narrowly scoped TinyCloud service");

  enable.command("share")
    .description("Approve Share publishing scope through OpenKey device authorization (same as `tc auth login --device --manifest builtin:share-publishing`). Use a dedicated profile, e.g. `tc init --name publisher --key-only && tc --profile publisher enable share`; keep existing profiles for their apps.")
    .option("--replace-session", "Replace this profile's live session even though the new scope would narrow, change or shorten it (prefer a new profile)")
    .action(async (options, command) => {
      try {
        const globalOptions = command.optsWithGlobals();
        const context = await ProfileManager.resolveContext(globalOptions);
        const { profile, result } = await loginWithDeviceAuthorization({
          profileName: context.profile,
          nodeOrigin: context.host,
          shareOrigin: DEFAULT_SHARE_ORIGIN,
          permissions: sharePublishingPermissions(),
          reason: "Allow this TinyCloud CLI profile to publish Share links.",
          replaceSession: options.replaceSession === true,
          persistHost: globalOptions.host !== undefined,
        });
        const value = {
          enabled: true,
          service: "share",
          profile: context.profile,
          sessionDid: profile.sessionDid ?? profile.did,
          ownerDid: result.ownerDid,
          spaceId: result.spaceId,
          permissions: result.approved,
          declined: result.declined,
          expiresAt: result.expiresAt,
        };
        output(value, () => result.declined.length === 0
          ? `Share enabled for profile ${context.profile}.`
          : `Share enabled for profile ${context.profile} with ${result.declined.length} capability group(s) declined; publishing may fail.`);
      } catch (error) {
        return handleError(error);
      }
    });
}
