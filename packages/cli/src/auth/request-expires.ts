import { LINK_MIN_LIFE_SECONDS, LINK_TYPE_SPECS } from "@tinycloud/share-envelope/links";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";

/** The approval link's window when `--request-expires` is not given: the link type's own default (1 hour). */
export const DEFAULT_REQUEST_WINDOW_MS = LINK_TYPE_SPECS["openkey-approval-request"].defaultLifeSeconds * 1000;
/** The longest window a login may ask for without a pinned owner. */
export const UNPINNED_REQUEST_WINDOW_MAX_MS = DEFAULT_REQUEST_WINDOW_MS;
/** The CLI's hard maximum, below the link service's own 24 hours. */
export const REQUEST_WINDOW_MAX_MS = 12 * 60 * 60 * 1000;
/** The shortest window the link service accepts. */
export const REQUEST_WINDOW_MIN_MS = LINK_MIN_LIFE_SECONDS * 1000;

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const FORM = /^(\d+)([smhd])$/;

export interface RequestExpiresContext {
  /** The explicit `--owner`, canonical. Only an explicit owner counts as a pin. */
  readonly pinnedOwner: string | undefined;
  /** The login does not use the approval link at all (`--paste`, `--device`, `--keys`, replication). */
  readonly unusedBy?: string;
}

const usage = (code: string, message: string): CLIError => new CLIError(code, message, ExitCode.USAGE_ERROR);

/**
 * `--request-expires D` for a login's one-tap approval link: `Ns`, `Nm`, `Nh` or `Nd`, in milliseconds. At least 2 minutes and
 * at most 12 hours. More than 1 hour needs the owner pinned with `--owner`, so a link that lives longer can only be approved by
 * that account: the signed result is checked against it before anything is saved. Every refusal is raised before a request is made.
 */
export function parseRequestExpires(value: string, context: RequestExpiresContext): number {
  const form = ` Use a number and a unit, for example 30m or 4h.`;
  if (context.unusedBy !== undefined) {
    throw usage("INVALID_ARGUMENT", `--request-expires sets the window of the one-tap approval link, which ${context.unusedBy} does not use.`);
  }
  const match = FORM.exec(value);
  if (!match) throw usage("INVALID_REQUEST_EXPIRES", `Invalid --request-expires ${JSON.stringify(value)}.${form}`);
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  if (!Number.isSafeInteger(ms) || ms < REQUEST_WINDOW_MIN_MS) {
    throw usage("INVALID_REQUEST_EXPIRES", `--request-expires must be at least ${REQUEST_WINDOW_MIN_MS / 60_000} minutes.${form}`);
  }
  assertRequestWindow(ms, context.pinnedOwner);
  return ms;
}

/**
 * The window limits, enforced where the link is created as well as at the command line, so no caller can ask for a long
 * window without a pinned owner or for more than 12 hours.
 */
export function assertRequestWindow(windowMs: number, pinnedOwner: string | undefined): void {
  if (windowMs > REQUEST_WINDOW_MAX_MS) {
    throw usage("REQUEST_EXPIRES_TOO_LONG", `--request-expires may be at most ${REQUEST_WINDOW_MAX_MS / 3_600_000} hours. Use a shorter window.`);
  }
  if (windowMs > UNPINNED_REQUEST_WINDOW_MAX_MS && pinnedOwner === undefined) {
    throw usage("REQUEST_EXPIRES_NEEDS_OWNER",
      `A --request-expires window longer than ${UNPINNED_REQUEST_WINDOW_MAX_MS / 3_600_000} hour needs the account pinned with --owner did:pkh:eip155:CHAIN:ADDRESS, so only that account's approval is accepted. Nothing was requested.`);
  }
}
