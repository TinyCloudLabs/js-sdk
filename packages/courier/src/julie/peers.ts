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

/** Inbound cap for a peer that is present without `ratePerHour`. */
export const DEFAULT_IN_PER_HOUR = 20;
/** Inbound cap for a peer absent from peers.json, or whose entry is invalid. */
export const ABSENT_IN_PER_HOUR = 4;
/** Outbound cap for any peer without an explicit `outPerHour`. */
export const DEFAULT_OUT_PER_HOUR = 10;

const KEYS: Record<string, true> = { tier: true, ratePerHour: true, outPerHour: true };
const TIERS: Record<string, true> = { trusted: true, strict: true };

/** The policy for an absent peer. Invalid entries are read as this too, so a typo never widens trust. */
const ABSENT: PeerPolicy = { tier: 'strict', ratePerHour: ABSENT_IN_PER_HOUR, outPerHour: DEFAULT_OUT_PER_HOUR };

/** A per-hour cap is a whole number from 1 to 10000. */
function cap(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10000) return undefined;
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
 * entry is reported through `log` and read as the absent policy. Refuses a file that is group- or other-writable,
 * because the box owner alone decides who is trusted.
 */
export function loadPeers(path: string, log: (event: string, fields: Record<string, unknown>) => void = () => {}): Peers {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!stat.isFile()) throw new CourierError('insecure-peers', `${path} is not a regular file.`);
  if ((stat.mode & 0o022) !== 0) {
    throw new CourierError('insecure-peers', `${path} is writable by group or others; restrict it to the owner (chmod 600).`);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new CourierError('bad-peers', `${path} must be a JSON object keyed by peer id.`);
  const peers: Peers = {};
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
  return peers[peerId]?.tier ?? 'strict';
}

/** Full policy for a peer. Absent peers get the strict default with the absent inbound cap. */
export function policyOf(peers: Peers, peerId: string): PeerPolicy {
  return peers[peerId] ?? { ...ABSENT };
}
