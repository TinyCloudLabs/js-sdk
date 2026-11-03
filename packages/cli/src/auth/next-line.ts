import { CLI_NAME } from "@tinycloud/operations/cli-name";

/**
 * The one line, on stderr, that tells an agent what to do when an approval wait ends with exit 8 (TC-2360).
 * Agents act only on what the CLI prints, cut everything after the first clause, and rewrite the guides they were
 * given: the action comes first, in one sentence, and names the exact command.
 */

/** One shell word: left as is when it is plain, otherwise single-quoted. */
const shellWord = (arg: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/**
 * The command as it was run, in backticks, with the program name the CLI was invoked as; without any arguments
 * (argv unavailable) the words `this same command`.
 */
function sameCommand(argv: readonly string[]): string {
  return argv.length === 0 ? "this same command" : `\`${[CLI_NAME, ...argv.map(shellWord)].join(" ")}\``;
}

/**
 * `created`: the link was made in this run. Otherwise it is a resume or a deadline: the CLI cannot know whether the
 * agent already relayed the link, so it must not claim the owner has it.
 */
export function approvalNextLine(created: boolean, argv: readonly string[] = process.argv.slice(2)): string {
  const command = sameCommand(argv);
  return created
    ? `Next: send the owner the link above now, then run ${command} again right away, in this same turn; do not wait for a reply.`
    : `Next: run ${command} again now, in this same turn, and first send the owner the link above only if you have not sent it yet; do not wait for a reply.`;
}
