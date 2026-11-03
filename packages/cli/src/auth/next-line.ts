import { CLI_NAME } from "@tinycloud/operations/cli-name";

/**
 * The one line, on stderr, that tells an agent what to do when an approval wait ends with exit 8 (TC-2360).
 * Agents act only on what the CLI prints, cut everything after the first clause, and rewrite the guides they were
 * given: the action comes first, in one sentence, and names the exact command.
 */

/** One shell word: left as is when it is plain, otherwise single-quoted. */
const shellWord = (arg: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/** A flag whose name says it carries a secret, matched on the name alone (a value after `=` is not part of it). */
const SECRET_FLAG = /code|secret|token|key|password|passphrase|delegation|proof|authorization|bearer|credential/i;
/** A value that looks like a one-time code or a delegation: a JSON document or a long base64/base32 token. */
const SECRET_VALUE = /^(?:\{|[A-Za-z0-9+/_-]{32,}={0,2}$)/;

/** Whether echoing this command line could leak a secret. Over-matching is safe: the line then names no command. */
function mayCarrySecret(argv: readonly string[]): boolean {
  return argv.some((arg) => {
    if (!arg.startsWith("-")) return SECRET_VALUE.test(arg);
    const [name, ...value] = arg.split("=");
    return SECRET_FLAG.test(name!) || (value.length > 0 && SECRET_VALUE.test(value.join("=")));
  });
}

/**
 * The command as it was run, in backticks, with the program name the CLI was invoked as. Without any arguments (argv
 * unavailable), or when any argument could carry a secret, the words `this same command`: nothing is echoed.
 */
function sameCommand(argv: readonly string[]): string {
  return argv.length === 0 || mayCarrySecret(argv) ? "this same command" : `\`${[CLI_NAME, ...argv.map(shellWord)].join(" ")}\``;
}

/**
 * `created`: the link was made in this run. Otherwise it is a resume or a deadline: the CLI cannot know whether the
 * agent already relayed the link, so it must not claim the owner has it.
 */
export function approvalNextLine(created: boolean, argv: readonly string[] = process.argv.slice(2)): string {
  const command = sameCommand(argv);
  return created
    ? `Next: write the link above in your reply to the owner now, and in that same reply run ${command} again; do not end your turn or wait for a reply.`
    : `Next: if you have not written the link above to the owner yet, write it in your reply now, and in that same reply run ${command} again; do not end your turn or wait for a reply.`;
}
