import { basename } from "node:path";

/**
 * The command name hints and messages tell users to run. The CLI installs as
 * both `tc` and `tinycloud` (Ubuntu's iproute2 ships `/usr/sbin/tc`), so the
 * name follows the invoked bin. Any other host process, such as the MCP server,
 * gets `tc`.
 */
export const CLI_NAME = basename(process.argv[1] ?? "") === "tinycloud" ? "tinycloud" : "tc";
