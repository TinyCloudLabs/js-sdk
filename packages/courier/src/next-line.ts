import { CourierError } from './errors.js';
import { cmd } from './program.js';

/**
 * The lines, on stderr, that tell an agent what to do next while an owner approval or an invitation is outstanding
 * (TC-2360). Agents act only on what Courier prints, cut everything after the first clause, and rewrite the guides
 * they were given: the action comes first, in one sentence, and names the exact command. Commands carry the program
 * name Courier was started as (`courier` or `tinycloud courier`).
 */

/** After the link `init --request` prints: collect the approval in the same turn. */
export function initRequestNextLine(): string {
  return `Next: write the link above in your reply to the owner now, and in that same reply run \`${cmd('init --wait --timeout 60s')}\`; do not end your turn or wait for a reply.`;
}

/**
 * After a pending `init --wait` (exit 8): `argv` is the command as it was run, without the program name; `created`
 * says the link was made in this run (otherwise the request was resumed and the link may already be sent).
 */
export function pendingNextLine(argv: string[], created: boolean): string {
  const same = cmd(argv.map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' '));
  return created
    ? `Next: write the link above in your reply to the owner now, and in that same reply run \`${same}\` again; do not end your turn or wait for a reply.`
    : `Next: if you have not written the link above to the owner yet, write it in your reply now, and in that same reply run \`${same}\` again; do not end your turn or wait for a reply.`;
}

/** The last line of a pending `invite`: the link is on stdout; hand it to the owner, then serve the invitation. */
export function inviteNextLine(invitationId: string): string {
  return `Next: write the invitation link above in your reply to the owner now, and in that same reply run \`${cmd(`invite serve ${invitationId} --wait 60`)}\`; do not end your turn or wait for a reply.`;
}

/** The first line of every `invite serve` run: the saved link `invite` printed, or a pointer to it when none is saved. */
export function inviteServeNextLine(link: string | undefined): string {
  return typeof link === 'string' && link !== ''
    ? `Next: if you have not written this invitation link to the owner yet, write it in your reply now: ${link}`
    : 'Next: if you have not written the invitation link printed by `invite` to the owner yet, write it in your reply now.';
}

/** The last line of a pending `invite serve`: nobody has joined yet, so run it again. `waitSeconds` is the `--wait` it ran with. */
export function invitePendingNextLine(invitationId: string, waitSeconds: number): string {
  return `Next: no one has joined yet; run \`${cmd(`invite serve ${invitationId} --wait ${waitSeconds}`)}\` again now, in this same turn; do not end your turn or wait for a reply.`;
}

/**
 * `.catch` handler for `serveInvitation`: a wait that ends `invite-pending` keeps its code and message and gains `line`
 * as its last line, so `main` prints it after the error line. Any other outcome is untouched, and so is the exit code.
 */
export function nextOnInvitePending(line: string): (error: unknown) => never {
  return (error) => {
    if (error instanceof CourierError && error.code === 'invite-pending') throw new CourierError(error.code, `${error.message}\n${line}`);
    throw error;
  };
}
