import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, withSpinner } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ExitCode, DEFAULT_HOST, DEFAULT_CHAIN_ID } from "../config/constants.js";
import { generateKey } from "../auth/local-key.js";
import { refreshOpenKeySession } from "./auth.js";
import { ensureSpaceSetup } from "../auth/space-setup.js";
import { hasPendingSignIn } from "../auth/approval-request.js";
import { parseApprovalTimeout, spaceSetupTimeoutMs } from "../auth/approval-wait.js";
import { SIGN_IN_TIMEOUT_OPTION_DESCRIPTION } from "../auth/sign-in-timeout.js";

/**
 * A new profile with a fresh session key and no sign-in, as `init --key-only`
 * makes it. It becomes the default profile when it is named `default` or no
 * default profile exists yet.
 */
export async function createKeyOnlyProfile(profileName: string, host: string, defaultSpace?: string): Promise<{ did: string; previousDefaultProfile: string }> {
  await ProfileManager.ensureConfigDir();
  const { jwk, did } = await generateKey();
  await ProfileManager.setKey(profileName, jwk);
  await ProfileManager.setProfile(profileName, {
    name: profileName,
    host,
    chainId: DEFAULT_CHAIN_ID,
    spaceName: "default",
    did,
    createdAt: new Date().toISOString(),
    ...(defaultSpace ? { defaultSpace } : {}),
  });
  const config = await ProfileManager.getConfig();
  if (profileName === "default" || !await ProfileManager.profileExists(config.defaultProfile)) {
    await ProfileManager.setConfig({ ...config, defaultProfile: profileName });
  }
  // What the default profile was before this one: removing the profile again restores it.
  return { did, previousDefaultProfile: config.defaultProfile };
}

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
    .option("--timeout <duration>", `OpenKey sign-in only (not --paste or --key-only). ${SIGN_IN_TIMEOUT_OPTION_DESCRIPTION}`)
    .action(async (options, cmd) => {
      try {
        // Refused before anything is created or contacted. A sign-in is one approval: step 1 of 1.
        const approvalWait = options.timeout === undefined ? undefined : { deadlineMs: Date.now() + parseApprovalTimeout(options.timeout), step: 1, of: 1 };
        if (approvalWait && (options.paste || options.keyOnly)) {
          throw new CLIError("INVALID_ARGUMENT", "--timeout applies only to an OpenKey sign-in through an approval link; it can't be used with --paste or --key-only.", ExitCode.USAGE_ERROR);
        }
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

        // An existing profile is refused, except one an earlier `init` created whose sign-in is still waiting for the
        // owner's approval (exit 8, or an interrupted run): the rerun resumes that same approval link.
        let created: { did: string; previousDefaultProfile: string } | undefined;
        let did: string;
        if (await ProfileManager.profileExists(profileName)) {
          const existing = await ProfileManager.getProfile(profileName);
          const resumable = !options.keyOnly && existing.authMethod === undefined &&
            await ProfileManager.getSession(profileName) === null && await hasPendingSignIn(profileName);
          if (!resumable) {
            throw new CLIError(
              "PROFILE_EXISTS",
              `Profile "${profileName}" already exists. Use \`${CLI_NAME} profile delete ${profileName}\` first or choose a different name.`,
              ExitCode.ERROR,
            );
          }
          did = existing.did;
        } else {
          created = await withSpinner("Generating key...", () => createKeyOnlyProfile(profileName, host, defaultSpace));
          did = created.did;
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

        // Same verified, lock-protected browser login as `tc auth login`: the
        // owner and expiry come only from the signed proof.
        const { delegationData } = await refreshOpenKeySession(profileName, host, {
          paste: options.paste,
          noPopup: options.popup === false,
          persistHost: true,
          ...(created === undefined ? {} : { createdProfile: { previousDefaultProfile: created.previousDefaultProfile } }),
          ...(approvalWait === undefined ? {} : { approvalWait }),
        });
        await ensureSpaceSetup({ profile: profileName, host }, delegationData, delegationData.permissions as PermissionEntry[] | undefined,
          approvalWait === undefined ? undefined : spaceSetupTimeoutMs(approvalWait));

        outputJson({
          profile: profileName,
          did,
          host,
          spaceId: delegationData.spaceId,
          authenticated: true,
        });
      } catch (error) {
        return handleError(error);
      }
    });
}
