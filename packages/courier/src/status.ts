import type { ParsedArgs } from './args.js';
import { requireFlag } from './args.js';
import { CourierError } from './errors.js';
import { loadOwnerEpisode } from './interim-owner.js';
import { getPeer, loadProfile, type StoredPeer } from './profile.js';
import { cmd } from './program.js';
import { oneLine } from './a2a.js';

export const EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;
export type GrantExpiry = { state: 'missing' | 'unknown' | 'expired' | 'expiring' | 'current'; expiresAt: string | null };

/** Local expiry metadata only: this does not verify authority or remote access. */
export function grantExpiry(expiresAt: string | undefined, now = Date.now()): GrantExpiry {
  if (expiresAt === undefined) return { state: 'missing', expiresAt: null };
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end)) return { state: 'unknown', expiresAt: null };
  return {
    state: end <= now ? 'expired' : end - now <= EXPIRY_WARNING_MS ? 'expiring' : 'current',
    expiresAt: new Date(end).toISOString(),
  };
}

export function peerExpiryStatus(peer: StoredPeer, now = Date.now()) {
  const inbound = grantExpiry(peer.inbound?.expiresAt, now);
  const outbound = grantExpiry([...peer.outbound].reverse().find(entry => !entry.revokedAt && !peer.interim?.cleanup[entry.cid])?.expiresAt, now);
  const live = (g: GrantExpiry) => g.state === 'current' || g.state === 'expiring';
  const stopped = !!peer.interim?.latchedAt || !!peer.interim?.inboundRefusedAt;
  const renewalCommand = !stopped && peer.status === 'paired' && live(inbound) && live(outbound)
    ? cmd(`pair renew ${peer.handle}`) : null;
  const warnings: string[] = [];
  for (const [side, grant] of [['inbound', inbound], ['outbound', outbound]] as const) {
    if (grant.state === 'expiring') warnings.push(`The saved ${side} grant for ${oneLine(peer.handle)} expires within 24 hours (${grant.expiresAt}).`);
    if (grant.state === 'expired') warnings.push(side === 'inbound'
      ? `Your access to ${oneLine(peer.handle)} has expired. A new pairing is required.`
      : `${oneLine(peer.handle)}'s saved access to you has expired; you must approve a new grant.`);
    if (grant.state === 'missing') warnings.push(`No saved ${side} grant for ${oneLine(peer.handle)}.`);
    if (grant.state === 'unknown') warnings.push(`The saved ${side} grant for ${oneLine(peer.handle)} has no expiry on record.`);
  }
  if (stopped) warnings.push(`Sharing with ${oneLine(peer.handle)} was revoked. A new pairing is required.`);
  return {
    peer: peer.handle, pairing: peer.status, inbound, outbound,
    remoteReadability: 'not-checked' as const,
    renewal: { state: stopped ? 'revoked' : peer.interim?.unavailableAt ? 'unavailable' : peer.interim ? 'automatic' : 'unknown', command: renewalCommand },
    warnings,
  };
}

const statusUsage = () => `Usage: ${cmd('status [--peer <peer>] [--json]')}`;

/** Works even after grants lapse: never initializes a node, renews, or sends. */
export function cmdStatus(args: ParsedArgs): void {
  if (args.positional.length || args.all('peer').length > 1) throw new CourierError('usage', statusUsage());
  const requested = args.has('peer') ? requireFlag(args, 'peer', statusUsage()) : undefined;
  if (requested !== undefined && !requested.trim()) throw new CourierError('usage', statusUsage());
  const profile = loadProfile();
  const peers = requested === undefined ? Object.values(profile.peers) : [getPeer(profile, requested)];
  const now = Date.now();
  const episode = loadOwnerEpisode();
  const owner = episode ? { state: episode.phase, expiresAt: episode.expiresAt, requestId: episode.requestId } : { state: 'unknown' };
  const output = { owner, source: 'saved-profile', checkedAt: new Date(now).toISOString(), peers: peers.map(peer => peerExpiryStatus(peer, now)) };
  if (args.has('json')) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (owner.state === 'unavailable') console.log(`Courier couldn't create an approval request. Run \`${cmd('init --request')}\` to try again.`);
  if (owner.state === 'requested') console.log(`Courier needs your approval to keep renewing access. Approve the request in OpenKey, then run \`${cmd('init --wait')}\`.`);
  console.log('To stop sharing with a peer, revoke the pairing. A renewal Courier already published can stay usable until Courier next runs, and never past its own end date (at most 30 days).');
  console.log("Showing saved expiry times only. This doesn't contact peers or check renewals.");
  console.log("Inbound: your access to the peer. Outbound: the peer's access to you (latest saved grant).");
  if (!output.peers.length) console.log('No saved peers.');
  for (const peer of output.peers) {
    console.log(`${oneLine(peer.peer)} (${peer.pairing})`);
    for (const side of ['inbound', 'outbound'] as const) {
      const grant = peer[side];
      console.log(`  ${side}: ${grant.state}${grant.expiresAt ? ` — ${utcTime(grant.expiresAt)}` : ''}`);
    }
    for (const warning of peer.warnings) {
      let text = warning;
      for (const grant of [peer.inbound, peer.outbound]) {
        if (grant.expiresAt) text = text.replaceAll(grant.expiresAt, utcTime(grant.expiresAt));
      }
      console.log(`  Warning: ${text}`);
    }
    if (peer.renewal.command) console.log(`  To renew before it expires, run: ${peer.renewal.command}`);
  }
}

function utcTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
