import { courierNode } from './node.js';
import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { RenewalAuthorityInactiveError, RenewalLeaseExpiredError } from '@tinycloud/sdk-core/delegations/renewal';
import fs from 'node:fs';
import path from 'node:path';
import { loadGrant, loadKey, loadProfile, profileDir, saveProfile, withProfileLock, writeSecure } from './profile.js';
import type { PendingGrantRequest } from './approval-phase.js';
import type { GrantPayload } from './grant.js';
import type { AgentKey, Profile } from './profile.js';
import { holdsApproval, readApprovalEntry } from './approval-phase.js';
import { approvalIntent, matchesApprovalIntent, requestApprovalInTransaction } from './grant-request.js';
import { requestHash } from './canonical.js';
import { siweTimes } from './authority.js';
import { CourierError } from './errors.js';
import { cmd } from './program.js';
import type { InterimPeer } from './interim-renewal.js';
import { clearLocalCaches } from './thread.js';

export const OWNER_ASK_AHEAD_MS = 8 * 86_400_000;
export interface OwnerEpisode {
  ownerGrantCid: string;
  expiresAt: string;
  courierDid: string;
  intentHash: string;
  requestId: string | null;
  requestHash: string | null;
  phase: 'creating' | 'requested' | 'unavailable' | 'complete' | 'refused';
}
export type OwnerPreflight = {
  state: 'live' | 'approval-required' | 'approval-unavailable' | 'revoked' | 'authority-inactive';
  approvalUrl?: string;
  notify?: boolean;
  requestDue?: boolean;
  node?: TinyCloudNode;
};
const episodeFile = () => path.join(profileDir(), 'renewal-owner.json');

/** Read our own owner-only episode without following a link or accepting permissive modes. */
export function loadOwnerEpisode(): OwnerEpisode | undefined {
  let fd: number;
  try { fd = fs.openSync(episodeFile(), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 32_768 || (stat.mode & 0o077) !== 0 || (fs.statSync(profileDir()).mode & 0o077) !== 0) {
      throw new CourierError('profile-permissions', 'The Courier renewal episode must be an owner-only regular file.');
    }
    let value: OwnerEpisode;
    try { value = JSON.parse(fs.readFileSync(fd, 'utf8')); }
    catch { throw new CourierError('bad-profile', 'The Courier renewal episode is unreadable.'); }
    if (!value || typeof value.ownerGrantCid !== 'string' || typeof value.expiresAt !== 'string' || typeof value.courierDid !== 'string'
      || typeof value.intentHash !== 'string' || !(value.requestId === null || typeof value.requestId === 'string')
      || !(value.requestHash === null || typeof value.requestHash === 'string')
      || !['creating', 'requested', 'unavailable', 'complete', 'refused'].includes(value.phase)) {
      throw new CourierError('bad-profile', 'The Courier renewal episode is unreadable.');
    }
    return value;
  } finally { fs.closeSync(fd); }
}

function pendingForEpisode(episode: OwnerEpisode, profile: Profile, renew: string | undefined): string | undefined {
  const entry = readApprovalEntry();
  if (entry.kind !== 'ok' || !matchesApprovalIntent(entry.pending, profile, loadKey(), renew)) return undefined;
  return episode.requestId === entry.pending.requestId && episode.requestHash === requestHash(entry.pending.request)
    ? entry.pending.approvalUrl : undefined;
}

