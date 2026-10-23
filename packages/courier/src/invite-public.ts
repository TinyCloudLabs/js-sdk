import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CourierError } from './errors.js';

/**
 * Non-secret public copy of an owner-side invite record, read by the gate.
 * Only the fields below are written. Keys, delete tokens and blob ids never belong here.
 */
export const PUBLIC_INVITE_STATUSES = ['open', 'consumed', 'held', 'completed', 'failed', 'denied', 'revoked', 'expired'] as const;
export type PublicInviteStatus = (typeof PUBLIC_INVITE_STATUSES)[number];

export interface PublicInvite {
  v: 1;
  inviteId: string;
  handle: string;
  expectEmail: string;
  expectOwner: string | null;
  /** Requested tier. The peer starts strict until the owner confirms trusted by hand. */
  tier: string;
  createdAt: string;
  expiresAt: string;
  status: PublicInviteStatus;
  completedPeer: null | { handle: string; courierDid: string; ownerDid: string };
}

const FIELDS = ['v', 'inviteId', 'handle', 'expectEmail', 'expectOwner', 'tier', 'createdAt', 'expiresAt', 'status', 'completedPeer'] as const;
const PATCHABLE = ['status', 'completedPeer'] as const;
const PEER_FIELDS = ['handle', 'courierDid', 'ownerDid'] as const;
const INVITE_ID = /^[a-z2-7]{26}$/;
const FILE_MODE = 0o640;
const DIR_MODE = 0o750;

function invalid(message: string): never {
  throw new CourierError('internal', `Public invite record: ${message}.`);
}

function refused(message: string): never {
  throw new CourierError('public-invite-refused', message);
}

/** Validates the exact field set and value shapes, and returns a copy in canonical field order. */
function checkRecord(record: unknown): PublicInvite {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) invalid('record must be an object');
  const given = Object.keys(record);
  const extra = given.filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra.length > 0) invalid(`unexpected fields ${extra.join(', ')}`);
  const missing = FIELDS.filter((k) => !given.includes(k));
  if (missing.length > 0) invalid(`missing fields ${missing.join(', ')}`);

  const r = record as Record<string, unknown>;
  if (r.v !== 1) invalid('v must be 1');
  if (typeof r.inviteId !== 'string' || !INVITE_ID.test(r.inviteId)) invalid('inviteId must be 26 characters from a-z and 2-7');
  for (const k of ['handle', 'expectEmail', 'tier', 'createdAt', 'expiresAt'] as const) {
    if (typeof r[k] !== 'string') invalid(`${k} must be a string`);
  }
  if (r.expectOwner !== null && typeof r.expectOwner !== 'string') invalid('expectOwner must be a string or null');
  if (!(PUBLIC_INVITE_STATUSES as readonly unknown[]).includes(r.status)) invalid(`status must be one of ${PUBLIC_INVITE_STATUSES.join(', ')}`);
  if (r.completedPeer !== null) {
    const peer = r.completedPeer as Record<string, unknown> | undefined;
    if (typeof peer !== 'object' || peer === null || Array.isArray(peer)) invalid('completedPeer must be null or an object');
    const peerKeys = Object.keys(peer);
    if (peerKeys.length !== PEER_FIELDS.length || !PEER_FIELDS.every((k) => typeof peer[k] === 'string')) {
      invalid(`completedPeer must have exactly ${PEER_FIELDS.join(', ')} as strings`);
    }
  }

  const out: Record<string, unknown> = {};
  for (const k of FIELDS) out[k] = r[k];
  return out as unknown as PublicInvite;
}

/** Creates the directory if absent; refuses it if it is a symlink or not a directory. */
function plainDir(dir: string): void {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (st === undefined) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    st = fs.lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) refused(`${dir} must be a plain directory, not a symlink or file`);
}

/** Refuses an existing entry at `file` unless it is a regular file. A missing entry is fine. */
function plainFileOrAbsent(file: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (st.isSymbolicLink() || !st.isFile()) refused(`${file} must be a regular file, not a symlink`);
}

function publicFile(dir: string, inviteId: string): string {
  if (!INVITE_ID.test(inviteId)) invalid('inviteId must be 26 characters from a-z and 2-7');
  return path.join(dir, `${inviteId}.json`);
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Temp file in the same directory, exclusive create, fsync, rename over the target, then fsync the directory. */
function writeAtomic(dir: string, file: string, text: string): void {
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', FILE_MODE);
    fs.fchmodSync(fd, FILE_MODE);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fsyncDir(dir);
}

/** The public directory: flag wins over env; an empty or unset value means no public copy. */
export function publicInvitesDir(flag: string | undefined, env: string | undefined): string | undefined {
  if (flag === 'true' || flag === '') throw new CourierError('usage', '--invites-public-dir needs a path.');
  const dir = flag ?? (env === '' ? undefined : env);
  return dir;
}

/** Writes `<dir>/<inviteId>.json` with mode 0640, atomically. Refuses symlinks and invalid records. */
export function writePublicInvite(dir: string, record: PublicInvite): void {
  const clean = checkRecord(record);
  const file = publicFile(dir, clean.inviteId);
  plainDir(dir);
  plainFileOrAbsent(file);
  writeAtomic(dir, file, `${JSON.stringify(clean, null, 2)}\n`);
}

/** Changes only `status` and/or `completedPeer` on an existing public record, atomically. */
export function updatePublicInvite(dir: string, inviteId: string, patch: Partial<Pick<PublicInvite, 'status' | 'completedPeer'>>): void {
  const extra = Object.keys(patch).filter((k) => !(PATCHABLE as readonly string[]).includes(k));
  if (extra.length > 0) invalid(`patch may set only status and completedPeer (got ${extra.join(', ')})`);
  const file = publicFile(dir, inviteId);
  plainDir(dir);
  plainFileOrAbsent(file);
  if (!fs.existsSync(file)) refused(`no public record for invite ${inviteId} in ${dir}`);
  const current = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  writePublicInvite(dir, { ...(current as PublicInvite), ...patch });
}

/** Reads `status` and `completedPeer` from an existing public record. Undefined when the file is absent. */
export function readPublicStatus(dir: string, inviteId: string): Pick<PublicInvite, 'status' | 'completedPeer'> | undefined {
  const file = publicFile(dir, inviteId);
  plainFileOrAbsent(file);
  if (!fs.existsSync(file)) return undefined;
  const clean = checkRecord(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown as PublicInvite);
  return { status: clean.status, completedPeer: clean.completedPeer };
}
