import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  checkForUpdate,
  detectInstallKind,
  finishUpdateNotice,
  isAutoUpdateEnabled,
  registerUpdateNoticeFinalizer,
  updateNotice,
} from "./lib/auto-update.js";
import {
  autoUpdateCovers,
  autoUpdateOffReason,
  baseInstall,
  onPath,
  pendingSwitch,
  readGlobalConfig,
  startAutoUpdateIfDue,
} from "./lib/self-update.js";
import { recordedInstallKind } from "./lib/install-kind.js";
import { readPointer, writeLease } from "./lib/versions.js";
import { TC_OPTIONS_BEFORE_COURIER } from "./commands/courier.js";
import { readFileSync } from "node:fs";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { Command, CommanderError } from "commander";
import { handleError } from "./output/errors.js";
import { emitBanner } from "./output/banner.js";
import { closeReplication } from "./lib/replication-registry.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
);

const updateCheck = isAutoUpdateEnabled(process.env)
  ? checkForUpdate({ currentVersion: version, cachePath: join(CONFIG_DIR, "update-check.json") }).catch(() => null)
  : Promise.resolve(null);

// TC-4276: this process's global install, and whether it updates itself (npm or bun global installs only).
const base = baseInstall();
const installKind = detectInstallKind(base.packageDir, process.cwd(), homedir());
const selfUpdating = installKind === "npm-global" || installKind === "bun-global";

registerUpdateNoticeFinalizer(async () => {
  const offReason = selfUpdating ? autoUpdateOffReason(process.env, readGlobalConfig()) : null;
  // The background updater starts after any command, quiet or failed ones included; it never prints.
  if (selfUpdating && commandToken !== "upgrade" && commandToken !== "__auto-update" && offReason === null) {
    startAutoUpdateIfDue(base.root, Date.now(), () => {
      const job = spawn(process.execPath, [base.bin, "--quiet", "__auto-update"], { detached: true, stdio: "ignore" });
      job.on("error", () => undefined);
      job.unref();
    });
  }
  // Only a command that finished cleanly gets the notice: a failing command's stderr is a structured JSON error
  // that callers parse, so nothing is appended to it.
  if (program.opts().quiet === true || Number(process.exitCode ?? 0) !== 0) return;
  const latest = await updateCheck;
  // A release the background updater installs itself gets no notice (TC-4276). Only an install the updater has
  // verified counts; `detectInstallKind` is a path guess.
  const pointer = selfUpdating ? readPointer(base.root) : null;
  const available = latest && !autoUpdateCovers({
    installKind: (selfUpdating && recordedInstallKind(base.root, base.packageDir, base.version)) || "unknown",
    current: version,
    available: latest,
    offReason,
    npmOnPath: selfUpdating && onPath("npm"),
    pinned: pointer?.base === base.version && pointer.pinned,
  }) ? latest : null;
  const pending = selfUpdating ? pendingSwitch(base.root, version) : null;
  if (!available && !pending) return;
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
  if (available) process.stderr.write(`${updateNotice(installKind, version, available)}\n`);
  // User-facing copy: TC-4276, approved by Monica.
  if (pending) process.stderr.write(`TinyCloud CLI ${pending} is ready. Restart Courier to finish the update.\n`);
  await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
});
import { theme } from "./output/theme.js";
import { setJsonOutputRequested, shouldOutputJson, outputWarnings } from "./output/formatter.js";
import { ProfileManager } from "./config/profiles.js";
import { configureShareCommandServices, registerShareCommand } from "./commands/share.js";
import { createShareAuthorityAdapters } from "./share/adapters.js";
import { approveEmailInviteKey } from "./share/invite-approval.js";
import { loadCourierEntry } from "./lib/courier-loader.js";
import { applyNoRetryFlag } from "./lib/retry-policy.js";
import { CONFIG_DIR } from "./config/constants.js";
import { appendDiagnosticLog, setDiagnosticCommandContext } from "./lib/diagnostic-logs.js";


const program = new Command();
program.exitOverride();
let commandStartedAt = Date.now();

function fullCommandName(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current && current !== program) {
    names.push(current.name());
    current = current.parent;
  }
  return names.reverse().join(" ");
}
const shareAuthority = createShareAuthorityAdapters({
  profileName: async () => selectedShareProfile() ?? (await ProfileManager.getConfig()).defaultProfile,
  fetchFn: globalThis.fetch,
  approveEmailInviteKey,
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
  .option("--no-diagnostic-logs", "Don't record a CLI log for this command");


program.hook("preAction", async (hookedCommand, actionCommand) => {
  const opts = hookedCommand.optsWithGlobals();
  setJsonOutputRequested(opts.json === true);
  applyNoRetryFlag(opts);
  const parentName = hookedCommand.parent?.name();
  const isShareCommand = parentName === "share" || hookedCommand.name() === "share";
  if (!opts.quiet && !isShareCommand) {
    emitBanner(version);
  }

  // Config guard — warn if not configured for auth-required commands
  const commandName = hookedCommand.name();
  const isRootCommand = hookedCommand === program;
  const fullCommand = fullCommandName(hookedCommand);
  setDiagnosticCommandContext({
    command: fullCommandName(actionCommand),
    args: process.argv.slice(2),
    disabled: process.env.TINYCLOUD_CLI_LOGS === "0" || opts.diagnosticLogs === false,
    cliVersion: version,
  });
  commandStartedAt = Date.now();
  const skipGuard = isRootCommand || ["init", "doctor", "completion", "help", "upgrade", "status"].includes(commandName) ||
                    fullCommand === "profile create" || fullCommand === "registry show";
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

program.hook("postAction", async (_hookedCommand, actionCommand) => {
  outputWarnings([]);
  if (actionCommand.name() === "bug-report") return;
  await appendDiagnosticLog({
    root: CONFIG_DIR,
    disabled: process.env.TINYCLOUD_CLI_LOGS === "0" || actionCommand.optsWithGlobals().diagnosticLogs === false,
    entry: {
      command: fullCommandName(actionCommand),
      args: process.argv.slice(2),
      exitCode: 0,
      cliVersion: version,
      nodeVersion: process.version,
      durationMs: Date.now() - commandStartedAt,
    },
  }).catch(() => undefined);
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
  shortLinkInvitations: true,
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
setDiagnosticCommandContext({
  command: commandToken ?? "unknown",
  args: argv,
  disabled: process.env.TINYCLOUD_CLI_LOGS === "0" || argv.includes("--no-diagnostic-logs"),
  cliVersion: version,
});
// A Courier process, and any process started from a versioned install, leases its version: the updater neither
// prunes it nor switches away from the version a running Courier uses (TC-4276).
if (selfUpdating && (argv[0] === "courier" || version !== base.version)) {
  writeLease(base.root, { version, courier: argv[0] === "courier" });
}
if (argv[0] === "courier") {
  // Courier owns its argv (including --host and --json) and its own profile,
  // so Commander, the banner and the tc profile guard never see it.
  const code = await (await loadCourierEntry()).runCourier(argv.slice(1));
  process.exitCode = code;
  await finishUpdateNotice();
} else if (commandToken === "courier") {
  process.stderr.write(`${TC_OPTIONS_BEFORE_COURIER}\n`);
  process.exitCode = 2;
  await finishUpdateNotice();
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
      await finishUpdateNotice();
      process.exit();
    }
    await finishUpdateNotice();
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      await finishUpdateNotice();
    } else {
      await handleError(error);
    }
  }
}
