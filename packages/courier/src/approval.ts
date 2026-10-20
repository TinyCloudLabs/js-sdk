import { CourierError } from './errors.js';
import { k } from './keys.js';
import { isRecord } from './a2a.js';
import { requestHash } from './canonical.js';
import { requestShapeProblem, storedRequestFields } from './request.js';
import { allStrings, hiddenTextProblem, MAX_ACTION, MAX_REASON, MAX_RISK, plainLineProblem, plainTextProblem } from './text.js';
import { canonicalTarget, targetHelp } from './guard/target.js';
import { getJson } from './store.js';
import { isConsumed, markConsumed } from './consumed.js';
import type { KV } from './inbox.js';
import type { ParsedArgs } from './args.js';
import { cmd } from './program.js';
import { courierNode } from './node.js';
import { loadProfile } from './profile.js';
import { writeOut } from './inbox.js';

const DAY_MS = 24 * 3600 * 1000;
const MAX_NOTE = 2000;
/** The view stamps `decidedAt` with the browser's clock; a decision dated slightly ahead of this machine's clock is tolerated. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** An approval's stated decision on a request, as the view writes `me/approvals/<id>.json`. */
export interface ApprovalRecord {
  requestId: string;
  requestHash: string;
  decision: 'approved' | 'denied';
  note: string;
  decidedAt: string;
}

export interface VerifiedApproval {
  requestId: string;
  /** Lowercase hex SHA-256 of the request's canonical JSON; the view shows its first 8 digits as the card's fingerprint. */
  requestHash: string;
  decision: 'approved' | 'denied';
  note: string;
  decidedAt: string;
  /** What was approved: matched against the command by `verb` and `target`, never by free text. */
  verb: string;
  target: string;
  summary: string;
  /** Merge-only pins from the hashed request. Branch names preserve case. */
  headSha?: string;
  base?: string;
  peer: string;
  threadId: string;
  taskId: string;
}

function fail(code: string, message: string): never {
  throw new CourierError(code, message);
}

function ms(value: unknown, what: string): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) fail('approval-mismatch', `${what} is not a valid timestamp.`);
  return parsed;
}

/**
 * Spec §7: an approval covers one request and expires after 24 hours. Throws a CourierError with a stable code
 * unless `approval` is a current, matching decision on `request` (denials are reported, not thrown).
 */
export function verifyApproval(
  id: string,
  request: unknown,
  approval: unknown,
  options: { now?: number; verb?: string; target?: string; headSha?: string; base?: string } = {},
): VerifiedApproval {
  const now = options.now ?? Date.now();
  if (!isRecord(request) || request.id !== id) fail('approval-mismatch', `me/requests/${id}.json is missing or its id is not "${id}".`);
  if (!isRecord(approval)) fail('approval-missing', `No approval for request ${id} yet.`);
  if (approval.requestId !== id) fail('approval-mismatch', `Approval ${id}.json names request "${String(approval.requestId)}", not "${id}".`);
  if (approval.decision !== 'approved' && approval.decision !== 'denied') {
    fail('approval-mismatch', `Approval decision must be "approved" or "denied" (got ${JSON.stringify(approval.decision)}).`);
  }
  // Fail closed on a request that cannot be hashed (non-finite number, absurd nesting) or hides text from the reader.
  let hash: string;
  try {
    hash = requestHash(request);
  } catch (error) {
    fail('approval-mismatch', `The request cannot be verified: ${(error as Error).message}`);
  }
  for (const text of allStrings(request)) {
    const problem = hiddenTextProblem(text, true);
    if (problem) fail('approval-mismatch', `The request contains text a person could not read as written (${problem}); it cannot be approved. File a new \`courier request\`.`);
  }
  if (approval.requestHash !== hash) {
    fail('approval-mismatch', `Approval ${id} was not made for this request as stored (hash mismatch): the request changed after the decision.`);
  }
  // Everything of the approval that is echoed to the agent is swept like the request: no hidden text.
  const noteProblem = approval.note === undefined || approval.note === '' ? undefined : plainTextProblem(approval.note, MAX_NOTE);
  if (typeof approval.note !== 'string' && approval.note !== undefined) fail('approval-mismatch', 'The approval note is not text.');
  if (noteProblem) fail('approval-mismatch', `The approval note is refused: ${noteProblem}.`);
  const stampProblem = plainLineProblem(approval.decidedAt, 40);
  if (stampProblem) fail('approval-mismatch', `decidedAt is refused: ${stampProblem}.`);
  const decidedAt = ms(approval.decidedAt, 'decidedAt');
  const created = ms(request.createdAt, 'request createdAt');
  const expires = ms(request.expiresAt, 'request expiresAt');
  // Spec §7: the decision lies in [createdAt, expiresAt). Both timestamps come from different clocks; that is why the
  // README asks for them to agree.
  if (decidedAt < created) fail('approval-mismatch', 'The decision is dated before the request existed.');
  if (decidedAt > now + FUTURE_SKEW_MS) fail('approval-mismatch', 'The decision is dated in the future.');
  if (decidedAt >= expires) fail('approval-expired', 'The decision came after the request expired.');
  if (now - decidedAt >= DAY_MS) fail('approval-expired', 'The approval is older than 24 hours; ask your owner again.');
  if (typeof request.peer !== 'string' || typeof request.threadId !== 'string' || typeof request.taskId !== 'string') {
    fail('approval-mismatch', 'The request is missing peer, threadId or taskId.');
  }
  const shape = requestShapeProblem(request);
  if (shape) fail('approval-mismatch', `The request is not in the form \`courier request\` writes (${shape}); it cannot be approved. File a new \`courier request\`.`);
  // The free text is only displayed, but the owner read it: whatever is present must be well-formed text, never empty.
  for (const [name, max] of [['action', MAX_ACTION], ['reason', MAX_REASON], ['risk', MAX_RISK]] as const) {
    if (name in request && plainTextProblem(request[name], max)) fail('approval-mismatch', `The request's ${name} is empty, too long or not plain text; it cannot be approved. File a new \`courier request\`.`);
  }
  const fields = storedRequestFields(request);
  if (!fields) {
    fail('approval-mismatch', 'The request has invalid structured fields (verb, target, summary or merge headSha/base); it cannot be approved. File a new `courier request`.');
  }
  if (options.verb !== undefined && options.verb !== fields.verb) {
    fail('approval-mismatch', `The approval is for "${fields.verb}", not "${options.verb}".`);
  }
  if (options.target !== undefined && options.target !== fields.target) {
    fail('approval-mismatch', `The approval is for target ${JSON.stringify(fields.target)}, not ${JSON.stringify(options.target)}.`);
  }
  for (const key of ['headSha', 'base'] as const) {
    if (options[key] !== undefined && options[key] !== fields[key]) {
      fail('approval-mismatch', `The approval's ${key} does not match the supplied ${key}.`);
    }
  }
  return {
    requestId: id,
    requestHash: hash,
    ...(fields.verb === 'merge' ? { headSha: fields.headSha, base: fields.base } : {}),
    decision: approval.decision,
    note: typeof approval.note === 'string' ? approval.note : '',
    decidedAt: approval.decidedAt as string,
    verb: fields.verb,
    target: fields.target,
    summary: fields.summary,
    peer: request.peer,
    threadId: request.threadId,
    taskId: request.taskId,
  };
}

