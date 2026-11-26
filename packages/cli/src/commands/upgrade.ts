import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { ExitCode } from "../config/constants.js";
import { detectInstallKind, isAutoUpdateEnabled, type InstallKind } from "../lib/auto-update.js";
import {
  appendUpdateLog,
  baseInstall,
  channelOf,
  defaultUpdater,
  MIN_TARGET_VERSION,
  runManualUpgrade,
  runtimeRefusal,
  systemGlobalRoots,
  type FailureReason,
  type UpgradeResult,
} from "../lib/self-update.js";
import { recordInstallKind, verifyInstallKind } from "../lib/install-kind.js";
import { CLI_PACKAGE } from "../lib/versions.js";
import { outputJson, shouldOutputJson } from "../output/formatter.js";
import { theme } from "../output/theme.js";

const EXIT_FOR_STATUS: Record<UpgradeResult["status"], number> = {
  ok: ExitCode.SUCCESS,
  refused: ExitCode.UPGRADE_REFUSED,
  "failed-rolled-back": ExitCode.UPGRADE_FAILED_ROLLED_BACK,
  "failed-not-rolled-back": ExitCode.UPGRADE_FAILED_NOT_ROLLED_BACK,
};

/** The command that updates an install `tinycloud upgrade` can't manage. */
export function manualCommand(kind: InstallKind, version: string): string {
  const spec = `${CLI_PACKAGE}@${version}`;
  if (kind === "npx") return `npx ${spec}`;
  if (kind === "project") return `npm install ${spec}`;
  return `npm install -g ${spec}`;
}

// User-facing copy below: TC-4276 strings, approved by Monica.
const FAILURE_PHRASE: Record<FailureReason, string> = {
  INSTALL_FAILED: "the install failed",
  SMOKE_FAILED: "the new version didn't start",
  SWITCH_FAILED: "the switch failed",
};

export function resultLines(result: UpgradeResult, extra: { manualCommand?: string; recoveryCommand?: string }): string[] {
  switch (result.status) {
    case "ok":
      if (!result.changed) return [`TinyCloud CLI ${result.from} is the newest version on the ${channelOf(result.from)} channel.`];
      return [
        `Updated TinyCloud CLI from ${result.from} to ${result.to}. Your next ${CLI_NAME} command uses ${result.to}.`,
        "Next steps:",
        `  Run one normal command for each profile, for example: ${CLI_NAME} --profile <name> auth caps`,
        `  Restart any running Courier (${CLI_NAME} courier watch, ${CLI_NAME} courier broker): it keeps the old version until it restarts.`,
      ];
    case "refused":
      return [refusalLine(result, extra.manualCommand)];
    case "failed-rolled-back":
      return [`The update to ${result.to} failed (${FAILURE_PHRASE[result.reason]}). You're on ${result.current}.`];
    case "failed-not-rolled-back":
      return [
        `The update to ${result.to} failed (${FAILURE_PHRASE[result.reason]}) and the previous version couldn't be restored.`,
        `To go back to the version npm installed, run: ${extra.recoveryCommand}`,
      ];
  }
}

function refusalLine(result: Extract<UpgradeResult, { status: "refused" }>, manual?: string): string {
  const to = result.to ?? "the new version";
  switch (result.reason) {
    case "UNSUPPORTED_INSTALL": return `This TinyCloud CLI wasn't installed globally with npm or bun, so ${CLI_NAME} upgrade can't update it. Update it with: ${manual}`;
    case "NEEDS_YES": return `${CLI_NAME} upgrade needs --yes when it doesn't run in a terminal or when CI is set to anything but false or 0.`;
    case "DECLINED": return "Nothing was changed.";
    case "LOCKED": return "Another TinyCloud CLI update is running. Retry in a few minutes.";
    case "NPM_NOT_FOUND": return `${CLI_NAME} upgrade needs npm to download and verify ${to}, and npm isn't on your PATH.`;
    case "INVALID_VERSION": return `${to} isn't a version number (for example ${MIN_TARGET_VERSION}).`;
    case "VERSION_NOT_FOUND": return `TinyCloud CLI ${to} isn't on npm.`;
    case "TARGET_TOO_OLD": return `${CLI_NAME} upgrade can't install versions before ${MIN_TARGET_VERSION}. To install ${to} anyway, run: npm install -g ${CLI_PACKAGE}@${to}`;
    case "REGISTRY_UNAVAILABLE": return "Couldn't reach the npm registry. Retry in a few minutes.";
    case "COURIER_RUNNING": return `Courier is running, so ${to} was downloaded and verified but not switched on. Stop Courier, rerun ${CLI_NAME} upgrade, then start Courier.`;
    // Monica (TC-4276, 21:06Z), verbatim; detail is "Bun <version>".
    case "UNSUPPORTED_RUNTIME": return `TinyCloud CLI can't verify updates under ${result.detail}; it needs Node or Bun 1.4 or newer. Nothing was installed. Run ${CLI_NAME} with Node (without \`bun --bun\`).`;
    case "PROVENANCE_MISSING": return `TinyCloud CLI ${to} has no provenance record, so it can't be verified and wasn't installed.`;
    case "PROVENANCE_INVALID": return `TinyCloud CLI ${to} failed the provenance check, so it wasn't installed.`;
    case "SIGNATURE_INVALID": return `A package in TinyCloud CLI ${to} failed npm's signature check, so it wasn't installed.`;
    case "PROVENANCE_UNAVAILABLE": return `Couldn't reach the provenance service to verify TinyCloud CLI ${to}, so nothing was installed. Check your network and retry in a few minutes.`;
    case "DEPENDENCY_NOT_FROM_REGISTRY": return `TinyCloud CLI ${to} depends on a package that isn't from the npm registry, so it can't be verified and nothing was installed.`;
  }
}

