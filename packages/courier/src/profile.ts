import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { cmd } from './program.js';
import { CourierError } from './errors.js';

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
  /** `revokedAt` is set once the node has confirmed the grant revoked, so a re-run of `revoke` skips it. */
  outbound: { cid: string; issuedAt: string; expiresAt: string; revokedAt?: string }[];
  status: 'pending-A' | 'awaiting-C' | 'paired';
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

export function writeSecure(file: string, obj: unknown): void {
  ensureSecureDir();
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* renamed or absent */ }
  }
}

function readSecure<T>(name: string, required: boolean, home = profileDir()): T | undefined {
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
  } catch (e) {
    throw new CourierError('bad-profile', `Invalid ${name}: ${(e as Error).message}`);
  }
}

export function loadProfile(home = profileDir()): Profile {
  const loaded = readSecure<unknown>('profile.json', true, home)!;
  if (!loaded || typeof loaded !== 'object' || !('version' in loaded)) {
    throw new CourierError('bad-profile', `Corrupt profile at ${profilePath('profile.json')}`);
  }
  if (loaded.version === 2) {
    throw new CourierError('profile-outdated', `This profile stores Courier data in the applications space. Courier now uses your agents space: run \`${cmd('init --rotate-key')}\`, then re-pair peers.`);
  }
  if (loaded.version !== 3) throw new CourierError('bad-profile', `Unsupported profile version ${String(loaded.version)}; run \`${cmd('init --rotate-key')}\`.`);
  const profile = loaded as Profile;
  if (!profile.courierDid || !profile.host || !profile.openkeyHost) throw new CourierError('bad-profile', `Corrupt profile at ${profilePath('profile.json')}`);
  profile.peers ??= {};
  return profile;
}

export function saveProfile(profile: Profile): void {
  writeSecure(profilePath('profile.json'), profile);
}

export function loadKey(home = profileDir()): AgentKey {
  const key = readSecure<AgentKey>('key.json', true, home)!;
  if (key.v !== 1 || !key.jwk || !key.did?.startsWith('did:key:')) {
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
