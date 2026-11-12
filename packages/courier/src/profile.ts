import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { cmd } from './program.js';
import { CourierError } from './errors.js';
import { canonicalJson } from './canonical.js';
import { acquireLock, fsyncDir, parseIdentityRecord, processIdentityRecord } from './file-lock.js';
import type { LockRecord } from './file-lock.js';

/** Courier-local identity and peer store; never an OpenKey owner profile. */
export interface AgentKey {
  v: 1;
  jwk: Record<string, unknown>;
  did: string;
  createdAt: string;
}

export interface OwnerGrant {
  v: 1;
  delegationHeader: { Authorization: string };
  delegationCid: string;
  spaceId: string;
  ownerDid: string;
  address: string;
  chainId: number;
  verificationMethod: string;
  siwe: string;
  signature: string;
  expiresAt: string;
  receivedAt: string;
}

export interface StoredPeer {
  handle: string;
  ownerDid: string;
  /** Peer's courier DID — bare delegation audience. */
  courierDid: string;
  label?: string;
  spaceId: string;
  theirHandleForMe?: string;
  inbound?: { delegation: string; cid: string; expiresAt: string };
  outbound: { cid: string; issuedAt: string; expiresAt: string; revokedAt?: string }[];
  status: 'pending-A' | 'awaiting-C' | 'paired';
  /** Guided pairing is restricted to this one thread, never the peer's other chats. */
  sessionId?: string;
  pairedAt: string;
}

export interface Profile {
  version: 3;
  host: string;
  openkeyHost: string;
  label: string;
  selfHandle?: string;
  courierDid: string;
  ownerDid?: string;
  spaceId?: string;
  grantExpiresAt?: string;
  status: 'awaiting-grant' | 'awaiting-space' | 'ready';
  spacePending?: true;
  peers: Record<string, StoredPeer>;
}

/**
 * Courier home: `COURIER_HOME` when set, else `$HOME/.courier`. Refuses an unset or empty `HOME`
 * rather than guessing a home directory.
 */
export function profileDir(): string {
  let dir = process.env.COURIER_HOME;
  if (!dir) {
    const home = process.env.HOME;
    if (!home) throw new CourierError('home-unset', 'HOME is not set. Set HOME or COURIER_HOME to choose where Courier stores its state.');
    dir = path.join(home, '.courier');
  }
  assertTestHome(dir);
  return dir;
}

/** Test fence: with `COURIER_TEST=1`, a home outside `COURIER_TEST_HOME` is refused. Without that variable this does nothing. */
function assertTestHome(dir: string): void {
  if (process.env.COURIER_TEST !== '1') return;
  const root = process.env.COURIER_TEST_HOME ? path.resolve(process.env.COURIER_TEST_HOME) : undefined;
  const resolved = path.resolve(dir);
  if (!root || (resolved !== root && !resolved.startsWith(root + path.sep))) {
    throw new CourierError('test-home-escape', `COURIER_TEST=1: ${resolved} is outside COURIER_TEST_HOME (${root ?? 'unset'}).`);
  }
}

function profilePath(name: string, home = profileDir()): string {
  return path.join(home, name);
}

export function profileExists(): boolean {
  return fs.existsSync(profilePath('profile.json'));
}

export function mkdirOwnerOnly(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask; chmod sets the final bits explicitly.
  fs.chmodSync(dir, 0o700);
}

function ensureSecureDir(): void {
  mkdirOwnerOnly(profileDir());
}

const IDENTITY_TRACKED_TARGET = /^(?:rotation|key|approval-pending)\.json$/;

export const tempIdentityPath = (temp: string): string => `${temp}.identity`;

const isSecureTempIdentity = (stat: fs.Stats): boolean => {
  const uid = process.getuid?.();
  return stat.isFile() && (uid === undefined || stat.uid === uid) && stat.nlink === 1 && (stat.mode & 0o077) === 0;
};

