import { Command } from "commander";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { theme } from "../output/theme.js";
import { handleError } from "../output/errors.js";

const PACKAGE_NAME = "@tinycloud/cli";

function getCurrentVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8")
  );
  return pkg.version;
}

async function getLatestVersion(): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`);
  if (!res.ok) {
    throw new Error(`Failed to fetch latest version: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { version: string };
  return data.version;
}

function detectPackageManager(): "bun" | "npm" {
  // Check if bun installed the package globally
  try {
    const bunGlobals = execSync("bun pm ls -g", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    if (bunGlobals.includes(PACKAGE_NAME)) {
      return "bun";
    }
  } catch {
    // bun not available or failed
  }

  // Check if npm installed the package globally
  try {
    const npmGlobals = execSync("npm ls -g --depth=0", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    if (npmGlobals.includes(PACKAGE_NAME)) {
      return "npm";
    }
  } catch {
    // npm not available or failed
  }

  // Fallback to bun since the CLI shebang uses it
  return "bun";
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description("Upgrade the TinyCloud CLI to the latest version")
    .action(async () => {
      try {
        const current = getCurrentVersion();

        process.stderr.write(theme.muted("Checking for updates...") + "\n");
        const latest = await getLatestVersion();

        if (current === latest) {
          process.stdout.write(theme.success(`Already on latest version (${current})`) + "\n");
          return;
        }

        process.stdout.write(`Current: ${theme.warn(current)} → Latest: ${theme.success(latest)}\n`);

        const pm = detectPackageManager();
        const cmd = pm === "bun"
          ? `bun install -g ${PACKAGE_NAME}@latest`
          : `npm install -g ${PACKAGE_NAME}@latest`;

        process.stderr.write(theme.muted(`Upgrading via ${pm}...`) + "\n\n");

        try {
          execSync(cmd, { stdio: "inherit" });
          process.stdout.write("\n" + theme.success(`Upgraded to ${latest}`) + "\n");
        } catch {
          process.stderr.write("\n" + theme.warn("Automatic upgrade failed.") + "\n");
          process.stderr.write(theme.muted("Try running manually:") + "\n");
          process.stderr.write(`  ${theme.command(`bun install -g ${PACKAGE_NAME}@latest`)}\n`);
          process.stderr.write(theme.muted("  or") + "\n");
          process.stderr.write(`  ${theme.command(`npm install -g ${PACKAGE_NAME}@latest`)}\n`);
        }
      } catch (error) {
        return handleError(error);
      }
    });
}
