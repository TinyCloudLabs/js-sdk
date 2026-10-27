import { readFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { DEFAULT_HOST, ExitCode } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import { launchDetachedLogin } from "../auth/detached-login.js";
import { sessionStateIsUsable, storedSessionState } from "../auth/scoped-login.js";
import { cliPackageRoot } from "../lib/skill-install.js";
import { runNpm, setupApps, SETUP_AGENT_CHOICES, resolveSetupAgent, TC_APPS_SKILL, type SetupResult } from "../lib/setup-apps.js";
import {
  TINY_APP_LOGIN_EXPIRY,
  TinyAppInputError,
  tinyAppManifest,
  tinyAppManifestFile,
  tinyAppProfile,
  tinyAppTitle,
} from "../lib/tiny-apps.js";
import { CLIError, handleError } from "../output/errors.js";
import { outputJson } from "../output/formatter.js";
import { createKeyOnlyProfile } from "./init.js";

export function registerSetupCommand(program: Command): void {
  const setup = program.command("setup").description("Set up TinyCloud for an agent on this computer");

  setup
    .command("apps")
    .description("Install the CLI into tc-apps' own folder and the tc-apps skill (shipped in this package) for an agent; optionally start one app's sign-in")
    .requiredOption("--agent <agent>", `Whose skills folder gets the skill: ${SETUP_AGENT_CHOICES.join(", ")} (none: only the private copy)`)
    .option("--app <name>", "Then start this tiny app's sign-in (for example todos) and print its OpenKey link")
    .option("--title <title>", "The app's title for --app, when the CLI has no template for it")
    .addHelpText(
      "after",
      `
Runs the /apps guide's install steps as one command:
  - folders: \${TC_HOME:-~}/.tinycloud, \${TC_APPS_STATE:-~/.local/state/tc-apps}, ~/.local/share/tc-apps (owner-only)
  - this exact CLI version in ~/.local/share/tc-apps/cli (npm install --prefix; never global), unless TC_BIN is set
  - the ${TC_APPS_SKILL} skill from this package, checked against its SHA256SUMS: a private copy in
    ~/.local/share/tc-apps/skill, and the client's copy (\${CLAUDE_CONFIG_DIR:-~/.claude}/skills or ~/.agents/skills)
  - the helper ~/.local/share/tc-apps/tinycloud and its cli-path
With --app, it then creates the app's profile (tinyapp-<app>) and request, and starts the browser sign-in in the
background (\`auth login --detach\`): the OpenKey link is printed, and \`auth status --wait\` reports the approval.

Examples:
  $ npx -y @tinycloud/cli@<exact version> setup apps --agent claude-code --app todos
  $ ${CLI_NAME} setup apps --agent none
`,
    )
    .action(async (options: { agent: string; app?: string; title?: string }, cmd: Command) => {
      try {
        const agent = resolveSetupAgent(options.agent, process.env);
        const title = options.app === undefined ? undefined : tinyAppInput(() => tinyAppTitle(options.app!, options.title));
        const packageRoot = cliPackageRoot();
        const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };
        const result = await setupApps(agent, {
          env: process.env,
          ownVersion: version,
          bundleDir: join(packageRoot, "skills", TC_APPS_SKILL),
          packageRoot,
          runNpm: (args) => runNpm(args),
        });
        const signIn = options.app === undefined
          ? undefined
          : await startTinyAppSignIn({ app: options.app, title: title!, setup: result, host: cmd.optsWithGlobals().host });
        outputJson({ ...result, ...(signIn === undefined ? {} : { signIn }) });
      } catch (error) {
        return handleError(error);
      }
    });
}

function tinyAppInput<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof TinyAppInputError) throw new CLIError(error.code, error.message, ExitCode.USAGE_ERROR);
    throw error;
  }
}

/**
 * SKILL.md §4a as one step: the app's request file, its profile (key only),
 * and the detached browser sign-in. An app whose profile already holds a
 * usable session is left as it is.
 */
async function startTinyAppSignIn(params: { app: string; title: string; setup: SetupResult; host?: string }): Promise<Record<string, unknown>> {
  const profile = tinyAppInput(() => tinyAppProfile(params.app));
  const manifestPath = join(params.setup.state, tinyAppManifestFile(params.app));
  await writeFile(manifestPath, `${JSON.stringify(tinyAppManifest(params.app, params.title))}\n`, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  if (!(await ProfileManager.profileExists(profile))) {
    await createKeyOnlyProfile(profile, params.host ?? DEFAULT_HOST);
  } else {
    const session = await ProfileManager.getSession(profile) as Record<string, unknown> | null;
    const config = await ProfileManager.getProfile(profile);
    if (sessionStateIsUsable(storedSessionState(session, config).state)) {
      return { app: params.app, profile, manifest: manifestPath, state: "signed-in" };
    }
  }
  // The listener runs the CLI this setup installed (same version), or this one under TC_BIN.
  const entry = params.setup.cli.source === "private"
    ? join(params.setup.cli.path, "..", "..", "@tinycloud", "cli", "bin", "tinycloud")
    : process.argv[1]!;
  const launched = await launchDetachedLogin({
    profile,
    entry,
    argv: [
      "--quiet", "--profile", profile, "auth", "login", "--method", "openkey",
      "--manifest", manifestPath, "--expiry", TINY_APP_LOGIN_EXPIRY, "--detached-child",
    ],
  });
  const cli = params.setup.cli.source === "private" ? `"${params.setup.cli.path}"` : CLI_NAME;
  return {
    app: params.app,
    profile,
    manifest: manifestPath,
    ...launched.login,
    reused: launched.reused,
    wait: `${cli} --profile ${profile} auth status --wait 60`,
    paste: `${cli} --profile ${profile} auth login --method openkey --paste --manifest "${manifestPath}" --expiry ${TINY_APP_LOGIN_EXPIRY}`,
  };
}
