/**
 * The global `tinycloud` launcher (TC-4276). `bin/tinycloud` asks this entry which build to run: the verified version
 * the pointer names, or its own `dist/index.js`. It loads nothing but Node built-ins, so choosing costs a few file reads.
 */
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { activeVersion, readPackageVersion, setLaunchContext, versionsRoot } from "./lib/versions.js";

/**
 * The `dist/index.js` URL to import for the launcher at `binPath`, or null to run the launcher's own build.
 * Every failure (no pointer, a broken one, an unreadable root) falls back to the launcher's own build.
 */
export function launchTarget(binPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const basePackageDir = dirname(dirname(binPath));
    const baseVersion = readPackageVersion(basePackageDir);
    if (!baseVersion) return null;
    const root = versionsRoot(env);
    setLaunchContext({ basePackageDir, baseVersion, root });
    const active = activeVersion(root, basePackageDir, baseVersion);
    return active.packageDir === basePackageDir ? null : pathToFileURL(join(active.packageDir, "dist", "index.js")).href;
  } catch {
    return null;
  }
}
