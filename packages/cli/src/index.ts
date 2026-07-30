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
import { configureShareCommandServices, registerShareCommand } from "./commands/share.js";
import { createProductionUploadAuthorizer, createShareAuthorityAdapters } from "./share/adapters.js";

const program = new Command();
const shareAuthority = createShareAuthorityAdapters({
  profileName: async () => selectedShareProfile() ?? (await ProfileManager.getConfig()).defaultProfile,
});

function selectedShareProfile(): string | undefined {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--profile" || value === "-p") return args[index + 1];
    if (value?.startsWith("--profile=")) return value.slice("--profile=".length);
  }
  return process.env.TC_PROFILE;
}

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
  const parentName = thisCommand.parent?.name();
  const isShareCommand = parentName === "share" || thisCommand.name() === "share";
  if (!opts.quiet && !isShareCommand) {
    emitBanner(version);
  }

  // Config guard — warn if not configured for auth-required commands
  const commandName = thisCommand.name();
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

configureShareCommandServices({
  fetchFn: globalThis.fetch,
  // The CLI uses the same nonce-bound OpenKey session ceremony as the Share
  // browser. The authorizer is lazy: public inspect/receive never touches
  // profile state, and no secret is serialized into a publish result.
  authorizeUpload: createProductionUploadAuthorizer({
    fetchFn: globalThis.fetch,
    profileName: async () => selectedShareProfile() ?? (await ProfileManager.getConfig()).defaultProfile,
  }),
  targetAdapter: shareAuthority.targetAdapter,
  authorization: shareAuthority.authorization,
  records: shareAuthority.records,
  delivery: shareAuthority.delivery,
  revocation: shareAuthority.revocation,
});

const argv = process.argv.slice(2);
const globalOptionsWithValues = new Set(["--profile", "-p", "--host", "-H"]);
function firstCommandToken(values: readonly string[]): string | undefined {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--") return values[index + 1];
    if (globalOptionsWithValues.has(value)) { index += 1; continue; }
    if (value.startsWith("--profile=") || value.startsWith("--host=")) continue;
    if (value === "--verbose" || value === "--no-cache" || value === "-q" || value === "--quiet" || value === "--json") continue;
    if (value.startsWith("-")) continue;
    return value;
  }
  return undefined;
}
const isShareInvocation = firstCommandToken(argv) === "share";
if (isShareInvocation) {
  // Keep the agent-critical surface independent from the legacy command
  // graph. The latter imports optional Node/WASM authentication packages;
  // inspecting or receiving a public Share link must not load them.
  registerShareCommand(program);
} else {
  type LegacyEntry = typeof import("./legacy-entry.js");
  const loadLegacy = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<LegacyEntry>;
  const { registerTinyCloudCommands } = await loadLegacy(new URL("./legacy-entry.js", import.meta.url).href);
  registerTinyCloudCommands(program);
}

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
