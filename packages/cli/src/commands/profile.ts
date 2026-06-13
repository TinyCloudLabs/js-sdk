import { Command } from "commander";
import { createInterface } from "node:readline";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, isInteractive, shouldOutputJson, formatField } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { generateKey } from "../auth/local-key.js";
import { theme } from "../output/theme.js";
import {
  CLI_OPERATOR_TYPES,
  CLI_PROFILE_POSTURES,
  isCLIOperatorType,
  isCLIProfilePosture,
  resolveProfileOperatorType,
  resolveProfilePosture,
  type CLIOperatorType,
  type CLIProfilePosture,
} from "../config/types.js";

export function registerProfileCommand(program: Command): void {
  const profile = program.command("profile").description("Profile management");

  profile
    .command("list")
    .description("List all profiles")
    .action(async (_options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const config = await ProfileManager.getConfig();
        const names = await ProfileManager.listProfiles();

        const profiles = await Promise.all(
          names.map(async (name) => {
            try {
              const p = await ProfileManager.getProfile(name);
              return {
                name: p.name,
                host: p.host,
                did: p.did,
                posture: resolveProfilePosture(p),
                operatorType: resolveProfileOperatorType(p),
                active: name === config.defaultProfile,
              };
            } catch {
              return {
                name,
                host: null,
                did: null,
                posture: null,
                operatorType: null,
                active: name === config.defaultProfile,
              };
            }
          })
        );

        if (shouldOutputJson()) {
          outputJson({
            profiles,
            defaultProfile: config.defaultProfile,
          });
        } else {
          for (const p of profiles) {
            const marker = p.active ? theme.success("● ") : "  ";
            const name = p.active ? theme.brand(p.name) : p.name;
            const host = theme.muted(p.host || "no host");
            const posture = p.posture ? theme.muted(String(p.posture)) : theme.muted("no posture");
            process.stdout.write(`${marker}${name}  ${host}  ${posture}\n`);
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command("create <name>")
    .description("Create a new profile")
    .option("--host <url>", "TinyCloud node URL")
    .option(
      "--posture <posture>",
      `Profile posture: ${CLI_PROFILE_POSTURES.join(", ")}. Defaults to owner-openkey.`,
    )
    .option(
      "--operator <type>",
      `Operator type: ${CLI_OPERATOR_TYPES.join(", ")}. Defaults to human.`,
    )
    .action(async (name: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const host = options.host ?? globalOpts.host ?? "https://node.tinycloud.xyz";
        const posture = parseProfilePosture(options.posture);
        const operatorType = parseOperatorType(options.operator);

        if (await ProfileManager.profileExists(name)) {
          throw new CLIError("PROFILE_EXISTS", `Profile "${name}" already exists`, ExitCode.ERROR);
        }

        await ProfileManager.ensureConfigDir();
        const { jwk, did } = generateKey();
        await ProfileManager.setKey(name, jwk);
        await ProfileManager.setProfile(name, {
          name,
          host,
          chainId: 1,
          spaceName: "default",
          did,
          sessionDid: did,
          createdAt: new Date().toISOString(),
          posture,
          operatorType,
        });

        outputJson({ profile: name, did, host, posture, operatorType, created: true });
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command("show [name]")
    .description("Show profile details")
    .action(async (name: string | undefined, _options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const profileName = name ?? ctx.profile;

        const p = await ProfileManager.getProfile(profileName);
        const hasKey = (await ProfileManager.getKey(profileName)) !== null;
        const hasSession = (await ProfileManager.getSession(profileName)) !== null;
        const config = await ProfileManager.getConfig();
        const isDefault = profileName === config.defaultProfile;
        const posture = resolveProfilePosture(p);
        const operatorType = resolveProfileOperatorType(p);

        if (shouldOutputJson()) {
          outputJson({
            ...p,
            posture,
            operatorType,
            hasKey,
            hasSession,
            isDefault,
          });
        } else {
          process.stdout.write(`${theme.heading(p.name)}${isDefault ? theme.success(" (default)") : ""}\n`);
          process.stdout.write(formatField("Host", p.host) + "\n");
          process.stdout.write(formatField("DID", p.did) + "\n");
          process.stdout.write(formatField("Session DID", p.sessionDid ?? null) + "\n");
          process.stdout.write(formatField("Posture", posture) + "\n");
          process.stdout.write(formatField("Operator", operatorType) + "\n");
          process.stdout.write(formatField("Space", p.spaceId || null) + "\n");
          process.stdout.write(formatField("Default Space", p.defaultSpace || null) + "\n");
          process.stdout.write(formatField("Key", hasKey) + "\n");
          process.stdout.write(formatField("Session", hasSession) + "\n");
          process.stdout.write(formatField("Created", p.createdAt) + "\n");
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command("switch <name>")
    .description("Set default profile")
    .action(async (name: string, _options, cmd) => {
      try {
        if (!(await ProfileManager.profileExists(name))) {
          throw new CLIError("PROFILE_NOT_FOUND", `Profile "${name}" does not exist`, ExitCode.NOT_FOUND);
        }

        const config = await ProfileManager.getConfig();
        await ProfileManager.setConfig({ ...config, defaultProfile: name });

        outputJson({ defaultProfile: name, switched: true });
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command("set-default-space [name]")
    .description("Set (or clear) the default space used when --space is omitted")
    .option("--profile <name>", "Profile to modify (defaults to the active profile)")
    .option("--unset", "Clear the default space so commands fall back to the primary space")
    .addHelpText("after", `

The default space is a short space NAME (e.g. "applications"), resolved per
profile at command time. Precedence for every kv/sql command:
  explicit --space flag  >  profile defaultSpace  >  primary space.

Examples:
  $ tc profile set-default-space applications
  $ tc profile set-default-space applications --profile cli-test
  $ tc profile set-default-space --unset
`)
    .action(async (name: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext({
          ...globalOpts,
          profile: options.profile ?? globalOpts.profile,
        });
        const profileName = ctx.profile;

        if (!options.unset && (name === undefined || name === "")) {
          throw new CLIError(
            "USAGE_ERROR",
            "Provide a space name (e.g. `tc profile set-default-space applications`) or pass --unset.",
            ExitCode.USAGE_ERROR,
          );
        }
        if (!options.unset && !/^[A-Za-z0-9_-]+$/.test(name as string)) {
          throw new CLIError(
            "INVALID_SPACE",
            `Invalid space name "${name}". Use a short name ([A-Za-z0-9_-]).`,
            ExitCode.USAGE_ERROR,
          );
        }

        const p = await ProfileManager.getProfile(profileName);
        const defaultSpace = options.unset ? undefined : (name as string);
        await ProfileManager.setProfile(profileName, { ...p, defaultSpace });

        outputJson({ profile: profileName, defaultSpace: defaultSpace ?? null, updated: true });
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command("delete <name>")
    .description("Delete a profile")
    .action(async (name: string, _options, cmd) => {
      try {
        // Confirmation prompt if interactive
        if (isInteractive()) {
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          const answer = await new Promise<string>((resolve) => {
            rl.question(`Delete profile "${name}"? This cannot be undone. [y/N] `, resolve);
          });
          rl.close();
          if (answer.toLowerCase() !== "y") {
            outputJson({ profile: name, deleted: false, reason: "Cancelled by user" });
            return;
          }
        }

        await ProfileManager.deleteProfile(name);
        outputJson({ profile: name, deleted: true });
      } catch (error) {
        handleError(error);
      }
    });
}

function parseProfilePosture(raw: unknown): CLIProfilePosture {
  if (raw === undefined || raw === null || raw === "") return "owner-openkey";
  if (isCLIProfilePosture(raw)) return raw;
  throw new CLIError(
    "INVALID_POSTURE",
    `Invalid posture "${String(raw)}". Use one of: ${CLI_PROFILE_POSTURES.join(", ")}.`,
    ExitCode.USAGE_ERROR,
  );
}

function parseOperatorType(raw: unknown): CLIOperatorType {
  if (raw === undefined || raw === null || raw === "") return "human";
  if (isCLIOperatorType(raw)) return raw;
  throw new CLIError(
    "INVALID_OPERATOR",
    `Invalid operator "${String(raw)}". Use one of: ${CLI_OPERATOR_TYPES.join(", ")}.`,
    ExitCode.USAGE_ERROR,
  );
}
