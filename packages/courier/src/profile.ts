import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { cmd } from './program.js';
import { CourierError } from './errors.js';
import { canonicalJson } from './canonical.js';

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
  outbound: { cid: string; issuedAt: string; expiresAt: string }[];
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

/** Atomic, owner-only and durable: the bytes and the rename are fsynced, so a caller may act on "saved" (for example acknowledge an approval). */
export function writeSecure(file: string, obj: unknown): void {
  ensureSecureDir();
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temp, 0o600);
    const fd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    try { fs.unlinkSync(temp); } catch { /* renamed or absent */ }
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
  if (!disk) return base ? undefined : mine; // revoked elsewhere stays revoked; a new peer is added
  if (disk.status === 'paired' && mine.status !== 'paired') {
    throw new CourierError('usage', `Already paired with ${handle}.`);
  }
  if (!base) return mine;
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
  if (disk.courierDid !== base.courierDid) {
    throw new CourierError('profile-changed', 'The agent key changed while this command was running (`init --rotate-key`). Nothing was saved; run the command again.');
  }
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
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function holderGone(lock: string): boolean {
  try {
    const { pid } = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid?: unknown };
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    }
  } catch { /* unreadable or half-written: judged by age below */ }
  try { return Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { return false; }
}

/** Exclusive, held only while a save reads, merges and writes (milliseconds). A lock whose process is gone, or that is older than 30 s, is broken. */
function withProfileLock<T>(fn: () => T): T {
  ensureSecureDir();
  const lock = `${profilePath('profile.json')}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); } finally { fs.closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (holderGone(lock)) {
      const broken = `${lock}.${process.pid}.${randomBytes(6).toString('hex')}.stale`;
      try { fs.renameSync(lock, broken); fs.unlinkSync(broken); } catch { /* another process broke it first */ }
      continue;
    }
    if (Date.now() >= deadline) throw new CourierError('profile-locked', `${lock} is held by another Courier command. Try again; if no Courier command is running, remove that file.`);
    sleepSync(10);
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lock); } catch { /* already gone */ }
  }
}

/**
 * Saves under a lock. A profile that came from `loadProfile` (or an earlier save) is merged with the file as it is NOW: only what
 * this command changed is written, so a pairing, revocation or key rotation made by another command meanwhile is kept. `profile` is
 * updated to the saved result. A profile built from scratch overwrites the file (first init, key rotation).
 */
export function saveProfile(profile: Profile): void {
  const file = profilePath('profile.json');
  withProfileLock(() => {
    const base = baselines.get(profile);
    let result: Profile = profile;
    if (base && fs.existsSync(file)) result = mergeProfile(base, profile, readProfile(profileDir()));
    dropExpiredPending(result.peers);
    writeSecure(file, result);
    if (result !== profile) adopt(profile as unknown as Record<string, unknown>, result as unknown as Record<string, unknown>);
    else dropExpiredPending(profile.peers);
    remember(profile);
  });
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
