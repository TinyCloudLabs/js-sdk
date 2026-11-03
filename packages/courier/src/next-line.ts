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
  return `Next: send the owner the link above in your reply now. When the owner next writes to you, run \`${cmd('init --wait --timeout 60s')}\`.`;
}

// What may be echoed is an ALLOWLIST: the command line is printed only when every token is known to be harmless.
// Anything else (an unknown or short flag, `--flag=value`, a positional other than `init`, a value outside the plain
// pattern, a long token, a JWT-like token, any control character) makes the line say `this same command` and echo
// nothing. Flags are those `init --wait` accepts and a pending run can carry.
const VALUE_FLAGS: Record<string, true> = {
  '--timeout': true, '--label': true, '--handle': true, '--expiry': true, '--host': true, '--openkey-host': true, '--openkey-api-host': true,
};
const isKnown = (table: Record<string, true>, name: string): boolean => Object.hasOwn(table, name);
const PLAIN_VALUE = /^[A-Za-z0-9._:@/+ -]{1,64}$/;
/** Values that look like a one-time code or a delegation even though they are plain characters. */
const LONG_TOKEN = /^[A-Za-z0-9+/_-]{24,}={0,2}$/;
const JWT_LIKE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;

const safeValue = (value: string): boolean => PLAIN_VALUE.test(value) && !LONG_TOKEN.test(value) && !JWT_LIKE.test(value);

function safeToEcho(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--wait' || arg === 'init') continue;
    if (!isKnown(VALUE_FLAGS, arg)) return false;
    const value = argv[(index += 1)];
    if (value === undefined || !safeValue(value)) return false;
  }
  return true;
}

/**
 * After a pending `init --wait` (exit 8): `argv` is the command as it was run, without the program name; `created`
 * says the link was made in this run (otherwise the request was resumed and the link may already be sent). The
 * command is echoed in backticks only when it is safe to; otherwise the words `this same command`.
 */
export function pendingNextLine(argv: string[], created: boolean): string {
  const same = argv.length > 0 && safeToEcho(argv)
    ? `\`${cmd(argv.map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' '))}\``
    : 'this same command';
  return created
    ? `Next: send the owner the link above in your reply now. When the owner next writes to you, run ${same} again.`
    : `Next: if you have not sent the owner the link above yet, send it in your reply now. When the owner next writes to you, run ${same} again.`;
}

/** The last line of a pending `invite`: the link is on stdout; hand it to the owner, then serve the invitation. */
export function inviteNextLine(invitationId: string): string {
  return `Next: send the owner the invitation link above in your reply now. When the owner next writes to you, run \`${cmd(`invite serve ${invitationId} --wait 60`)}\`.`;
}

/** The first line of every `invite serve` run: the saved link `invite` printed, or a pointer to it when none is saved. */
export function inviteServeNextLine(link: string | undefined): string {
  return typeof link === 'string' && link !== ''
    ? `Next: send the owner this invitation link in your reply now if you have not sent it yet: ${link}`
    : 'Next: send the owner the invitation link printed by `invite` in your reply now if you have not sent it yet.';
}

/** The last line of a pending `invite serve`: nobody has joined yet, so run it again (no link to hand over, so no owner-cannot-see sentence). `waitSeconds` is the `--wait` it ran with. */
export function invitePendingNextLine(invitationId: string, waitSeconds: number): string {
  return `Next: No one has joined yet; run \`${cmd(`invite serve ${invitationId} --wait ${waitSeconds}`)}\` again now, in this same turn; do not end your turn or wait for a reply.`;
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