/** Persist the writer record before any key-bearing bytes are written to `temp`. */
export function writeTempIdentity(temp: string, pid: number, nonce: string): void {
  const file = tempIdentityPath(temp);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let open = true;
  try {
    fs.writeFileSync(fd, `${JSON.stringify(processIdentityRecord(pid, nonce))}\n`);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    open = false;
    fsyncDir(path.dirname(temp));
  } catch (error) {
    if (open) { try { fs.closeSync(fd); } catch { /* preserve the write error */ } }
    try { fs.unlinkSync(file); } catch { /* absent or best-effort cleanup */ }
    throw error;
  }
}

/** Read only a plain, owner-only identity sidecar; malformed or unsafe records are unknown. */
export function readTempIdentity(temp: string): LockRecord | undefined {
  const file = tempIdentityPath(temp);
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!isSecureTempIdentity(before)) return undefined;
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!isSecureTempIdentity(opened) || opened.dev !== before.dev || opened.ino !== before.ino) return undefined;
    return parseIdentityRecord(fs.readFileSync(fd, 'utf8'));
  } catch { return undefined; } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* unreadable identity is unknown */ }
    }
  }
}

/** Remove the non-secret record only when its temp file is gone or safely installed. */
export function removeTempIdentity(temp: string): void {
  try { fs.unlinkSync(tempIdentityPath(temp)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Atomic, owner-only and durable: the bytes and the rename are fsynced, so a caller may act on "saved" (for example acknowledge an approval). */
export function writeSecure(file: string, obj: unknown): void {
  ensureSecureDir();
  const pid = process.pid;
  const nonce = randomBytes(6).toString('hex');
  const temp = `${file}.${pid}.${nonce}.tmp`;
  const trackedTemp = path.resolve(path.dirname(file)) === path.resolve(profileDir()) && IDENTITY_TRACKED_TARGET.test(path.basename(file));
  let identityWritten = false;
  let tempCreated = false;
  let renamed = false;
  try {
    if (trackedTemp) {
      writeTempIdentity(temp, pid, nonce);
      identityWritten = true;
    }
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    tempCreated = true;
    try {
      fs.writeFileSync(fd, JSON.stringify(obj, null, 2) + '\n');
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    renamed = true;
    fsyncDir(path.dirname(file));
    if (identityWritten) {
      try {
        removeTempIdentity(temp);
        fsyncDir(path.dirname(file));
      } catch { /* the rename is durable; orphan sidecars are handled conservatively by recovery */ }
      identityWritten = false;
    }
  } finally {
    if (!renamed) {
      let tempRemoved = !tempCreated;
      if (tempCreated) {
        try { fs.unlinkSync(temp); tempRemoved = true; } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') tempRemoved = true;
        }
      }
      if (tempRemoved && identityWritten) {
        try { removeTempIdentity(temp); } catch { /* orphan records are handled conservatively by recovery */ }
      }
    }
  }
}

/**
 * The text of a regular file of this user, or undefined when there is none: a symlink is never followed (O_NOFOLLOW), a FIFO or device
 * never blocks the open (O_NONBLOCK) and is refused by `fstat` before any read. Read-only callers use it; it never changes the file.
 */
export function readRegularFile(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.()) return undefined;
    return fs.readFileSync(fd, 'utf8');
  } catch { return undefined; } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readSecure<T>(name: string, required: boolean, home = profileDir()): T | undefined {
  const file = profilePath(name, home);
  if (!fs.existsSync(file)) {
    if (required) throw new CourierError('no-profile', `Missing ${name} in ${profileDir()}. Run \`${cmd('init')}\` first.`);
    return undefined;
  }
  const dirMode = fs.statSync(home).mode & 0o777;
  if ((dirMode & 0o077) !== 0) {
    throw new CourierError('profile-permissions', `${profileDir()} must be owner-only (mode 0700); found mode ${dirMode.toString(8)}.`);
  }
  const mode = fs.statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new CourierError('profile-permissions', `${name} must be owner-only (mode 0600); found mode ${mode.toString(8)}.`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    // A parser error quotes the text around the failure, and these files can hold private keys: say which file, never what was in it.
    throw new CourierError('bad-profile', `Invalid ${name}: the file is unreadable or corrupt.`);
  }
}

/** The fields `loadProfile` requires of a current (version 3) profile. */
export function hasProfileFields(profile: Partial<Profile> | null): profile is Profile {
  return !!profile && typeof profile === 'object' && profile.version === 3 && !!profile.courierDid && !!profile.host && !!profile.openkeyHost;
}

function readProfile(home: string): Profile {
  const loaded = readSecure<unknown>('profile.json', true, home)!;
  if (!loaded || typeof loaded !== 'object' || !('version' in loaded)) {
    throw new CourierError('bad-profile', `Corrupt profile at ${profilePath('profile.json', home)}`);
  }
  if (loaded.version === 2) {
    throw new CourierError('profile-outdated', `This profile stores Courier data in the applications space. Courier now uses your agents space: run \`${cmd('init --rotate-key')}\`, then re-pair peers.`);
  }
  if (loaded.version !== 3) throw new CourierError('bad-profile', `Unsupported profile version ${String(loaded.version)}; run \`${cmd('init --rotate-key')}\`.`);
  const profile = loaded as Profile;
  if (!hasProfileFields(profile)) throw new CourierError('bad-profile', `Corrupt profile at ${profilePath('profile.json', home)}`);
  profile.peers ??= {};
  return profile;
}

/** A pairing that was started or half-completed and never finished is forgotten after this long (the peer delegation itself lives 7 days). */
export const PENDING_PAIRING_TTL_MS = 7 * 24 * 3600 * 1000;

function expiredPending(peer: StoredPeer, now: number): boolean {
  if (peer.status === 'paired') return false;
  const started = Date.parse(peer.pairedAt);
  return Number.isFinite(started) && now - started > PENDING_PAIRING_TTL_MS;
}

function dropExpiredPending(peers: Record<string, StoredPeer>): void {
  const now = Date.now();
  for (const [handle, peer] of Object.entries(peers)) if (expiredPending(peer, now)) delete peers[handle];
}

/** What each loaded or saved profile looked like on disk, so a later `saveProfile` can tell what THIS command changed. */
const baselines = new WeakMap<Profile, Profile>();

function remember(profile: Profile): void {
  baselines.set(profile, JSON.parse(canonicalJson(profile)) as Profile);
}

/** Expired pending pairings are not returned; they leave the file with the next save. */
export function loadProfile(home = profileDir()): Profile {
  const profile = readProfile(home);
  dropExpiredPending(profile.peers);
  remember(profile);
  return profile;
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** Three-way merge of one peer's fields: what this command changed wins, anything it left alone keeps the current file's value. */
function mergePeer(handle: string, base: StoredPeer | undefined, mine: StoredPeer | undefined, disk: StoredPeer | undefined): StoredPeer | undefined {
  if (same(mine, base)) return disk; // not touched by this command
  if (!mine) return undefined; // revoked here
  if (!disk) {
    if (!base) return mine; // a new peer is added
    throw new CourierError('peer-revoked', `${handle} was revoked while this command was running. Nothing was saved and nothing was published.`);
  }
  if (disk.status === 'paired' && mine.status !== 'paired') {
    throw new CourierError('usage', `Already paired with ${handle}.`);
  }
  if (!base) {
    // Another command added this handle meanwhile: replacing it would drop that command's delegations.
    if (same(mine, disk)) return disk;
    throw new CourierError('profile-changed', `Another command started a pairing with ${handle} while this one ran. Nothing was saved; run the command again.`);
  }
  const merged: Record<string, unknown> = {};
  const m = mine as unknown as Record<string, unknown>;
  const b = base as unknown as Record<string, unknown>;
  const d = disk as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(m), ...Object.keys(b), ...Object.keys(d)])) {
    let value: unknown;
    if (same(m[key], b[key])) value = d[key];
    else if (same(d[key], b[key]) || same(d[key], m[key])) value = m[key];
    else if (key === 'outbound') {
      const byCid = new Map<string, StoredPeer['outbound'][number]>();
      for (const entry of [...(d.outbound as StoredPeer['outbound']), ...(m.outbound as StoredPeer['outbound'])]) byCid.set(entry.cid, entry);
      value = [...byCid.values()].sort((x, y) => Date.parse(x.issuedAt) - Date.parse(y.issuedAt));
    } else if (key === 'inbound') {
      // Two imports raced: the longer-lived delegation stays, never the one that happened to save last.
      value = Date.parse((d.inbound as NonNullable<StoredPeer['inbound']>).expiresAt) > Date.parse((m.inbound as NonNullable<StoredPeer['inbound']>).expiresAt) ? d.inbound : m.inbound;
    } else if (key === 'status') value = d.status === 'paired' ? 'paired' : m.status;
    else value = m[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as StoredPeer;
}

function mergeProfile(base: Profile, mine: Profile, disk: Profile): Profile {
  assertSameAgent(base, disk);
  const merged: Record<string, unknown> = {};
  const m = mine as unknown as Record<string, unknown>;
  const b = base as unknown as Record<string, unknown>;
  const d = disk as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(m), ...Object.keys(b), ...Object.keys(d)])) {
    if (key === 'peers') continue;
    const value = same(m[key], b[key]) ? d[key] : m[key];
    if (value !== undefined) merged[key] = value;
  }
  const peers: Record<string, StoredPeer> = {};
  for (const handle of new Set([...Object.keys(mine.peers), ...Object.keys(base.peers), ...Object.keys(disk.peers)])) {
    const peer = mergePeer(handle, base.peers[handle], mine.peers[handle], disk.peers[handle]);
    if (peer) peers[handle] = peer;
  }
  merged.peers = peers;
  return merged as unknown as Profile;
}