/**
 * True if the approval was used: the marker under `me/consumed/`, which the courier key can create but never delete.
 * Presence is the signal; only a key-level 404 means unused; anything else throws `approval-state-unknown`, so every
 * caller fails closed (see consumed.ts).
 */
export const approvalIsUsed = isConsumed;

/** Marks an approval used. The marker is create-only, so of two racing callers exactly one wins. */
export const consumeApproval = markConsumed;

const SAFE = /^[0-9A-Za-z_-]{1,64}$/;

export const approvalUsage = () =>
  `Usage: ${cmd('approval <id> --verb <v> --target <t> [--head-sha <sha>] [--base <branch>] [--peek]')} (--verb and --target may be omitted with --peek)`;

/**
 * `courier approval <id> --verb V --target T`: exit 0 and consume the approval only if the owner approved this exact
 * request (its structured verb and target equal yours), within 24 hours, and nobody has used it. `--peek` verifies
 * without consuming (for guards) and fails the same way for a used approval. A denial exits non-zero.
 */
export async function cmdApproval(args: ParsedArgs): Promise<void> {
  const id = args.positional[0] ?? fail('usage', approvalUsage());
  if (!SAFE.test(id)) fail('usage', `"${id}" is not a request id. ${approvalUsage()}`);
  if (args.has('action')) {
    fail('usage', `--action no longer exists: an approval is bound to what you are about to do by --verb and --target. ${approvalUsage()}\n${targetHelp()}`);
  }
  const flag = (name: string) => {
    if (!args.has(name)) return undefined;
    const value = args.get(name);
    if (value === 'true' || value === '') fail('usage', `--${name} needs a value.`);
    return value;
  };
  const verb = flag('verb');
  const rawTarget = flag('target');
  const headSha = flag('head-sha');
  const base = flag('base');
  if ((verb === undefined) !== (rawTarget === undefined)) fail('usage', `--verb and --target go together. ${approvalUsage()}`);
  if (verb === undefined && !args.has('peek')) fail('usage', `Say what you are about to do, so the approval is bound to it. ${approvalUsage()}\n${targetHelp()}`);
  const target = verb !== undefined ? canonicalTarget(verb, rawTarget!) : undefined;
  const node = await courierNode(loadProfile());
  const request = await getJson<unknown>(node.kv, k.request(id));
  if (!request) fail('approval-mismatch', `No request ${id} in me/requests/.`);
  const approval = await getJson<unknown>(node.kv, k.approval(id));
  if (!approval) fail('approval-missing', `No approval for request ${id} yet. Your owner decides in the view or in your chat; stop and wait.`);
  const verified = verifyApproval(id, request.value, approval.value, { verb, target, headSha, base });
  if (verified.decision === 'denied') {
    await writeOut(`${JSON.stringify({ ok: false, code: 'approval-denied', ...verified }, null, 2)}\n`);
    throw new CourierError('approval-denied', `Your owner denied request ${id}${verified.note ? `: ${verified.note}` : ''}. Do not take the action.`);
  }
  if (await approvalIsUsed(node.kv, id)) {
    await writeOut(`${JSON.stringify({ ok: false, code: 'approval-used', requestId: id }, null, 2)}\n`);
    throw new CourierError('approval-used', `Approval ${id} was already used; an approval covers one action.`);
  }
  if (!args.has('peek')) await consumeApproval(node.kv, id);
  await writeOut(`${JSON.stringify({ ok: true, consumed: !args.has('peek'), ...verified }, null, 2)}\n`);
}