/** No node, KV, approval discovery, or grant activation is involved in terminal startup states. */
export async function preflightOwner(options: { request?: boolean; watchSession?: boolean } = {}): Promise<OwnerPreflight> {
  const local = withProfileLock<OwnerPreflight | { renewalProfile: Profile } | { requestProfile: Profile; key: AgentKey; episode: OwnerEpisode; renew: string | undefined }>(() => {
    const profile = loadProfile();
    const grant = loadGrant();
    const old = loadOwnerEpisode();
    if (!grant) return { state: 'approval-required' };
    // An owner who answered the last lease ask with a finite grant is not asked for a lease again by this automatic request.
    const renew = grant.renewalChoice === 'finite' ? 'off' : undefined;
    const end = siweTimes(grant.siwe).expiresAt?.getTime();
    const savedEnd = Date.parse(grant.expiresAt);
    const revoked = Object.values(profile.peers).some(peer => (peer as InterimPeer).interim?.ownerRevokedCid === grant.delegationCid);
    if (revoked || (old?.ownerGrantCid === grant.delegationCid && old.phase === 'refused')) return { state: 'revoked' };
    const identity = { ownerGrantCid: grant.delegationCid, expiresAt: grant.expiresAt, courierDid: profile.courierDid };
    const same = old && old.ownerGrantCid === identity.ownerGrantCid && old.expiresAt === identity.expiresAt && old.courierDid === identity.courierDid;
    if (old && !same && old.phase !== 'complete') writeSecure(episodeFile(), { ...old, phase: 'complete' });
    if (grant.renewal) {
      if (Date.parse(grant.renewal.receipt.leaseExpiresAt) <= Date.now()) return { state: 'approval-required' };
      return { renewalProfile: profile };
    }
    // Lapsed startup never makes a network request, including on supervisor restart.
    if (!end || !Number.isFinite(savedEnd) || Math.min(end, savedEnd) <= Date.now()) {
      return { state: 'approval-required', ...(same && old ? { approvalUrl: pendingForEpisode(old, profile, renew) } : {}) };
    }
    if (options.request !== true) return { state: 'live', requestDue: end - Date.now() <= OWNER_ASK_AHEAD_MS && !same };
    if (end - Date.now() > OWNER_ASK_AHEAD_MS) return { state: 'live' };
    const key = loadKey();
    const intentHash = requestHash(approvalIntent(profile, key, renew));
    // An episode whose request asked for no lease, made by a Courier that did not ask for one, is asked again once with this
    // run's ask: a request without a lease never answers an ask for one, and its link is not shown again.
    let reask = false;
    if (same && old) {
      if (old.intentHash !== intentHash) {
        if (old.intentHash !== requestHash(approvalIntent(profile, key, 'off'))) return { state: 'approval-unavailable' };
        reask = true;
      } else {
        const approvalUrl = pendingForEpisode(old, profile, renew);
        return approvalUrl ? { state: 'live', approvalUrl } : { state: 'approval-unavailable' };
      }
    }
    const entry = readApprovalEntry();
    // On a re-ask the old episode's own request is replaced, unless it already holds the owner's approval.
    const replaced = reask && entry.kind === 'ok' && entry.pending.requestId === old?.requestId && !holdsApproval(entry.pending);
    if (entry.kind !== 'none' && !replaced) {
      // An existing request is reused only after binding its exact full request; held results are never replaced.
      if (entry.kind !== 'ok' || !matchesApprovalIntent(entry.pending, profile, key, renew) || old?.requestId === entry.pending.requestId) {
        return { state: 'approval-unavailable' };
      }
      const episode: OwnerEpisode = { ...identity, intentHash, requestId: entry.pending.requestId, requestHash: requestHash(entry.pending.request), phase: 'requested' };
      profile.version = 4; saveProfile(profile); writeSecure(episodeFile(), episode);
      return { state: 'live', approvalUrl: entry.pending.approvalUrl, notify: true };
    }
    const episode: OwnerEpisode = { ...identity, intentHash, requestId: null, requestHash: null, phase: 'creating' };
    profile.version = 4; saveProfile(profile); writeSecure(episodeFile(), episode);
    return { requestProfile: profile, key, episode, renew };
  });
  if ('renewalProfile' in local) {
    try {
      const node = await courierNode(local.renewalProfile);
      return options.watchSession ? { state: 'live', node } : { state: 'live' };
    } catch (error) {
      if (options.watchSession) {
        if (error instanceof RenewalAuthorityInactiveError) return { state: 'authority-inactive' };
        if (error instanceof RenewalLeaseExpiredError) return { state: 'approval-required' };
      }
      return { state: 'approval-unavailable' };
    }
  }
  if (!('requestProfile' in local)) return local;
  const { requestProfile: profile, key, episode, renew } = local;
  const expected = requestHash(episode);
  const commit = (next: OwnerEpisode): void => withProfileLock(() => {
    const current = loadOwnerEpisode();
    if (!current || requestHash(current) !== expected || loadGrant()?.delegationCid !== episode.ownerGrantCid
      || loadProfile().courierDid !== episode.courierDid) {
      throw new CourierError('profile-changed', 'Courier approval state changed while requesting approval. It was kept; run the command again.');
    }
    writeSecure(episodeFile(), next);
  });
  let pending: PendingGrantRequest;
  try {
    pending = await requestApprovalInTransaction(profile, key, undefined, { renew });
  } catch (error) {
    commit({ ...episode, phase: 'unavailable' });
    if (error instanceof CourierError && ['profile-locked', 'profile-changed', 'approval-changed'].includes(error.code)) throw error;
    return { state: 'approval-unavailable', notify: true };
  }
  commit({ ...episode, requestId: pending.requestId, requestHash: requestHash(pending.request), phase: 'requested' });
  return { state: 'live', approvalUrl: pending.approvalUrl, notify: true };
}