/** Make `target` hold `source`'s values without replacing nested objects the caller still points at (for example a peer it just updated). */
function adopt(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (key === 'peers' && current && typeof current === 'object' && value && typeof value === 'object') adoptPeers(current as Record<string, unknown>, value as Record<string, unknown>);
    else target[key] = value;
  }
}

function adoptPeers(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const handle of Object.keys(target)) if (!(handle in source)) delete target[handle];
  for (const [handle, peer] of Object.entries(source)) {
    const current = target[handle];
    if (current && typeof current === 'object') adopt(current as Record<string, unknown>, peer as Record<string, unknown>);
    else target[handle] = peer;
  }
}

const LOCK_WAIT_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Exclusive, held only while a save reads, merges and writes (milliseconds). The lock is intake's: created whole with a `{pid, nonce}` owner
 * record, released only by its nonce, and broken only when its holder is established dead (a true boot-id change on the same host, or its pid is absent; on Linux the record and this process must name the same pid namespace).
 * A live holder, or one whose liveness cannot be established, is waited for and then refused: age alone never breaks a lock.
 */
function withProfileLock<T>(fn: () => T): T {
  ensureSecureDir();
  const lock = `${profilePath('profile.json')}.lock`;
  const deadline = performance.now() + LOCK_WAIT_MS;
  let release: (() => void) | undefined;
  for (;;) {
    try {
      release = acquireLock(lock);
      break;
    } catch (error) {
      if (!(error instanceof CourierError) || error.code !== 'locked') throw error;
      if (performance.now() >= deadline) throw new CourierError('profile-locked', error.message);
    }
    sleepSync(10);
  }
  try {
    return fn();
  } finally {
    release?.();
  }
}

