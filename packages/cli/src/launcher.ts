/**
 * The global `tinycloud` launcher (TC-4276). `bin/tinycloud` hands over to this entry, which runs the verified version
 * the pointer names, or its own `dist/index.js`. It loads nothing but Node built-ins, so choosing costs a few file reads.
 */
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { activeVersion, launchContext, readPackageVersion, setLaunchContext, versionsRoot } from "./lib/versions.js";

const LAUNCH_CONTEXT = Symbol.for("tinycloud.cli.launchContext");

interface Target { url: string; root: string; version: string }

/**
 * Run the build the launcher at `binPath` chooses. A chosen version that fails to load (its `dist/index.js` missing or
 * unreadable, or an import that throws before that CLI starts) loses its `.verified` marker, so no later run chooses
 * it, and this install's own build runs instead: `tinycloud upgrade` stays reachable. Once the chosen CLI has started,
 * what it throws is its own and is not retried. The returned promise settles when the CLI's entry finishes.
 */
export function launch(binPath: string, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const own = new URL("./index.js", import.meta.url).href;
  const target = launchTarget(binPath, env);
  if (!target) return import(own);
  const started = watchStart();
  return import(target.url).catch((error: unknown) => {
    if (started()) throw error;
    try {
      rmSync(join(target.root, target.version, ".verified"), { force: true });
    } catch {
      // The next run tries this version again and lands here again.
    }
    if (env.TC_DEBUG === "1") process.stderr.write(`tinycloud ${target.version} failed to load: ${error instanceof Error ? error.stack : String(error)}\n`);
    return import(own);
  });
}

/**
 * The verified version to run instead of the launcher's own build, or null to run its own.
 * Every failure (no pointer, a broken one, an unreadable root) falls back to the launcher's own build.
 */
function launchTarget(binPath: string, env: NodeJS.ProcessEnv): Target | null {
  try {
    const basePackageDir = dirname(dirname(binPath));
    const baseVersion = readPackageVersion(basePackageDir);
    if (!baseVersion) return null;
    const root = versionsRoot(env);
    setLaunchContext({ basePackageDir, baseVersion, root });
    const active = activeVersion(root, basePackageDir, baseVersion);
    if (active.packageDir === basePackageDir) return null;
    return { url: pathToFileURL(join(active.packageDir, "dist", "index.js")).href, root, version: active.version };
  } catch {
    return null;
  }
}

/**
 * Whether the CLI has started: every version the launcher can choose reads the launch context (`baseInstall()`) as its
 * entry begins, after its imports have loaded. Before that read nothing of the CLI has run, so falling back is safe.
 */
function watchStart(): () => boolean {
  let started = false;
  let context = launchContext();
  Object.defineProperty(globalThis, LAUNCH_CONTEXT, {
    configurable: true,
    get() {
      started = true;
      return context;
    },
    set(value) {
      context = value;
    },
  });
  return () => started;
}
