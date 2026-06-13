import { Command } from "commander";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, withSpinner } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode, DEFAULT_HOST, DEFAULT_CHAIN_ID } from "../config/constants.js";
import { generateKey } from "../auth/local-key.js";
import { startAuthFlow } from "../auth/browser-auth.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize a new TinyCloud profile")
    .option("--name <profile>", "Profile name", "default")
    .option("--key-only", "Only generate key, skip authentication")
    .option("--host <url>", "TinyCloud node URL")
    .option("--paste", "Use manual paste mode for authentication")
    .option("--no-popup", "Print the OpenKey URL without opening a browser")
    .option("--default-space <name>", "Default space used when --space is omitted (e.g. applications)")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const profileName: string = options.name;
        const host: string = options.host ?? globalOpts.host ?? DEFAULT_HOST;
        const defaultSpace: string | undefined = options.defaultSpace;
        if (defaultSpace !== undefined && !/^[A-Za-z0-9_-]+$/.test(defaultSpace)) {
          throw new CLIError(
            "INVALID_SPACE",
            `Invalid --default-space "${defaultSpace}". Use a short name ([A-Za-z0-9_-]).`,
            ExitCode.USAGE_ERROR,
          );
        }

        // Check if profile already exists
        if (await ProfileManager.profileExists(profileName)) {
          throw new CLIError(
            "PROFILE_EXISTS",
            `Profile "${profileName}" already exists. Use \`tc profile delete ${profileName}\` first or choose a different name.`,
            ExitCode.ERROR,
          );
        }

        await ProfileManager.ensureConfigDir();

        // Generate key
        const { jwk, did } = await withSpinner("Generating key...", async () => {
          return generateKey();
        });

        await ProfileManager.setKey(profileName, jwk);

        // Create initial profile
        const profileConfig = {
          name: profileName,
          host,
          chainId: DEFAULT_CHAIN_ID,
          spaceName: "default",
          did,
          createdAt: new Date().toISOString(),
          ...(defaultSpace ? { defaultSpace } : {}),
        };

        await ProfileManager.setProfile(profileName, profileConfig);

        // Set as default if this is "default" or no default exists
        const config = await ProfileManager.getConfig();
        if (profileName === "default" || !await ProfileManager.profileExists(config.defaultProfile)) {
          await ProfileManager.setConfig({ ...config, defaultProfile: profileName });
        }

        if (options.keyOnly) {
          outputJson({
            profile: profileName,
            did,
            host,
            authenticated: false,
          });
          return;
        }

        // Auth flow
        const delegationData = await startAuthFlow(did, {
          paste: options.paste,
          noPopup: options.popup === false,
          jwk,
          host,
        });

        // Store session
        await ProfileManager.setSession(profileName, delegationData);

        // Update profile with auth data
        await ProfileManager.setProfile(profileName, {
          ...profileConfig,
          spaceId: delegationData.spaceId,
          ownerDid: delegationData.ownerDid as string | undefined,
        });

        outputJson({
          profile: profileName,
          did,
          host,
          spaceId: delegationData.spaceId,
          authenticated: true,
        });
      } catch (error) {
        handleError(error);
      }
    });
}