function assertSameAgent(base: Profile, disk: Profile): void {
  if (disk.courierDid !== base.courierDid) {
    throw new CourierError('profile-changed', 'The agent key changed while this command was running (`init --rotate-key`). Nothing was saved; run the command again.');
  }
}

/**
 * Writes grant.json for a profile loaded earlier, under the profile lock and only while profile.json still holds the agent key that
 * grant is for, so a command that outlived `init --rotate-key` never leaves the old key's grant beside the new profile.
 */
export function saveGrantIfCurrent(profile: Profile, grant: OwnerGrant): void {
  withProfileLock(() => {
    const base = baselines.get(profile);
    if (base && fs.existsSync(profilePath('profile.json'))) assertSameAgent(base, readProfile(profileDir()));
    saveGrant(grant);
  });
}

/** Refuses a pairing start for `handle` when this copy or the file as it is now already has it paired. Reads, does not lock: it only avoids work that save would refuse. */
export function assertNotPaired(profile: Profile, handle: string): void {
  const current = fs.existsSync(profilePath('profile.json')) ? readProfile(profileDir()) : undefined;
  if (profile.peers[handle]?.status === 'paired' || current?.peers[handle]?.status === 'paired') {
    throw new CourierError('usage', `Already paired with ${handle}.`);
  }
}

