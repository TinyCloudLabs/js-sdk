import { readFileSync } from "node:fs";
import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";

export const CLI_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
).version;

/** Shared by the business and profile-free diagnostics parsers. */
export function createRootCommand(): Command {
  // Ubuntu's iproute2 ships /usr/sbin/tc; help names the invoked CLI alias.
  return new Command()
    .name(CLI_NAME)
    .description("TinyCloud CLI — self-sovereign storage from the terminal")
    .version(CLI_VERSION)
    .option("-p, --profile <name>", "Profile to use")
    .option("-H, --host <url>", "TinyCloud node URL")
    .option("-v, --verbose", "Enable verbose output")
    .option("--no-cache", "Disable caching")
    .option("-q, --quiet", "Suppress non-essential output")
    .option("--json", "Force JSON output")
    .option("--replication", "Enable read-through replication for this invocation")
    .option("--no-replication", "Disable read-through replication for this invocation")
    .option("--replication-debug", "Write replication diagnostics to stderr");
}
