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
    .description("Approve Share publishing scope through OpenKey device authorization (same as `tc auth login --device --manifest builtin:share-publishing`)")
    .action(async (_options, command) => {
      try {
        const context = await ProfileManager.resolveContext(command.optsWithGlobals());
        const { profile, result } = await loginWithDeviceAuthorization({
          profileName: context.profile,
          nodeOrigin: context.host,
          shareOrigin: DEFAULT_SHARE_ORIGIN,
          permissions: sharePublishingPermissions(),
          reason: "Allow this TinyCloud CLI profile to publish Share links.",
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
        handleError(error);
      }
    });
}