/**
 * Saves under a lock. A profile that came from `loadProfile` (or an earlier save) is merged with the file as it is NOW: only what
 * this command changed is written, so a pairing, revocation or key rotation made by another command meanwhile is kept. `profile` is
 * updated to the saved result. A profile built from scratch overwrites the file (first init, key rotation).
 */
export function saveProfile(profile: Profile): void {
  withProfileLock(() => saveProfileUnlocked(profile));
}

function saveProfileUnlocked(profile: Profile): void {
  const file = profilePath('profile.json');
  const base = baselines.get(profile);
  let result: Profile = profile;
  if (base && fs.existsSync(file)) {
    const disk = readProfile(profileDir());
    dropExpiredPending(disk.peers); // an expired pairing is not another command's: it must not block starting that handle again
    result = mergeProfile(base, profile, disk);
  }
  dropExpiredPending(result.peers);
  writeSecure(file, result);
  if (result !== profile) adopt(profile as unknown as Record<string, unknown>, result as unknown as Record<string, unknown>);
  else dropExpiredPending(profile.peers);
  remember(profile);
}

/** Serialize peer operations across network awaits; use save(), never saveProfile(), inside. */
export async function withProfileTransaction<T>(fn: (profile: Profile, save: () => void) => Promise<T>): Promise<T> {
  ensureSecureDir();
  const deadline = performance.now() + LOCK_WAIT_MS;
  let release: () => void;
  for (;;) {
    try {
      release = acquireLock(`${profilePath('profile.json')}.lock`);
      break;
    } catch (error) {
      if (!(error instanceof CourierError) || error.code !== 'locked') throw error;
      if (performance.now() >= deadline) throw new CourierError('profile-locked', error.message);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    const profile = loadProfile();
    return await fn(profile, () => saveProfileUnlocked(profile));
  } finally {
    release();
  }
}

/** The shape `loadKey` accepts: version 1, a JWK and a `did:key:` identifier. */
export function isAgentKey(value: unknown): value is AgentKey {
  const key = value as Partial<AgentKey> | null;
  return !!key && typeof key === 'object' && key.v === 1 && !!key.jwk && typeof key.did === 'string' && key.did.startsWith('did:key:');
}

export function loadKey(home = profileDir()): AgentKey {
  const key = readSecure<unknown>('key.json', true, home)!;
  if (!isAgentKey(key)) {
    throw new CourierError('bad-profile', `Corrupt agent key at ${profilePath('key.json')}`);
  }
  return key;
}

export function saveKey(key: AgentKey): void {
  writeSecure(profilePath('key.json'), key);
}

export function loadGrant(home = profileDir()): OwnerGrant | undefined {
  const grant = readSecure<OwnerGrant>('grant.json', false, home);
  if (grant && (grant.v !== 1 || !grant.delegationHeader?.Authorization || !grant.delegationCid || !grant.siwe)) {
    throw new CourierError('bad-profile', `Corrupt owner grant at ${profilePath('grant.json')}`);
  }
  return grant;
}

export function saveGrant(grant: OwnerGrant): void {
  writeSecure(profilePath('grant.json'), grant);
}

export function getPeer(p: Profile, handle: string): StoredPeer {
  const peer = p.peers[handle];
  if (!peer) {
    const known = Object.keys(p.peers);
    throw new CourierError(
      'unknown-peer',
      `Unknown peer "${handle}".${known.length ? ` Known: ${known.join(', ')}.` : ` Run \`${cmd('pair start <peer>')}\` first.`}`,
    );
  }
  return peer;
}
