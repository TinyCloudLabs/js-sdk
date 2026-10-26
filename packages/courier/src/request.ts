import { CourierError } from './errors.js';
import { canonicalTarget, VERBS, type Verb } from './guard/target.js';
import {
  asciiTargetProblem, baseBranchProblem, headShaProblem, summaryProblem, MAX_ACTION, MAX_REASON, MAX_RISK, MAX_SUMMARY, MAX_TARGET, plainLineProblem, plainTextProblem, targetShapeProblem,
} from './text.js';

export { MAX_SUMMARY, MAX_TARGET };

/**
 * What an approval request names, in structured fields (spec §7). They live in `me/requests/<id>.json`, so the
 * request hash covers them; the view renders "Approving lets your agent <verb> <target> for <peer>: “<summary>”" from them and
 * the guard matches the command it is about to allow to `verb` and `target`, never to free text.
 *
 * The write-time rules (this file, `text.ts`) are the same the view enforces when it reads a request: anything that
 * fails them is refused, never repaired or shortened, so what the human sees is exactly what the hash covers.
 */
export type RequestFields = {
  /** Canonical form for the verb (see `guard/target.ts`), printable ASCII. */
  target: string;
  /** One line for the human, display only; never matched against anything. */
  summary: string;
} & ({ verb: 'merge'; headSha: string; base: string } | { verb: Exclude<Verb, 'merge'>; headSha?: never; base?: never });

function refuse(field: string, problem: string): never {
  throw new CourierError('usage', `--${field} is refused: ${problem}.`);
}

/** Validates the structured flags of `courier request`: canonicalises the target, refuses (never repairs) bad text. */
export function requestFields(input: { verb?: string; target?: string; summary?: string; headSha?: string; base?: string }): RequestFields {
  const { verb, target, summary } = input;
  if (!verb || !(VERBS as readonly string[]).includes(verb)) {
    throw new CourierError('usage', `--verb is required and must be one of: ${VERBS.join(', ')}.`);
  }
  if (!target) throw new CourierError('usage', '--target is required (what is being merged, deployed, published, spent or changed).');
  if (!summary) throw new CourierError('usage', '--summary is required: one line for your owner on what this approves.');
  const canonical = canonicalTarget(verb, target);
  const targetProblem = asciiTargetProblem(canonical) ?? targetShapeProblem(verb, canonical);
  if (targetProblem) refuse('target', targetProblem);
  const summaryIssue = summaryProblem(summary);
  if (summaryIssue) refuse('summary', summaryIssue);
  if (verb === 'merge') {
    const shaProblem = headShaProblem(input.headSha);
    if (shaProblem) refuse('head-sha', shaProblem);
    const baseProblem = baseBranchProblem(input.base);
    if (baseProblem) refuse('base', baseProblem);
    return { verb, target: canonical, summary, headSha: input.headSha!, base: input.base! };
  }
  if (input.headSha !== undefined || input.base !== undefined) {
    throw new CourierError('usage', '--head-sha and --base are only allowed for --verb merge.');
  }
  return { verb: verb as Exclude<Verb, 'merge'>, target: canonical, summary };
}

/** A ULID: 26 Crockford base32 characters (no I, L, O, U), upper case. Thread, task and request ids all are. */
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** A peer handle as pairing stores it. A leading `_` is reserved (invite folders live under `to/_invites/`). */
export const HANDLE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

/** `threadId` and `taskId` are written into the request (and so shown and hashed): ULIDs only, the one form the view shows. */
export function requestIds(ids: { threadId: string; taskId: string }): void {
  for (const [name, value] of Object.entries(ids)) {
    if (!ULID.test(value)) throw new CourierError('usage', `${name === 'taskId' ? '--task' : 'the thread id'} must be a ULID (26 characters, digits and capital letters except I L O U; got ${JSON.stringify(value.slice(0, 40))}).`);
  }
}

/**
 * The closed key set of `me/requests/<id>.json` (what `courier request` writes and the view accepts): any other key,
 * a missing one, or a value of the wrong type makes the request unreviewable. Returns the problem, or undefined.
 */
