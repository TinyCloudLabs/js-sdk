import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the CLI says about itself the first time it runs in a config folder: once, on stderr, before the first
 * command's own output. A tool the reader is already running says it, so nothing that asks for trust has to sit on a web
 * page. `cli` is the command that works on this computer (`tinycloud`, or the npx command when run by npx).
 */
export function aboutText(cli: string, signedIn: boolean): string {
  const lines = [
    "TinyCloud stores the owner's data in their own space. Apps and agents reach it only with the owner's approval.",
    "Commands: kv (keys and values), sql (databases), secrets, share (share links), feed (cards on the owner's Feed).",
    `\`${cli} <command> --help\` explains each one. Output is JSON. \`--profile <name>\` picks the account.`,
  ];
  if (!signedIn) lines.push(`This computer isn't signed in. \`${cli} onboard\` asks the owner for approval and waits for it.`);
  return `${lines.join("\n")}\n\n`;
}

const STATE_FILE = "taught.json";

/** Which messages this config folder has already shown. */
function taught(dir: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface AboutOptions {
  /** The config folder that holds `taught.json`. */
  dir: string;
  cli: string;
  /** Whether a profile already exists; the last line is only for a computer that is not signed in. */
  signedIn: boolean;
  write?: (text: string) => void;
}

/**
 * Print the about text if this config folder has not shown it yet, and remember that it did. Returns whether it
 * printed. When the state cannot be saved nothing is printed, so a read-only folder never makes it repeat.
 */
export function showAboutOnce(options: AboutOptions): boolean {
  const state = taught(options.dir);
  if (state.about === true) return false;
  try {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    const file = join(options.dir, STATE_FILE);
    writeFileSync(file, `${JSON.stringify({ ...state, about: true })}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    return false;
  }
  (options.write ?? ((text) => process.stderr.write(text)))(aboutText(options.cli, options.signedIn));
  return true;
}
