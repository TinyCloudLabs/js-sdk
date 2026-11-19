import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** npx runs a package's bin from `<home>/.npm/_npx/<hash>/node_modules/.bin/<bin>`. */
const NPX_CACHE = /[\\/]_npx[\\/]/;

/** The version of the CLI package npx unpacked next to the bin it runs, or none when it cannot be read. */
function npxCliVersion(bin: string): string | undefined {
  try {
    const { version } = JSON.parse(readFileSync(join(dirname(bin), "..", "@tinycloud", "cli", "package.json"), "utf8"));
    return typeof version === "string" && /^[0-9A-Za-z.+-]+$/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The command hints and messages tell users to run. The CLI installs as both `tc` and `tinycloud` (Ubuntu's
 * iproute2 ships `/usr/sbin/tc`), so the name follows the invoked bin. Run by npx, neither is on the user's PATH and
 * npx picks the first bin, `tc`: the name is then the npx command that works, pinned to the version that is running.
 * Any other host process, such as the MCP server, gets `tc`.
 */
export function cliNameFor(
  argv1: string,
  env: Readonly<Record<string, string | undefined>>,
  versionOf: (bin: string) => string | undefined = npxCliVersion,
): string {
  if (env.npm_command === "exec" && NPX_CACHE.test(argv1)) {
    const version = versionOf(argv1);
    return `npx -y @tinycloud/cli${version ? `@${version}` : ""}`;
  }
  return basename(argv1) === "tinycloud" ? "tinycloud" : "tc";
}

export const CLI_NAME = cliNameFor(process.argv[1] ?? "", process.env);
