import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** npx runs a package's bin from `<home>/.npm/_npx/<hash>/node_modules/.bin/<bin>`. */
const NPX_CACHE = /[\\/]_npx[\\/]/;

/**
 * The version of the CLI package npx unpacked, or none when it cannot be read. The CLI's own bin rewrites `argv[1]` to
 * its real path, `…/node_modules/@tinycloud/cli/bin/tinycloud`; the `.bin/<name>` link npx makes is the other place to look.
 */
function npxCliVersion(bin: string): string | undefined {
  for (const manifest of [join(dirname(bin), "..", "package.json"), join(dirname(bin), "..", "@tinycloud", "cli", "package.json")]) {
    try {
      const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
      if (name === "@tinycloud/cli" && typeof version === "string" && /^[0-9A-Za-z.+-]+$/.test(version)) return version;
    } catch {
      // Not there: try the next place.
    }
  }
  return undefined;
}

/**
 * The command hints and messages tell users to run. The CLI installs as both `tc` and `tinycloud` (Ubuntu's
 * iproute2 ships `/usr/sbin/tc`), so the name follows the invoked bin. Run by npx, neither is on the user's PATH:
 * the name is then the npx command that works, pinned to the version of the CLI package that is running. That needs
 * the CLI's own manifest next to the bin, so any other host process (the MCP server, say) gets `tc`, as before.
 */
export function cliNameFor(
  argv1: string,
  env: Readonly<Record<string, string | undefined>>,
  versionOf: (bin: string) => string | undefined = npxCliVersion,
): string {
  if (env.npm_command === "exec" && NPX_CACHE.test(argv1)) {
    const version = versionOf(argv1);
    if (version) return `npx -y @tinycloud/cli@${version}`;
  }
  return basename(argv1) === "tinycloud" ? "tinycloud" : "tc";
}

export const CLI_NAME = cliNameFor(process.argv[1] ?? "", process.env);