export const REQUEST_KEYS = [
  'id', 'peer', 'threadId', 'taskId', 'verb', 'target', 'summary', 'action', 'reason', 'risk',
  'requestedBy', 'createdAt', 'expiresAt', 'status',
] as const;
/** `courier request` always writes these three; a reader treats them as optional (but well-formed when present). */
const OPTIONAL_KEYS = ['action', 'reason', 'risk'];
export const MERGE_REQUEST_KEYS = [...REQUEST_KEYS, 'headSha', 'base'] as const;

export function requestShapeProblem(request: Record<string, unknown>): string | undefined {
  const allowedKeys = request.verb === 'merge' ? MERGE_REQUEST_KEYS : REQUEST_KEYS;
  const keys = Object.keys(request);
  const unknown = keys.filter((key) => !(allowedKeys as readonly string[]).includes(key));
  if (unknown.length) return `unknown key ${JSON.stringify(unknown[0])}`;
  if (request.verb === 'merge' && (!('headSha' in request) || !('base' in request))) return 'merge request lacks headSha/base: re-request';
  const missing = allowedKeys.filter((key) => !OPTIONAL_KEYS.includes(key) && !(key in request));
  if (missing.length) return `missing key "${missing[0]}"`;
  for (const key of allowedKeys) {
    if (key === 'requestedBy' || !(key in request)) continue;
    if (typeof request[key] !== 'string') return `"${key}" is not a string`;
  }
  const by = request.requestedBy;
  if (by === null || typeof by !== 'object' || Array.isArray(by)) return '"requestedBy" is not an object';
  const byKeys = Object.keys(by);
  if (byKeys.length !== 2 || !byKeys.includes('owner') || !byKeys.includes('agent')) return '"requestedBy" must have exactly owner and agent';
  if (typeof (by as Record<string, unknown>).owner !== 'string' || typeof (by as Record<string, unknown>).agent !== 'string') return '"requestedBy" values are not strings';
  if (request.status !== 'pending') return '"status" must be "pending"';
  for (const key of ['id', 'threadId', 'taskId'] as const) if (!ULID.test(request[key] as string)) return `"${key}" is not a ULID`;
  if (!HANDLE.test(request.peer as string)) return '"peer" is not a peer handle';
  return undefined;
}

/** The free-text fields of a request, refused (not repaired) if they break the shared text rules. */
export function requestText(input: { action?: string; reason: string; risk?: string }, summary: string): { action: string; reason: string; risk: string } {
  const action = input.action ?? summary;
  const risk = input.risk ?? 'unspecified';
  const problems: [string, string | undefined][] = [
    ['action', plainTextProblem(action, MAX_ACTION)],
    ['why', plainTextProblem(input.reason, MAX_REASON)],
    ['risk', plainTextProblem(risk, MAX_RISK)],
  ];
  for (const [field, problem] of problems) if (problem) refuse(field, problem);
  return { action, reason: input.reason, risk };
}

/**
 * The structured fields of a stored request, or undefined if any is missing, mistyped, out of range, not canonical for
 * its verb, or breaks the text rules. A request without them cannot be approved: file a new one.
 */
export function storedRequestFields(request: Record<string, unknown>): RequestFields | undefined {
  const { verb, target, summary } = request;
  if (typeof verb !== 'string' || !(VERBS as readonly string[]).includes(verb)) return undefined;
  if (typeof target !== 'string' || asciiTargetProblem(target) || targetShapeProblem(verb, target)) return undefined;
  if (summaryProblem(summary)) return undefined;
  try {
    // The stored target must already be the one canonical spelling for its verb: a hand-written variant is not what
    // the guard would match, and not what `courier request` writes.
    if (canonicalTarget(verb, target) !== target) return undefined;
  } catch {
    return undefined;
  }
  if (verb === 'merge') {
    if (headShaProblem(request.headSha) || baseBranchProblem(request.base)) return undefined;
    return { verb, target, summary: summary as string, headSha: request.headSha as string, base: request.base as string };
  }
  if ('headSha' in request || 'base' in request) return undefined;
  return { verb: verb as Exclude<Verb, 'merge'>, target, summary: summary as string };
}
