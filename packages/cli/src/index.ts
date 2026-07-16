import { readFileSync } from "node:fs";
import { Command } from "commander";
import { handleError } from "./output/errors.js";
import { emitBanner } from "./output/banner.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
);
import { theme } from "./output/theme.js";
import { isInteractive } from "./output/formatter.js";
import { ProfileManager } from "./config/profiles.js";
import { registerTinyCloudCommands } from "./command-registry.js";

const program = new Command();

program
  .name("tc")
  .description("TinyCloud CLI — self-sovereign storage from the terminal")
  .version(version)
  .option("-p, --profile <name>", "Profile to use")
  .option("-H, --host <url>", "TinyCloud node URL")
  .option("-v, --verbose", "Enable verbose output")
  .option("--no-cache", "Disable caching")
  .option("-q, --quiet", "Suppress non-essential output")
  .option("--json", "Force JSON output");

program.hook("preAction", async (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  if (!opts.quiet) {
    emitBanner(version);
  }

  // Config guard — warn if not configured for auth-required commands
  const commandName = thisCommand.name();
  const parentName = thisCommand.parent?.name();
  const fullCommand = parentName && parentName !== "tc" ? `${parentName} ${commandName}` : commandName;
  const skipGuard = ["tc", "init", "doctor", "completion", "help", "upgrade", "status"].includes(commandName) ||
                    fullCommand === "profile create";
  if (!skipGuard && !opts.quiet && isInteractive()) {
    try {
      const config = await ProfileManager.getConfig();
      const profileName = opts.profile || config.defaultProfile;
      const hasProfile = await ProfileManager.profileExists(profileName);
      if (!hasProfile) {
        process.stderr.write(theme.warn("⚠ No profile configured.") + " " + theme.muted("Run: tc init") + "\n\n");
      } else {
        const key = await ProfileManager.getKey(profileName);
        if (!key) {
          process.stderr.write(theme.warn("⚠ No key found.") + " " + theme.muted("Run: tc init") + "\n\n");
        }
      }
    } catch {
      // Config dir doesn't exist yet — that's fine, commands will handle it
    }
  }
});

registerTinyCloudCommands(program);

program.addHelpText("before", () => `${theme.label("Version:")} ${theme.value(version)}\n`);

program.addHelpText("afterAll", () => {
  if (!process.stdout.isTTY) return "";
  return `
${theme.heading("Examples:")}
  ${theme.command("tc init")}                              ${theme.muted("Set up a profile and generate keys")}
  ${theme.command("tc auth login")}                        ${theme.muted("Authenticate via browser")}
  ${theme.command('tc kv put greeting "Hello"')}           ${theme.muted("Store a value")}
  ${theme.command("tc kv list")}                           ${theme.muted("List all keys")}
  ${theme.command("tc secrets network init")}              ${theme.muted("Create the default secrets network")}
  ${theme.command("tc account apps list")}                 ${theme.muted("List registered account apps")}
  ${theme.command("tc delegation create --to did:pkh:...")}  ${theme.muted("Grant access to another user")}
  ${theme.command("tc space list")}                        ${theme.muted("Show your spaces")}

${theme.muted("Docs:")} ${theme.accent("https://docs.tinycloud.xyz/cli")}
${theme.muted("Repo:")} ${theme.accent("https://github.com/tinycloudlabs/web-sdk")}
`;
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  handleError(error);
}
