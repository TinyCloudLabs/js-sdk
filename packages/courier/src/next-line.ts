import { CourierError } from './errors.js';
import { cmd } from './program.js';

/**
 * The lines, on stderr, that tell an agent what to do next while an owner approval is outstanding (TC-2360).
 * Agents act only on what Courier prints, and rewrite the guides they were given: these are the lines they keep.
 */

/** After the link `init --request` prints: collect the approval in the same turn. */
export function initRequestNextLine(): string {
  return `Next: send the owner the link above, then run \`${cmd('init --wait --timeout 60s')}\` now, in this same turn; do not wait for the owner to reply.`;
}

/**
 * After a pending `init --wait` (exit 8): `argv` is the command as it was run, without the program name;
 * `created` says the link was made in this run (otherwise the request was resumed and the link may already be sent).
 */
export function pendingNextLine(argv: string[], created: boolean): string {
  const same = cmd(argv.map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' '));
  return created
    ? `Next: send the owner the link above, then run \`${same}\` again now, in this same turn; do not wait for the owner to reply (the command sees the approval itself).`
    : `Next: run \`${same}\` again now, in this same turn, and send the owner the link above first only if you have not sent it yet; do not wait for the owner to reply.`;
}

/** The last line of a pending `invite`: the link is on stdout; hand it to the owner, then serve the invitation. */
export function inviteNextLine(invitationId: string): string {
  return `Next: send the owner the invitation link above before anything else, then run \`${cmd(`invite serve ${invitationId} --wait 60`)}\` now, in this same turn.`;
}

/** The last line of a pending `invite serve`: the saved link `invite` printed, or a pointer to it when none is saved. */
export function inviteServeNextLine(link: string | undefined): string {
  return typeof link === 'string' && link !== ''
    ? `Next: if you have not sent the owner the invitation link yet, send it now: ${link} (then run this same command again now, in this same turn).`
    : 'Next: if you have not sent the owner the invitation link yet, send the invitation link printed by `invite` now (then run this same command again now, in this same turn).';
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
