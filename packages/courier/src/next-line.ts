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
  return `Next: send the owner the link above now, then run \`${cmd('init --wait --timeout 60s')}\` right away, in this same turn; do not wait for a reply.`;
}

/**
 * After a pending `init --wait` (exit 8): `argv` is the command as it was run, without the program name; `created`
 * says the link was made in this run (otherwise the request was resumed and the link may already be sent).
 */
export function pendingNextLine(argv: string[], created: boolean): string {
  const same = cmd(argv.map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' '));
  return created
    ? `Next: send the owner the link above now, then run \`${same}\` again right away, in this same turn; do not wait for a reply.`
    : `Next: run \`${same}\` again now, in this same turn, and first send the owner the link above only if you have not sent it yet; do not wait for a reply.`;
}

/** The last line of a pending `invite`: the link is on stdout; hand it to the owner, then serve the invitation. */
export function inviteNextLine(invitationId: string): string {
  return `Next: send this invite link to the owner now, then run \`${cmd(`invite serve ${invitationId} --wait 60`)}\` right away, in this same turn; do not wait for a reply.`;
}

/** The first line of every `invite serve` run: the saved link `invite` printed, or a pointer to it when none is saved. */
export function inviteServeNextLine(link: string | undefined): string {
  return typeof link === 'string' && link !== ''
    ? `Next: if you have not sent the owner this invitation link yet, send it now: ${link}`
    : 'Next: if you have not sent the owner this invitation link yet, send the invitation link printed by `invite` now.';
}

/** The last line of a pending `invite serve`: nobody has joined yet, so run it again. `waitSeconds` is the `--wait` it ran with. */
export function invitePendingNextLine(invitationId: string, waitSeconds: number): string {
  return `Next: no one has joined yet; run \`${cmd(`invite serve ${invitationId} --wait ${waitSeconds}`)}\` again now, in this same turn; do not wait for a reply.`;
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