/** A terminal owner-authority refusal never triggers an automatic approval retry. */
export async function markOwnerRefused(): Promise<void> {
  clearLocalCaches();
  withProfileLock(() => {
    const profile = loadProfile();
    const grant = loadGrant();
    if (!grant) return;
    const old = loadOwnerEpisode();
    profile.version = 4; saveProfile(profile);
    writeSecure(episodeFile(), { ownerGrantCid: grant.delegationCid, expiresAt: grant.expiresAt, courierDid: profile.courierDid,
      intentHash: old?.intentHash ?? '', requestId: old?.requestId ?? null, requestHash: old?.requestHash ?? null, phase: 'refused' } satisfies OwnerEpisode);
  });
}

/** A held approval for an older episode cannot replace a later installed owner grant. */
export function assertEpisodeGrant(pending: PendingGrantRequest, payload: GrantPayload): void {
  const episode = loadOwnerEpisode();
  if (!episode || episode.requestId !== pending.requestId) return;
  const current = loadGrant();
  if (!current) return;
  if (episode.courierDid !== loadProfile().courierDid || episode.requestHash !== requestHash(pending.request)) {
    throw new CourierError('stale-approval', `This approval is out of date. To fix it, run \`${cmd('init --rotate-key --request')}\`. This makes a new Courier key, removes all your pairings and deletes the saved approval on this device. Approve the new request, then pair with your peers again. The old approval stays valid until it expires or you revoke it. Your peers keep their current access until it expires. To end it sooner, run \`${cmd('revoke <peer>')}\` before you rotate.`);
  }
  if (current.delegationCid !== episode.ownerGrantCid) {
    const nextEnd = siweTimes(payload.siwe).expiresAt?.getTime();
    const currentEnd = siweTimes(current.siwe).expiresAt?.getTime();
    const savedEnd = Date.parse(current.expiresAt);
    if (!nextEnd || !currentEnd || !Number.isFinite(savedEnd) || nextEnd <= Math.max(currentEnd, savedEnd)) {
      throw new CourierError('stale-approval', `This approval is out of date. To fix it, run \`${cmd('init --rotate-key --request')}\`. This makes a new Courier key, removes all your pairings and deletes the saved approval on this device. Approve the new request, then pair with your peers again. The old approval stays valid until it expires or you revoke it. Your peers keep their current access until it expires. To end it sooner, run \`${cmd('revoke <peer>')}\` before you rotate.`);
    }
  }
}
