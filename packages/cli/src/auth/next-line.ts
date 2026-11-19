import { CLI_NAME } from "@tinycloud/operations/cli-name";

/**
 * The one line, on stderr, that tells an agent what to do when an approval wait ends with exit 8 (TC-2360).
 * Agents act only on what the CLI prints, cut everything after the first clause, and rewrite the guides they were
 * given: the action comes first, in one sentence, and names the exact command.
 */

/** One shell word: left as is when it is plain, otherwise single-quoted. */
const shellWord = (arg: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

// What may be echoed is an ALLOWLIST: the command line is printed only when every token is known to be harmless.
// Anything else (an unknown flag, a short flag, `--flag=value`, a positional that is not a subcommand word or a
// `.json` path, a value outside the plain pattern, a long token, a JWT-like token, any control character) makes the
// line say `this same command` and echo nothing. Flags are those that can reach exit 8 in `onboard` and `auth grant`.
const WORDS: Record<string, true> = { onboard: true, auth: true, grant: true };
const VALUE_FLAGS: Record<string, true> = { "--timeout": true, "--profile": true, "-p": true, "--host": true, "-H": true };
const BOOLEAN_FLAGS: Record<string, true> = {
  "--json": true, "--yes": true, "--quiet": true, "-q": true, "--verbose": true, "-v": true,
  "--no-cache": true, "--no-retry": true, "--replication": true, "--no-replication": true,
};
const isKnown = (table: Record<string, true>, name: string): boolean => Object.hasOwn(table, name);
/** A request file named on the command line. */
const SOURCE_FILE = /^[A-Za-z0-9._/-]{1,64}\.json$/;
const PLAIN_VALUE = /^[A-Za-z0-9._:@/+ -]{1,64}$/;
/** Values that look like a one-time code or a delegation even though they are plain characters. */
const LONG_TOKEN = /^[A-Za-z0-9+/_-]{24,}={0,2}$/;
const JWT_LIKE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;

const safeValue = (value: string): boolean => PLAIN_VALUE.test(value) && !LONG_TOKEN.test(value) && !JWT_LIKE.test(value);

function safeToEcho(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (isKnown(BOOLEAN_FLAGS, arg)) continue;
    if (isKnown(VALUE_FLAGS, arg)) {
      const value = argv[(index += 1)];
      if (value === undefined || !safeValue(value)) return false;
      continue;
    }
    if (arg.startsWith("-")) return false;
    if (!isKnown(WORDS, arg) && !SOURCE_FILE.test(arg)) return false;
  }
  return true;
}

/**
 * Whether the command reads its input from stdin (`--stdin`, `--paste`, a bare `-`, or `auth grant` with no source),
 * so running the echoed command again without the same input would read nothing.
 */
function readsStdin(argv: readonly string[]): boolean {
  if (argv.includes("--stdin") || argv.includes("--paste") || argv.includes("-")) return true;
  const grant = argv.findIndex((arg, index) => arg === "auth" && argv[index + 1] === "grant");
  if (grant === -1) return false;
  for (let index = grant + 2; index < argv.length; index += 1) {
    if (isKnown(VALUE_FLAGS, argv[index]!)) index += 1;
    else if (!argv[index]!.startsWith("-")) return false;
  }
  return true;
}

/**
 * `created`: the link was made in this run. Otherwise it is a resume or a deadline: the CLI cannot know whether the
 * agent already relayed the link, so it must not claim the owner has it. The command is echoed in backticks only
 * when it is safe to; otherwise the words `this same command` (with `with the same input` when it reads stdin).
 */
export function approvalNextLine(created: boolean, argv: readonly string[] = process.argv.slice(2)): string {
  const stdin = readsStdin(argv);
  const command = !stdin && argv.length > 0 && safeToEcho(argv) ? `\`${[CLI_NAME, ...argv.map(shellWord)].join(" ")}\`` : "this same command";
  const again = stdin ? "again with the same input" : "again";
  return created
    ? `Next: send the owner the link above in your reply now. When the owner next writes to you, run ${command} ${again}.`
    : `Next: if you have not sent the owner the link above yet, send it in your reply now. When the owner next writes to you, run ${command} ${again}.`;
}
