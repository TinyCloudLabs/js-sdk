import fs from 'node:fs';
import { CourierError } from '../errors.js';
import { isRecord } from '../a2a.js';

export type Tier = 'trusted' | 'strict';

export interface PeerPolicy {
  tier: Tier;
  ratePerHour: number;
  outPerHour: number;
}

export type Peers = Record<string, PeerPolicy>;

/** Default inbound cap per sender per hour, for a peer present without `ratePerHour` and for a peer absent from peers.json. */
export const DEFAULT_IN_PER_HOUR = 100;
/** Default outbound cap per peer per hour, for any peer without an explicit `outPerHour`. */
export const DEFAULT_OUT_PER_HOUR = 100;

const KEYS: Record<string, true> = { tier: true, ratePerHour: true, outPerHour: true };
const TIERS: Record<string, true> = { trusted: true, strict: true };

/** The policy for an absent peer. Invalid entries are read as this too, so a typo never widens trust. */
const ABSENT: PeerPolicy = { tier: 'strict', ratePerHour: DEFAULT_IN_PER_HOUR, outPerHour: DEFAULT_OUT_PER_HOUR };

/** A per-hour override is a whole number from 1 up to the default, so an entry can only lower a cap. */
function cap(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > fallback) return undefined;
  return value as number;
}

function parseEntry(value: unknown): PeerPolicy | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) => !Object.hasOwn(KEYS, key))) return undefined;
  const tier = value.tier ?? 'strict';
  if (typeof tier !== 'string' || !Object.hasOwn(TIERS, tier)) return undefined;
  const ratePerHour = cap(value.ratePerHour, DEFAULT_IN_PER_HOUR);
  const outPerHour = cap(value.outPerHour, DEFAULT_OUT_PER_HOUR);
  if (ratePerHour === undefined || outPerHour === undefined) return undefined;
  return { tier: tier as Tier, ratePerHour, outPerHour };
}

/**
 * Loads peers.json. An absent file means no peer is listed, so every peer is strict with the absent cap. The file is
 * opened without following links, checked, and read through that same descriptor, so the bytes parsed are the bytes
 * checked. Refuses a symlink, a non-regular file, a file owned by another uid, and a file that is group- or
 * other-writable, because the box owner alone decides who is trusted. An invalid entry refuses the whole file: a typo
 * must not widen a peer's caps, so the caller keeps its last good policy.
 */
export function loadPeers(path: string, ownerUid: number | undefined = process.getuid?.()): Peers {
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return Object.create(null) as Peers;
    if (code === 'ELOOP') throw new CourierError('insecure-peers', `${path} is a symbolic link; point the flag at the file itself.`);
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new CourierError('insecure-peers', `${path} is not a regular file.`);
    if (ownerUid !== undefined && stat.uid !== ownerUid) {
      throw new CourierError('insecure-peers', `${path} is not owned by the peers owner (uid ${ownerUid}); pass --peers-owner or chown the file.`);
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new CourierError('insecure-peers', `${path} is writable by group or others; restrict it to the owner (chmod 600).`);
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!isRecord(parsed)) throw new CourierError('bad-peers', `${path} must be a JSON object keyed by peer id.`);
    const peers = Object.create(null) as Peers;
    for (const [peerId, value] of Object.entries(parsed)) {
      const policy = parseEntry(value);
      if (!policy) throw new CourierError('bad-peers', `${path} has an invalid policy for peer "${peerId}"; fix the entry. Nothing was loaded.`);
      peers[peerId] = policy;
    }
    return peers;
  } finally {
    fs.closeSync(fd);
  }
}

/** The tier for a peer. Absent from the file means strict. */
export function tierOf(peers: Peers, peerId: string): Tier {
  return Object.hasOwn(peers, peerId) ? peers[peerId]!.tier : 'strict';
}

/** Full policy for a peer. Absent peers get the strict default with the absent inbound cap. */
export function policyOf(peers: Peers, peerId: string): PeerPolicy {
  return Object.hasOwn(peers, peerId) ? peers[peerId]! : { ...ABSENT };
}

const UID_MAX = 4294967294;
const PASSWD = '/etc/passwd';

function uidOfName(name: string, passwdPath: string): number {
  let text: string;
  try {
    text = fs.readFileSync(passwdPath, 'utf8');
  } catch {
    throw new CourierError('usage', `cannot read ${passwdPath} to resolve "${name}"; pass a numeric uid instead.`);
  }
  const uids = new Set<number>();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#') || line.startsWith('+') || line.startsWith('-')) continue;
    const fields = line.split(':');
    if (fields.length !== 7 || !/^(0|[1-9]\d*)$/.test(fields[2]!) || Number(fields[2]) > UID_MAX) {
      throw new CourierError('usage', `${passwdPath} has a malformed line; fix it or pass a numeric uid.`);
    }
    if (fields[0] === name) uids.add(Number(fields[2]));
  }
  if (uids.size === 0) throw new CourierError('usage', `no account named "${name}"; pass a numeric uid instead.`);
  if (uids.size > 1) throw new CourierError('usage', `"${name}" maps to more than one uid in ${passwdPath}; pass a numeric uid.`);
  return [...uids][0]!;
}

/**
 * Resolves the account that must own peers.json. The value is a numeric uid or a user name from the passwd database,
 * taken from the flag, else the env, else the running user. Anything that does not resolve to exactly one uid is
 * refused, so a typo never selects a different owner.
 */
export function resolvePeersOwner(flag: string | undefined, env: string | undefined, passwdPath: string = PASSWD): number {
  const value = flag ?? env;
  if (value === undefined) {
    const uid = process.getuid?.();
    if (uid === undefined) throw new CourierError('unsupported', 'peers ownership needs a POSIX platform.');
    return uid;
  }
  if (value === 'true') throw new CourierError('usage', '--peers-owner needs a user name or numeric uid.');
  if (/^(0|[1-9]\d*)$/.test(value)) {
    const uid = Number(value);
    if (uid > UID_MAX) throw new CourierError('usage', `peers owner uid ${value} is out of range.`);
    return uid;
  }
  if (!/^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(value)) {
    throw new CourierError('usage', `peers owner "${value}" is neither a user name nor a numeric uid.`);
  }
  return uidOfName(value, passwdPath);
}
