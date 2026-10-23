import { TC_OPTIONS_BEFORE_COURIER } from "./commands/courier.js";
import { readFileSync } from "node:fs";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { Command } from "commander";
import { handleError } from "./output/errors.js";
import { emitBanner } from "./output/banner.js";
import { closeReplication } from "./lib/replication-registry.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
);
import { theme } from "./output/theme.js";
import { setJsonOutputRequested, shouldOutputJson, outputWarnings } from "./output/formatter.js";
import { ProfileManager } from "./config/profiles.js";
import { configureShareCommandServices, registerShareCommand } from "./commands/share.js";
import { createShareAuthorityAdapters } from "./share/adapters.js";
import { loadCourierEntry } from "./lib/courier-loader.js";
import { applyNoRetryFlag } from "./lib/retry-policy.js";

const program = new Command();
const shareAuthority = createShareAuthorityAdapters({
  profileName: async () => selectedShareProfile() ?? (await ProfileManager.getConfig()).defaultProfile,
  fetchFn: globalThis.fetch,
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

// Ubuntu's iproute2 ships /usr/sbin/tc, so the CLI is also installed as `tinycloud`.
// Help, usage and hints name whichever bin was invoked.
program
  .name(CLI_NAME)
  .description("TinyCloud CLI — self-sovereign storage from the terminal")
  .version(version)
  .option("-p, --profile <name>", "Profile to use")
  .option("-H, --host <url>", "TinyCloud node URL")
  .option("-v, --verbose", "Enable verbose output")
  .option("--no-cache", "Disable caching")
  .option("-q, --quiet", "Suppress non-essential output")
  .option("--json", "Force JSON output")
  .option("--no-retry", "Do not retry node busy/timeout answers (monitors and probes); same as TINYCLOUD_RETRY=0")
  .option("--replication", "Enable read-through replication for this invocation")
  .option("--no-replication", "Disable read-through replication for this invocation")
  .option("--replication-debug", "Write replication diagnostics to stderr")

program.hook("preAction", async (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  setJsonOutputRequested(opts.json === true);
  applyNoRetryFlag(opts);
  const parentName = thisCommand.parent?.name();
  const isShareCommand = parentName === "share" || thisCommand.name() === "share";
  if (!opts.quiet && !isShareCommand) {
    emitBanner(version);
  }

  // Config guard — warn if not configured for auth-required commands
  const commandName = thisCommand.name();
  const isRootCommand = thisCommand === program;
  const fullCommand = parentName && thisCommand.parent !== program ? `${parentName} ${commandName}` : commandName;
  const skipGuard = isRootCommand || ["init", "doctor", "completion", "help", "upgrade", "status"].includes(commandName) ||
                    fullCommand === "profile create";
  if (!skipGuard && !opts.quiet && !shouldOutputJson()) {
    try {
      const config = await ProfileManager.getConfig();
      const profileName = opts.profile || config.defaultProfile;
      const hasProfile = await ProfileManager.profileExists(profileName);
      if (!hasProfile) {
        process.stderr.write(theme.warn("⚠ No profile configured.") + " " + theme.muted(`Run: ${CLI_NAME} init`) + "\n\n");
      } else {
        const key = await ProfileManager.getKey(profileName);
        if (!key) {
          process.stderr.write(theme.warn("⚠ No key found.") + " " + theme.muted(`Run: ${CLI_NAME} init`) + "\n\n");
        }
      }
    } catch {
      // Config dir doesn't exist yet — that's fine, commands will handle it
    }
  }
});

program.hook("postAction", () => {
  outputWarnings([]);
});

configureShareCommandServices({
  targetAdapter: shareAuthority.targetAdapter,
  records: shareAuthority.records,
  delivery: shareAuthority.delivery,
  assertDomainDelivery: shareAuthority.assertDomainDelivery,
  revocation: shareAuthority.revocation,
  nativeReader: shareAuthority.nativeReader,
  artifactStore: shareAuthority.artifactStore,
  links: shareAuthority.links,
});

const argv = process.argv.slice(2);
// Mirrors Commander's parsing of tc's global options: clustered shorts (-vp p, -vpp),
// attached values (-Hurl, --host=url), separate values and `--`.
const globalLongOptionsWithValues: Record<string, true> = { "--profile": true, "--host": true };
const globalShortOptionsWithValues: Record<string, true> = { p: true, H: true };
function firstCommandToken(values: readonly string[]): string | undefined {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--") return values[index + 1];
    if (value.startsWith("--")) {
      if (globalLongOptionsWithValues[value]) index += 1;
      continue;
    }
    if (value.length > 1 && value.startsWith("-")) {
      for (let char = 1; char < value.length; char += 1) {
        if (!globalShortOptionsWithValues[value[char]!]) continue;
        if (char === value.length - 1) index += 1; // value is the next argument
        break; // otherwise the rest of this argument is the value
      }
      continue;
    }
    return value;
  }
  return undefined;
}
program.addHelpText("before", () => `${theme.label("Version:")} ${theme.value(version)}\n`);

program.addHelpText("afterAll", () => {
  if (!process.stdout.isTTY) return "";
  return `
${theme.heading("Examples:")}
  ${theme.command(`${CLI_NAME} init`)}                              ${theme.muted("Set up a profile and generate keys")}
  ${theme.command(`${CLI_NAME} auth login`)}                        ${theme.muted("Authenticate via browser")}
  ${theme.command(`${CLI_NAME} kv put greeting "Hello"`)}           ${theme.muted("Store a value")}
  ${theme.command(`${CLI_NAME} kv list`)}                           ${theme.muted("List all keys")}
  ${theme.command(`${CLI_NAME} secrets network init`)}              ${theme.muted("Create the default secrets network")}
  ${theme.command(`${CLI_NAME} account apps list`)}                 ${theme.muted("List registered account apps")}
  ${theme.command(`${CLI_NAME} delegation create --to did:pkh:...`)}  ${theme.muted("Grant access to another user")}
  ${theme.command(`${CLI_NAME} space list`)}                        ${theme.muted("Show your spaces")}

${theme.muted("Docs:")} ${theme.accent("https://docs.tinycloud.xyz/cli")}
${theme.muted("Repo:")} ${theme.accent("https://github.com/tinycloudlabs/web-sdk")}
`;
});

const commandToken = firstCommandToken(argv);
if (argv[0] === "courier") {
  // Courier owns its argv (including --host and --json) and its own profile,
  // so Commander, the banner and the tc profile guard never see it.
  const code = await (await loadCourierEntry()).runCourier(argv.slice(1));
  if (code !== 0) process.exit(code);
} else if (commandToken === "courier") {
  process.stderr.write(`${TC_OPTIONS_BEFORE_COURIER}\n`);
  process.exit(2);
} else {
  if (commandToken === "share") {
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

  try {
    await program.parseAsync(process.argv);
    // The command is done with stdin. A pipe a caller keeps open (an agent
    // harness after `auth login --paste`) must not hold the process (TC-1025).
    process.stdin.unref?.();
    if (await closeReplication()) {
      process.exitCode = 0;
      const stdoutFlushed = Promise.withResolvers<void>();
      process.stdout.write("", () => stdoutFlushed.resolve());
      await stdoutFlushed.promise;
      const stderrFlushed = Promise.withResolvers<void>();
      process.stderr.write("", () => stderrFlushed.resolve());
      await stderrFlushed.promise;
      process.exit();
    }
  } catch (error) {
    await handleError(error);
  }
}
