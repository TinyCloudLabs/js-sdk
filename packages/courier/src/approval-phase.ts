import fs from 'node:fs';
import path from 'node:path';
import type { LinkRecord, OpenKeyApprovalRequestV1 } from '@tinycloud/share-envelope/links';
import { cmd } from './program.js';
import { CourierError } from './errors.js';
import { profileDir, writeSecure } from './profile.js';

/**
 * The one module that reads, writes and classifies the saved OpenKey approval request, `approval-pending.json`.
 *
 * `readApprovalEntry` is the only reader. `approvalPhase` is the only classifier: every other module asks it (or `stageOf`, the same rule
 * on one record) what the request is, and never looks at the optional fields itself. The record's schema is unchanged and so is the
 * meaning of every phase: this names what the code already did.
 *
 * Phases: `none` (no file), `open` (a request nobody has answered; `lapsed` is the request's own expiry having passed), `held` (the
 * owner approved: stage `ref` = OpenKey holds a result we have only a reference to, `result` = the encrypted result is saved here,
 * `committed` = the grant is installed and only the acknowledgement may remain), `unreadable` (the file or its directory has the wrong
 * mode, or cannot be read: the approval in it may be intact), `corrupt` (readable, not a request) and `orphaned` (a live request whose
 * profile or agent key is missing: it is never dropped on its own).
 */
export const APPROVAL_FILE = 'approval-pending.json';

/** The durable record of one approval request. The result stays encrypted at rest under `relayPrivateKey`. */
export interface PendingGrantRequest {
  version: 1;
  request: OpenKeyApprovalRequestV1;
  requestId: string;
  bodyCid: string;
  approvalUrl: string;
  requestExpiresAt: string;
  record: LinkRecord;
  apiOrigin: string;
  linkApiOrigin: string;
  openkeyOrigin: string;
  relayPrivateKey: string;
  /** Sent with the acknowledgement; stable across retries so OpenKey can recognise the same ack. */
  ackId: string;
  resultRef?: string;
  resultExpiresAt?: string;
  resultEnvelope?: unknown;
  /** The grant and profile are saved; only the acknowledgement may remain. */
  committed?: true;
}

export type ApprovalEntry =
  | { kind: 'none' }
  | { kind: 'ok'; pending: PendingGrantRequest }
  /** The file or its directory has the wrong mode, or the file cannot be read (EACCES, EIO): the record may well be intact. */
  | { kind: 'unreadable'; reason: string; fix: string }
  /** The file is readable and is not a saved request. */
  | { kind: 'corrupt'; reason: string };

export type HeldStage = 'ref' | 'result' | 'committed';

export type LivePhase =
  | { phase: 'open'; lapsed: boolean }
  | { phase: 'held'; stage: HeldStage }
  | { phase: 'unreadable'; reason: string; fix: string };

export type ApprovalPhase =
  | { phase: 'none' }
  | { phase: 'corrupt'; reason: string }
  | LivePhase
  | { phase: 'orphaned'; was: LivePhase };

/** The reader. Reads only: it never removes, repairs or rewrites the file. */
export function readApprovalEntry(): ApprovalEntry {
  const file = path.join(profileDir(), APPROVAL_FILE);
  if (!fs.existsSync(file)) return { kind: 'none' };
  const dirMode = fs.statSync(profileDir()).mode & 0o777;
  if ((dirMode & 0o077) !== 0) {
    return { kind: 'unreadable', reason: `${profileDir()} has mode ${dirMode.toString(8)}`, fix: `chmod 700 ${profileDir()}` };
  }
  const mode = fs.statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) return { kind: 'unreadable', reason: `${file} has mode ${mode.toString(8)}, not 600`, fix: `chmod 600 ${file}` };
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    return { kind: 'unreadable', reason: `${file} cannot be read (${(error as Error).message})`, fix: `chmod 600 ${file}` };
  }
  let pending: PendingGrantRequest;
  try { pending = JSON.parse(text) as PendingGrantRequest; } catch (error) { return { kind: 'corrupt', reason: (error as Error).message }; }
  if (pending && typeof pending.version === 'number' && pending.version > 1) {
    // Written by a newer Courier: not corrupt, and not ours to set aside. Use that Courier, or move the file away by hand.
    return { kind: 'unreadable', reason: `${file} was written by a newer Courier (record version ${pending.version})`, fix: `mv ${file} ${file}.newer` };
  }
  if (!pending || pending.version !== 1 || !pending.request || typeof pending.requestId !== 'string' || typeof pending.bodyCid !== 'string'
    || typeof pending.approvalUrl !== 'string' || typeof pending.relayPrivateKey !== 'string' || typeof pending.ackId !== 'string') {
    return { kind: 'corrupt', reason: 'unexpected contents' };
  }
  return { kind: 'ok', pending };
}

/** How far a held request has got: committed outranks a collected result, which outranks a reference. Undefined: nothing held. */
export function stageOf(pending: PendingGrantRequest): HeldStage | undefined {
  if (pending.committed === true) return 'committed';
  if (pending.resultEnvelope !== undefined) return 'result';
  if (pending.resultRef !== undefined) return 'ref';
  return undefined;
}

