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
 * Loads peers.json. An absent file means no peer is listed, so every peer is strict with the absent cap. An invalid
 * entry is reported through `log` and read as the absent policy. Refuses a symlink, a file owned by another uid, and a
 * file that is group- or other-writable, because the box owner alone decides who is trusted.
 */
export function loadPeers(path: string, log: (event: string, fields: Record<string, unknown>) => void = () => {}, ownerUid: number | undefined = process.getuid?.()): Peers {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null) as Peers;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new CourierError('insecure-peers', `${path} is a symbolic link; point the flag at the file itself.`);
  if (!stat.isFile()) throw new CourierError('insecure-peers', `${path} is not a regular file.`);
  if (ownerUid !== undefined && stat.uid !== ownerUid) throw new CourierError('insecure-peers', `${path} is not owned by the courier user.`);
  if ((stat.mode & 0o022) !== 0) {
    throw new CourierError('insecure-peers', `${path} is writable by group or others; restrict it to the owner (chmod 600).`);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new CourierError('bad-peers', `${path} must be a JSON object keyed by peer id.`);
  const peers = Object.create(null) as Peers;
  for (const [peerId, value] of Object.entries(parsed)) {
    const policy = parseEntry(value);
    if (policy) peers[peerId] = policy;
    else {
      log('peers-invalid-entry', { peer: peerId, reason: 'invalid-entry', as: 'strict' });
      peers[peerId] = { ...ABSENT };
    }
  }
  return peers;
}

/** The tier for a peer. Absent from the file means strict. */
export function tierOf(peers: Peers, peerId: string): Tier {
  return Object.hasOwn(peers, peerId) ? peers[peerId]!.tier : 'strict';
}

/** Full policy for a peer. Absent peers get the strict default with the absent inbound cap. */
export function policyOf(peers: Peers, peerId: string): PeerPolicy {
  return Object.hasOwn(peers, peerId) ? peers[peerId]! : { ...ABSENT };
}
