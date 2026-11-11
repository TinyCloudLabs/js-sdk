import fs from 'node:fs';
import path from 'node:path';
import { loadGrant, loadKey, loadProfile, profileDir, withProfileTransaction, writeSecure } from './profile.js';
import type { PendingGrantRequest } from './approval-phase.js';
import type { GrantPayload } from './grant.js';
import type { Profile } from './profile.js';
import { readApprovalEntry } from './approval-phase.js';
import { approvalIntent, matchesApprovalIntent, requestApprovalInTransaction } from './grant-request.js';
import { requestHash } from './canonical.js';
import { siweTimes } from './authority.js';
import { CourierError } from './errors.js';
import { cmd } from './program.js';
import type { InterimPeer } from './interim-renewal.js';

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
export type OwnerPreflight = { state: 'live' | 'approval-required' | 'approval-unavailable' | 'revoked'; approvalUrl?: string; notify?: boolean };
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

function pendingForEpisode(episode: OwnerEpisode, profile: Profile): string | undefined {
  const entry = readApprovalEntry();
  if (entry.kind !== 'ok' || !matchesApprovalIntent(entry.pending, profile, loadKey())) return undefined;
  return episode.requestId === entry.pending.requestId && episode.requestHash === requestHash(entry.pending.request)
    ? entry.pending.approvalUrl : undefined;
}

/** No node, KV, approval discovery, or grant activation is involved in terminal startup states. */
export async function preflightOwner(options: { request?: boolean } = {}): Promise<OwnerPreflight> {
  return withProfileTransaction(async (profile, save) => {
    const grant = loadGrant();
    const old = loadOwnerEpisode();
    if (!grant) return { state: 'approval-required' };
    const end = siweTimes(grant.siwe).expiresAt?.getTime();
    const savedEnd = Date.parse(grant.expiresAt);
    const revoked = Object.values(profile.peers).some(peer => (peer as InterimPeer).interim?.ownerRevokedCid === grant.delegationCid);
    if (revoked || (old?.ownerGrantCid === grant.delegationCid && old.phase === 'refused')) return { state: 'revoked' };
    const identity = { ownerGrantCid: grant.delegationCid, expiresAt: grant.expiresAt, courierDid: profile.courierDid };
    const same = old && old.ownerGrantCid === identity.ownerGrantCid && old.expiresAt === identity.expiresAt && old.courierDid === identity.courierDid;
    if (old && !same && old.phase !== 'complete') writeSecure(episodeFile(), { ...old, phase: 'complete' });
    // Lapsed startup never makes a network request, including on supervisor restart.
    if (!end || !Number.isFinite(savedEnd) || Math.min(end, savedEnd) <= Date.now()) {
      return { state: 'approval-required', ...(same && old ? { approvalUrl: pendingForEpisode(old, profile) } : {}) };
    }
    if (options.request === false) return { state: 'live' };
    if (end - Date.now() > OWNER_ASK_AHEAD_MS) return { state: 'live' };
    const key = loadKey();
    const intentHash = requestHash(approvalIntent(profile, key));
    if (same && old) {
      if (old.intentHash !== intentHash) return { state: 'approval-unavailable' };
      const approvalUrl = pendingForEpisode(old, profile);
      return approvalUrl ? { state: 'live', approvalUrl } : { state: 'approval-unavailable' };
    }
    const entry = readApprovalEntry();
    if (entry.kind !== 'none') {
      // An existing request is reused only after binding its exact full request; held results are never replaced.
      if (entry.kind !== 'ok' || !matchesApprovalIntent(entry.pending, profile, key) || old?.requestId === entry.pending.requestId) {
        return { state: 'approval-unavailable' };
      }
      const episode: OwnerEpisode = { ...identity, intentHash, requestId: entry.pending.requestId, requestHash: requestHash(entry.pending.request), phase: 'requested' };
      profile.version = 4; save(); writeSecure(episodeFile(), episode);
      return { state: 'live', approvalUrl: entry.pending.approvalUrl, notify: true };
    }
    const episode: OwnerEpisode = { ...identity, intentHash, requestId: null, requestHash: null, phase: 'creating' };
    profile.version = 4; save(); writeSecure(episodeFile(), episode);
    try {
      const pending = await requestApprovalInTransaction(profile, key, undefined);
      episode.requestId = pending.requestId;
      episode.requestHash = requestHash(pending.request);
      episode.phase = 'requested';
      writeSecure(episodeFile(), episode);
      return { state: 'live', approvalUrl: pending.approvalUrl, notify: true };
    } catch {
      episode.phase = 'unavailable';
      writeSecure(episodeFile(), episode);
      return { state: 'approval-unavailable', notify: true };
    }
  });
}

/** A terminal owner-authority refusal never triggers an automatic approval retry. */
export async function markOwnerRefused(): Promise<void> {
  await withProfileTransaction(async (profile, save) => {
    const grant = loadGrant();
    if (!grant) return;
    const old = loadOwnerEpisode();
    profile.version = 4; save();
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
    throw new CourierError('stale-approval', `This approval is out of date. Run \`${cmd('init --request')}\` to request a new one.`);
  }
  if (current.delegationCid !== episode.ownerGrantCid) {
    const nextEnd = siweTimes(payload.siwe).expiresAt?.getTime();
    const currentEnd = siweTimes(current.siwe).expiresAt?.getTime();
    const savedEnd = Date.parse(current.expiresAt);
    if (!nextEnd || !currentEnd || !Number.isFinite(savedEnd) || nextEnd <= Math.max(currentEnd, savedEnd)) {
      throw new CourierError('stale-approval', `This approval doesn't extend Courier's current access, so nothing changed. Run \`${cmd('init --request')}\` to request a new one.`);
    }
  }
}
