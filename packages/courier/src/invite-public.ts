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

/**
 * Why an invite is held, as the gate may show it. A small closed set: the verifier's reason codes plus the watcher's own. Never free text.
 * `publicHeldReason` maps anything else to `internal-error`.
 */
export const HELD_REASONS = [
  'no-credential', 'no-possession', 'bad-format', 'issuer-not-pinned', 'descriptor-mismatch', 'from-the-future', 'expired', 'too-old',
  'address-mismatch', 'bad-signature', 'holder-mismatch', 'bad-possession', 'replayed',
  'owner-mismatch', 'peers-entry-exists', 'peers-unreadable', 'also-ask', 'internal-error', 'node-timeout',
] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

export function publicHeldReason(reason: string): HeldReason {
  return (HELD_REASONS as readonly string[]).includes(reason) ? (reason as HeldReason) : 'internal-error';
}

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
  /** Present only while the invite is held, and only together with `helloOwner`: why it is held. */
  heldReason?: HeldReason;
  /** Present only while the invite is held: the owner DID (bare) of the hello that actually arrived. May differ from `expectOwner`. */
  helloOwner?: string;
}

const FIELDS = ['v', 'inviteId', 'handle', 'expectEmail', 'expectOwner', 'tier', 'createdAt', 'expiresAt', 'status', 'completedPeer'] as const;
const HELD_FIELDS = ['heldReason', 'helloOwner'] as const;
const PATCHABLE = ['status', 'completedPeer', ...HELD_FIELDS] as const;
const PEER_FIELDS = ['handle', 'courierDid', 'ownerDid'] as const;
const INVITE_ID = /^[a-z2-7]{26}$/;
const OWNER_DID = /^did:pkh:eip155:\d+:0x[a-fA-F0-9]{40}$/;
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
  const extra = given.filter((k) => !(FIELDS as readonly string[]).includes(k) && !(HELD_FIELDS as readonly string[]).includes(k));
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
  const heldGiven = HELD_FIELDS.filter((k) => given.includes(k));
  if (heldGiven.length > 0) {
    if (heldGiven.length !== HELD_FIELDS.length) invalid('heldReason and helloOwner must be given together');
    if (r.status !== 'held') invalid('heldReason and helloOwner belong to a held invite only');
    if (!(HELD_REASONS as readonly unknown[]).includes(r.heldReason)) invalid(`heldReason must be one of ${HELD_REASONS.join(', ')}`);
    if (typeof r.helloOwner !== 'string' || !OWNER_DID.test(r.helloOwner)) invalid('helloOwner must be a did:pkh:eip155 DID');
  }

  const out: Record<string, unknown> = {};
  for (const k of FIELDS) out[k] = r[k];
  if (heldGiven.length > 0) for (const k of HELD_FIELDS) out[k] = r[k];
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
export function updatePublicInvite(dir: string, inviteId: string, patch: { [K in (typeof PATCHABLE)[number]]?: PublicInvite[K] | undefined }): void {
  const extra = Object.keys(patch).filter((k) => !(PATCHABLE as readonly string[]).includes(k));
  if (extra.length > 0) invalid(`patch may set only status and completedPeer or the held facts (got ${extra.join(', ')})`);
  const file = publicFile(dir, inviteId);
  plainDir(dir);
  plainFileOrAbsent(file);
  if (!fs.existsSync(file)) refused(`no public record for invite ${inviteId} in ${dir}`);
  const current = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  // A held field patched to undefined is removed.
  const merged: Record<string, unknown> = { ...(current as PublicInvite), ...patch };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  writePublicInvite(dir, merged as unknown as PublicInvite);
}

/** Reads `status`, `completedPeer` and the held facts from an existing public record. Undefined when the file is absent. */
export function readPublicStatus(dir: string, inviteId: string): Pick<PublicInvite, 'status' | 'completedPeer' | 'heldReason' | 'helloOwner'> | undefined {
  const file = publicFile(dir, inviteId);
  plainFileOrAbsent(file);
  if (!fs.existsSync(file)) return undefined;
  const clean = checkRecord(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown as PublicInvite);
  return { status: clean.status, completedPeer: clean.completedPeer, heldReason: clean.heldReason, helloOwner: clean.helloOwner };
}
