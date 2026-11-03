import { CourierError } from './errors.js';
import { cmd } from './program.js';

/**
 * The lines, on stderr, that tell an agent what to do next while an owner approval is outstanding (TC-2360).
 * Agents act only on what Courier prints, and rewrite the guides they were given: these are the lines they keep.
 */

/** After the link `init --request` prints: collect the approval in the same turn. */
export function initRequestNextLine(): string {
  return `Next: after sending the owner this link, run \`${cmd('init --wait --timeout 60s')}\` now, in this same turn, without waiting for a reply.`;
}

/** After a pending `init --wait` (exit 8): `argv` is the command as it was run, without the program name. */
export function pendingNextLine(argv: string[]): string {
  const same = cmd(argv.map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' '));
  return `Next: if you have not sent the owner this link yet, send it now. Then run \`${same}\` again right away, without waiting for a reply.`;
}

/** The last line of a pending `invite`: the link is on stdout; hand it to the owner, then serve the invitation. */
export function inviteNextLine(invitationId: string): string {
  return `Next: send this invite link to the owner now, then run \`${cmd(`invite serve ${invitationId}`)}\`.`;
}

/** The last line of a pending `invite serve`: the saved link `invite` printed, or a pointer to it when none is saved. */
export function inviteServeNextLine(link: string | undefined): string {
  return typeof link === 'string' && link !== ''
    ? `Next: if you have not sent the owner this invitation link yet, send it now: ${link}`
    : 'Next: if you have not sent the owner this invitation link yet, send the invitation link printed by `invite` now.';
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
