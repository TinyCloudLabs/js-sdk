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

/** After `invite` prints the invitation link (on stdout): hand it to the owner, then serve the invitation. */
export function inviteNextLine(invitationId: string): string {
  return `Next: send this invite link to the owner now, then run \`${cmd(`invite serve ${invitationId}`)}\`.`;
}

/** Before `invite serve` starts waiting: the saved link `invite` printed, or a pointer to it when none is saved. */
export function inviteServeNextLine(link: string | undefined): string {
  return typeof link === 'string' && link !== ''
    ? `Next: if you have not sent the owner this invitation link yet, send it now: ${link}`
    : 'Next: if you have not sent the owner this invitation link yet, send the invitation link printed by `invite` now.';
}
