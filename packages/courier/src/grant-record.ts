import fs from 'node:fs';
import path from 'node:path';
import { isEd25519DidKey } from './did-key.js';
import { secureSubdir, writeSecure } from './profile.js';

/**
 * Private record of an outgoing read grant that MAY exist because an attempt to pair was abandoned (a node call timed out, or a later step failed after the
 * grant was minted). One file per attempt, `invites/<inviteId>.grant-<attempt>.json` (0600), where `attempt` is the consume marker of the approve that ran it.
 * The name does not match an invite record, so the invite listing ignores it. It is never part of the invite record or the public copy, and only the sweep
 * deletes it, once `notAfter` has passed. Nothing here is revoked automatically: the node cannot revoke a delegation yet.
 */
export interface PossibleGrant {
  v: 1;
  inviteId: string;
  handle: string;
  attempt: string;
  peerCourierDid: string;
  peerOwnerDid: string;
  space: string;
  startedAt: string;
  timedOutAt: string;
  /** Latest time the grant can still be valid: timedOutAt + 7 days, or the real expiry once the late answer gives it. */
  notAfter: string;
  /** The grant's cid, or `unknown` until it is known. */
  cid: string;
  late?: 'ok' | 'failed';
  lateAt?: string;
  /** Why the attempt was abandoned: the node did not answer in time (`timeout`), or something else failed after the grant was issued (`error`). */
  cause?: 'timeout' | 'error';
}

export const GRANT_LIFETIME_MS = 7 * 24 * 3600 * 1000;
const FILE = /^([a-z2-7]{26})\.grant-([0-9a-f]{32})\.json$/;
const INVITE_ID = /^[a-z2-7]{26}$/;
const ATTEMPT = /^[0-9a-f]{32}$/;
const CID = /^(unknown|[A-Za-z0-9._:-]{1,200})$/;
const KEYS = ['v', 'inviteId', 'handle', 'attempt', 'peerCourierDid', 'peerOwnerDid', 'space', 'startedAt', 'timedOutAt', 'notAfter', 'cid'] as const;
const OPTIONAL = ['late', 'lateAt', 'cause'] as const;
const OWNER_DID = /^did:pkh:eip155:\d+:0x[0-9a-fA-F]{40}$/;

const dir = () => secureSubdir('invites');
export const grantPath = (inviteId: string, attempt: string): string => {
  if (!INVITE_ID.test(inviteId) || !ATTEMPT.test(attempt)) throw new Error('invalid grant record id');
  return path.join(dir(), `${inviteId}.grant-${attempt}.json`);
};

const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const short = (v: unknown, max = 300): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/** Strict shape check on read: exact keys, bounded strings. Anything else is not a grant record. */
function parseGrant(value: unknown, file: string): PossibleGrant | undefined {
  const m = FILE.exec(path.basename(file));
  if (!m || typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.some((k) => !(KEYS as readonly string[]).includes(k) && !(OPTIONAL as readonly string[]).includes(k))) return undefined;
  if (!KEYS.every((k) => keys.includes(k))) return undefined;
  if (r.v !== 1 || r.inviteId !== m[1] || r.attempt !== m[2]) return undefined;
  if (!short(r.handle, 64) || !isEd25519DidKey(r.peerCourierDid) || typeof r.peerOwnerDid !== 'string' || !OWNER_DID.test(r.peerOwnerDid) || !short(r.space)) return undefined;
  if (r.cause !== undefined && r.cause !== 'timeout' && r.cause !== 'error') return undefined;
  if (!isIso(r.startedAt) || !isIso(r.timedOutAt) || !isIso(r.notAfter)) return undefined;
  if (typeof r.cid !== 'string' || !CID.test(r.cid)) return undefined;
  if (r.late !== undefined && r.late !== 'ok' && r.late !== 'failed') return undefined;
  if (r.lateAt !== undefined && !isIso(r.lateAt)) return undefined;
  return r as unknown as PossibleGrant;
}

