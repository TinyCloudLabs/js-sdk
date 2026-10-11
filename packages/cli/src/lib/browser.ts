import type { ChildProcess } from "node:child_process";
import open from "open";
import { shouldOutputJson } from "../output/formatter.js";
import { theme } from "../output/theme.js";

/**
 * How long a launcher (xdg-open/open/PowerShell) gets to report a failure.
 * Launchers normally exit within tens of milliseconds; one still running
 * after this has handed the URL to a browser.
 */
const LAUNCH_CHECK_MS = 1_000;

/**
 * Try to open `url` in the user's browser. Never throws: a missing or failing
 * launcher (headless machine, no browser) returns `false`.
 */
export async function tryOpenBrowser(url: string): Promise<boolean> {
  let launcher: ChildProcess;
  try {
    launcher = await open(url);
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), LAUNCH_CHECK_MS);
    launcher.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    launcher.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Report on stderr that the browser did not open, after the command's own
 * output: one JSON line in JSON mode, one human line otherwise.
 */
export function warnBrowserNotOpened(): void {
  process.stderr.write(shouldOutputJson()
    ? `${JSON.stringify({ warnings: [{ code: "BROWSER_OPEN_FAILED", reason: "open_failed" }] })}\n`
    : `${theme.warn("!")} Could not open a browser. Open the URL above yourself.\n`);
}
