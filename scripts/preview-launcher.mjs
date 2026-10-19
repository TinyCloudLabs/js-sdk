import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPlatform } from "./preview-files.mjs";

// No installer, profile selection, environment changes or diagnostics opt-in.
export async function launch(mode) {
  assertPlatform();
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--alpha-identity") {
    process.stdout.write(await readFile(join(root, "identity.json"), "utf8"));
    return;
  }
  const http = mode === "mcp" && args[0] === "--http";
  if (http) args.shift();
  const entry = mode === "cli" ? "@tinycloud/cli/dist/bootstrap.js"
    : http ? "@tinycloud/mcp/dist/http-cli.js" : "@tinycloud/mcp/bin/tinycloud-mcp";
  const path = join(root, "node_modules", entry);
  process.argv = [process.execPath, path, ...args];
  await import(pathToFileURL(path).href);
}