function readGrantFile(file: string): PossibleGrant | undefined {
  try {
    return parseGrant(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, file);
  } catch {
    return undefined;
  }
}

/**
 * Writes the record, but only if `parseGrant` (the reader) will accept it: what is written is always listed. A record the reader would hide (for example a
 * courier DID the loose hello check lets through but that is not an ed25519 did:key) is refused with a throw BEFORE anything is written; the caller logs it
 * and carries the possible grant to the owner without the DID (`unrecordedGrantUntil` on the invite record).
 */
export function writeGrant(grant: PossibleGrant): void {
  const file = grantPath(grant.inviteId, grant.attempt);
  if (parseGrant(JSON.parse(JSON.stringify(grant)) as unknown, file) === undefined) throw new Error('the grant record would not be readable: refused');
  writeSecure(file, grant);
}

/**
 * A late answer for an attempt that was already recorded: updates THAT file only, and only if it exists and is this attempt's.
 * It takes no lock and needs none, because nothing else writes this file.
 */
export function updateGrantLate(inviteId: string, attempt: string, patch: { cid?: string; notAfter?: string; late?: 'ok' | 'failed'; lateAt?: string }): void {
  const file = grantPath(inviteId, attempt);
  const current = readGrantFile(file);
  if (!current || current.inviteId !== inviteId || current.attempt !== attempt) return;
  const next: PossibleGrant = { ...current };
  if (patch.late !== undefined) next.late = patch.late;
  if (patch.lateAt !== undefined) next.lateAt = patch.lateAt;
  if (patch.cid !== undefined) next.cid = patch.cid;
  if (patch.notAfter !== undefined) next.notAfter = patch.notAfter;
  // The same rule as writeGrant: an update the reader would hide (a cid or time the node sent in an odd shape) is not written; the record as it was stays listed.
  if (parseGrant(JSON.parse(JSON.stringify(next)) as unknown, file) === undefined) return;
  writeSecure(file, next);
}

export function listGrants(inviteId?: string): PossibleGrant[] {
  return fs.readdirSync(dir()).filter((n) => FILE.test(n) && (inviteId === undefined || n.startsWith(`${inviteId}.`))).flatMap((n) => {
    const grant = readGrantFile(path.join(dir(), n));
    return grant ? [grant] : [];
  }).sort((a, b) => (Date.parse(a.timedOutAt) - Date.parse(b.timedOutAt)) || (a.attempt < b.attempt ? -1 : 1));
}

/** The grant to name when there are several: this attempt's own, else the newest by `timedOutAt` (then attempt), so the choice never depends on directory order. */
export function newestGrant(grants: readonly PossibleGrant[], attempt?: string): PossibleGrant | undefined {
  return grants.find((g) => attempt !== undefined && g.attempt === attempt)
    ?? [...grants].sort((a, b) => (Date.parse(a.timedOutAt) - Date.parse(b.timedOutAt)) || (a.attempt < b.attempt ? -1 : 1)).at(-1);
}

/** The grants of an invite that can still be valid at `nowMs`. */
export const possibleGrants = (inviteId: string, nowMs: number): PossibleGrant[] => listGrants(inviteId).filter((g) => Date.parse(g.notAfter) > nowMs);

/** Deletes the grant records whose `notAfter` has passed (also the ones that no longer parse and are older than the grant lifetime). Returns how many. */
export function removeExpiredGrants(nowMs: number): number {
  let removed = 0;
  for (const name of fs.readdirSync(dir()).filter((n) => FILE.test(n))) {
    const file = path.join(dir(), name);
    const grant = readGrantFile(file);
    const expired = grant ? Date.parse(grant.notAfter) <= nowMs : nowMs - fs.statSync(file).mtimeMs > 2 * GRANT_LIFETIME_MS;
    if (expired) {
      fs.rmSync(file, { force: true });
      removed += 1;
    }
  }
  return removed;
}

/** The owner-facing sentence for one grant. */
export const grantNote = (g: PossibleGrant): string => `read grant ${g.cid} to ${g.peerCourierDid} until ${g.notAfter}`;
