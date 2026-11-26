/**
 * Locating npm for the updater without trusting the working directory or a shell (TC-4276 F5). Only absolute PATH
 * entries count, so a `npm` / `npm.cmd` dropped in the current directory is never run. On Windows `npm.cmd` is a batch
 * file, which `spawn` can't run without a shell; the updater runs npm's own `npm-cli.js` with this Node instead.
 */
import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface NpmCommand {
  /** The executable to spawn (npm itself, or Node on Windows). */
  command: string;
  /** Arguments before npm's own (npm-cli.js on Windows). */
  args: string[];
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** npm on this machine, or null when there is none to run safely. */
export function resolveNpm(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  exists: (file: string) => boolean = isExecutableFile,
): NpmCommand | null {
  const path = platform === "win32" ? win32 : posix;
  const directories = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter((directory) => directory !== "" && path.isAbsolute(directory));
  if (platform !== "win32") {
    const npm = directories.map((directory) => path.join(directory, "npm")).find(exists);
    return npm ? { command: npm, args: [] } : null;
  }
  // Node's Windows installer puts npm next to node.exe; otherwise the first npm.cmd on PATH, run through its npm-cli.js.
  const npmDirectories = [path.dirname(execPath), ...directories.filter((directory) => exists(path.join(directory, "npm.cmd")))];
  for (const directory of npmDirectories) {
    const cli = path.join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    if (exists(cli)) return { command: execPath, args: [cli] };
  }
  return null;
}