async function confirmInTerminal(from: string, to: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(`Update TinyCloud CLI from ${from} to ${to}? [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

/**
 * How `tinycloud upgrade` confirms a switch: `--yes` skips the question, a terminal asks it, anything else refuses.
 * CI is #1054's rule (`CI` set to anything but `false` or `0`), read through `isAutoUpdateEnabled` so they can't drift.
 */
export function confirmation(yes: boolean, stdinIsTTY: boolean, env: NodeJS.ProcessEnv): "skip" | "ask" | "refuse" {
  if (yes) return "skip";
  return stdinIsTTY && isAutoUpdateEnabled({ CI: env.CI }) ? "ask" : "refuse";
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description("Update the TinyCloud CLI to a newer verified version")
    .option("--to <version>", "Switch to this exact version; automatic updates pause until a plain upgrade")
    .option("-y, --yes", "Don't ask before switching (needed outside a terminal)")
    .action(async (options: { to?: string; yes?: boolean }) => {
      const json = shouldOutputJson();
      const base = baseInstall();
      // The path-based guess only words the manual command; updating needs a verified global install.
      const guessedKind = detectInstallKind(base.packageDir, process.cwd(), homedir());
      const verifiedKind = await verifyInstallKind(base.packageDir, systemGlobalRoots());
      if (verifiedKind) recordInstallKind(base.root, base.packageDir, base.version, verifiedKind);
      const deps = defaultUpdater(base, (line) => appendUpdateLog(base.root, line));
      const mode = confirmation(options.yes === true, Boolean(process.stdin.isTTY), process.env);
      let result: UpgradeResult;
      const unsupported = runtimeRefusal(deps);
      if (unsupported) {
        result = unsupported;
      } else if (mode === "refuse" && verifiedKind) {
        // An install upgrade can't manage gets its manual command, which --yes wouldn't change.
        result = { status: "refused", reason: "NEEDS_YES", from: deps.base.version };
      } else {
        if (!json) process.stderr.write(theme.muted("Checking for a verified update…") + "\n");
        result = await runManualUpgrade(deps, {
          installKind: verifiedKind ?? "unknown",
          ...(options.to !== undefined ? { to: options.to } : {}),
          ...(mode === "ask" ? { confirm: confirmInTerminal } : {}),
        });
      }
      const extra: { manualCommand?: string; recoveryCommand?: string } = {};
      if (result.status === "refused" && result.reason === "UNSUPPORTED_INSTALL") {
        const channel = channelOf(result.from);
        const target = options.to ?? (await deps.registry.distTags().catch(() => ({} as Record<string, string>)))[channel] ?? channel;
        extra.manualCommand = manualCommand(guessedKind, target);
      }
      if (result.status === "failed-not-rolled-back") extra.recoveryCommand = `rm "${join(base.root, "current.json")}"`;
      if (json) {
        outputJson({ ...result, ...extra });
      } else {
        const lines = resultLines(result, extra);
        const write = result.status === "ok" ? (line: string) => process.stdout.write(`${line}\n`) : (line: string) => process.stderr.write(`${line}\n`);
        for (const line of lines) write(line);
      }
      process.exitCode = EXIT_FOR_STATUS[result.status];
    });
}
