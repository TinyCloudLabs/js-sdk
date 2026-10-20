import { CourierError } from './errors.js';
import { k } from './keys.js';
import { isRecord } from './a2a.js';
import { requestHash } from './canonical.js';
import { storedRequestFields } from './request.js';
import { allStrings, hiddenTextProblem } from './text.js';
import { canonicalTarget, targetHelp } from './guard/target.js';
import { getJson, putCreate } from './store.js';
import type { KV } from './inbox.js';
import type { ParsedArgs } from './args.js';
import { cmd } from './program.js';
import { courierNode } from './node.js';
import { loadProfile } from './profile.js';
import { writeOut } from './inbox.js';

const DAY_MS = 24 * 3600 * 1000;
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
  decision: 'approved' | 'denied';
  note: string;
  decidedAt: string;
  /** What was approved: matched against the command by `verb` and `target`, never by free text. */
  verb: string;
  target: string;
  summary: string;
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
  options: { now?: number; verb?: string; target?: string } = {},
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
  const fields = storedRequestFields(request);
  if (!fields) {
    fail('approval-mismatch', 'The request has no valid structured verb, target and summary (an older request, or a hand-written one); it cannot be approved. File a new `courier request`.');
  }
  if (options.verb !== undefined && options.verb !== fields.verb) {
    fail('approval-mismatch', `The approval is for "${fields.verb}", not "${options.verb}".`);
  }
  if (options.target !== undefined && options.target !== fields.target) {
    fail('approval-mismatch', `The approval is for target ${JSON.stringify(fields.target)}, not ${JSON.stringify(options.target)}.`);
  }
  return {
    requestId: id,
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
 * True if the approval was used (the marker under `me/state/approvals-used/`). Note the courier key can delete under
 * `me/state/` (spec §3); a delete-proof record is being designed separately (G3), so this is the one place to change.
 */
export async function approvalIsUsed(kv: KV, id: string): Promise<boolean> {
  return Boolean(await getJson(kv, k.approvalUsed(id)));
}

/** Marks an approval used. The marker is create-only, so of two racing callers exactly one wins. */
export async function consumeApproval(kv: KV, id: string, at = new Date()): Promise<void> {
  try {
    await putCreate(kv, k.approvalUsed(id), { requestId: id, usedAt: at.toISOString() });
  } catch (error) {
    if (error instanceof CourierError && error.code === 'conflict') fail('approval-used', `Approval ${id} was already used; an approval covers one action.`);
    throw error;
  }
}

const SAFE = /^[0-9A-Za-z_-]{1,64}$/;

export const approvalUsage = () =>
  `Usage: ${cmd('approval <id> --verb <v> --target <t> [--peek]')} (--verb and --target may be omitted with --peek)`;

/**
 * `courier approval <id> --verb V --target T`: exit 0 and consume the approval only if the owner approved this exact
 * request (its structured verb and target equal yours), within 24 hours, and nobody has used it. `--peek` verifies
 * without consuming (for guards) and fails the same way for a used approval. A denial exits non-zero.
 */
export async function cmdApproval(args: ParsedArgs): Promise<void> {
  const id = args.positional[0] ?? fail('usage', approvalUsage());
  if (!SAFE.test(id)) fail('usage', `"${id}" is not a request id. ${approvalUsage()}`);
  const flag = (name: string) => {
    if (!args.has(name)) return undefined;
    const value = args.get(name);
    if (value === 'true' || value === '') fail('usage', `--${name} needs a value.`);
    return value;
  };
  const verb = flag('verb');
  const rawTarget = flag('target');
  if ((verb === undefined) !== (rawTarget === undefined)) fail('usage', `--verb and --target go together. ${approvalUsage()}`);
  if (verb === undefined && !args.has('peek')) fail('usage', `Say what you are about to do, so the approval is bound to it. ${approvalUsage()}\n${targetHelp()}`);
  const target = verb !== undefined ? canonicalTarget(verb, rawTarget!) : undefined;
  const node = await courierNode(loadProfile());
  const request = await getJson<unknown>(node.kv, k.request(id));
  if (!request) fail('approval-mismatch', `No request ${id} in me/requests/.`);
  const approval = await getJson<unknown>(node.kv, k.approval(id));
  if (!approval) fail('approval-missing', `No approval for request ${id} yet. Your owner decides in the view or in your chat; stop and wait.`);
  const verified = verifyApproval(id, request.value, approval.value, { verb, target });
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