/** The request already holds something that cannot be made again: a result reference, the result itself, or an installed grant. */
export const holdsApproval = (pending: PendingGrantRequest): boolean => stageOf(pending) !== undefined;

/** A saved request has no owner to belong to when the profile or the agent key is missing. */
export const lacksOwner = (presence: { profile: boolean; key: boolean }): boolean => !presence.profile || !presence.key;

/**
 * The classifier. `presence` says whether the profile and the agent key exist (default: both do). The request's own expiry only matters
 * while nothing is held, and is judged against `now`, exactly as before.
 */
export function approvalPhase(entry: ApprovalEntry, presence: { profile: boolean; key: boolean } = { profile: true, key: true }, now: number = Date.now()): ApprovalPhase {
  if (entry.kind === 'none') return { phase: 'none' };
  if (entry.kind === 'corrupt') return { phase: 'corrupt', reason: entry.reason };
  let live: LivePhase;
  if (entry.kind === 'unreadable') {
    live = { phase: 'unreadable', reason: entry.reason, fix: entry.fix };
  } else {
    const stage = stageOf(entry.pending);
    live = stage ? { phase: 'held', stage } : { phase: 'open', lapsed: Date.parse(entry.pending.requestExpiresAt) <= now };
  }
  return lacksOwner(presence) ? { phase: 'orphaned', was: live } : live;
}

/** The saved request when it can be read, else undefined (with a warning when a file is there but unusable). For read-only and cleanup callers. */
export function loadPending(): PendingGrantRequest | undefined {
  const entry = readApprovalEntry();
  if (entry.kind === 'ok') return entry.pending;
  if (entry.kind !== 'none') {
    console.error(`warning: ignoring the saved approval request ${APPROVAL_FILE} in ${profileDir()} (${entry.reason}).`);
  }
  return undefined;
}

function unreadableError(entry: Extract<ApprovalEntry, { kind: 'unreadable' }>): CourierError {
  return new CourierError('approval-unreadable', `The saved approval request cannot be used: ${entry.reason}. It may hold an approval the owner already gave, so it was not touched and nothing else was changed. Fix it with \`${entry.fix}\`, then run \`${cmd('init --wait')}\` again.`);
}

/**
 * Stops (without changing anything) when a saved approval request exists but cannot be read. Call it before a writer changes any
 * other state, so a key, grant or profile is never replaced while the approval it belongs to is unreachable.
 */
export function assertPendingReadable(): void {
  const entry = readApprovalEntry();
  if (entry.kind === 'unreadable') throw unreadableError(entry);
}

/**
 * The saved request for a caller that is about to write one. A record that exists but cannot be read stops the command with the file
 * named and how to fix it: the approval in it may be intact (it comes back after the fix). Only a record that is readable and corrupt
 * is set aside, as `approval-pending.json.corrupt-<time>` (0600), and the command goes on without it.
 */
export function loadPendingForWrite(): PendingGrantRequest | undefined {
  const entry = readApprovalEntry();
  if (entry.kind === 'ok') return entry.pending;
  if (entry.kind === 'unreadable') {
    throw unreadableError(entry);
  }
  if (entry.kind === 'corrupt') {
    const file = path.join(profileDir(), APPROVAL_FILE);
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(file, aside);
    fs.chmodSync(aside, 0o600);
    console.error(`warning: ${APPROVAL_FILE} is corrupt (${entry.reason}); it was moved to ${aside} and will be replaced by a new request.`);
  }
  return undefined;
}

export function savePending(pending: PendingGrantRequest): void {
  writeSecure(path.join(profileDir(), APPROVAL_FILE), pending);
}

export function clearPending(): void {
  try { fs.unlinkSync(path.join(profileDir(), APPROVAL_FILE)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

// ---- the record's optional fields: only this module reads or sets them ----

/** OpenKey holds a result for this request: remember where, and until when. */
export function recordResultRef(pending: PendingGrantRequest, resultRef: string, expiresAt: string): void {
  pending.resultRef = resultRef;
  pending.resultExpiresAt = expiresAt;
}

/** The encrypted result was collected and is about to be saved. */
export function recordResultEnvelope(pending: PendingGrantRequest, relay: unknown): void {
  pending.resultEnvelope = relay;
}

/** The grant and profile are saved; only the acknowledgement may remain. */
export function markCommitted(pending: PendingGrantRequest): void {
  pending.committed = true;
}

/** The reference and expiry of a result already discovered, for a collection that should not ask again. */
export function knownResult(pending: PendingGrantRequest): { resultRef: string; expiresAt: string } | undefined {
  return pending.resultRef && pending.resultExpiresAt ? { resultRef: pending.resultRef, expiresAt: pending.resultExpiresAt } : undefined;
}

/** The reference an acknowledgement is sent for; undefined when there is none to acknowledge. */
export function ackRef(pending: PendingGrantRequest): string | undefined {
  return pending.resultRef || undefined;
}

/** The collected, still encrypted result. */
export function resultEnvelopeOf(pending: PendingGrantRequest): unknown {
  return pending.resultEnvelope;
}

/** Whether a failing collection already had its result reference saved (so the failing call was the fetch). */
export function resultSeen(pending: PendingGrantRequest): boolean {
  return pending.resultRef !== undefined;
}
