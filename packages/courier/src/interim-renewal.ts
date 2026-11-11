import { deserializeDelegation, serializeDelegation } from '@tinycloud/node-sdk';
import type { AccountDelegationRecord, PermissionEntry, PortableDelegation, TinyCloudNode } from '@tinycloud/node-sdk';
import { canonicalizeRecapCaveats, parseCanonicalRecapResource, parseSignedCompactUcanAttenuation } from '@tinycloud/sdk-core';
import { canonicalJson } from './canonical.js';
import { bareDid, siweTimes } from './authority.js';
import { CourierError } from './errors.js';
import { cmd } from './program.js';
import { k, peerReadPermissions } from './keys.js';
import type { Profile, StoredPeer } from './profile.js';
import { getJson, putCreate, putMatch } from './store.js';

const DAY = 86_400_000;
export const INTERIM_PERIOD_MS = 30 * DAY;
const MAX_ISSUED = 1000;

export interface InterimState {
  latchedAt?: string;
  ownerRevoked?: boolean;
  ownerRevokedCid?: string;
  lastAttemptAt?: string;
  unavailableAt?: string;
  inboundRefusedAt?: string;
  cleanup: Record<string, { intentAt: string; revokedAt?: string }>;
}
export type InterimPeer = StoredPeer & { interim?: InterimState };
type LedgerEntry = StoredPeer['outbound'][number] & { priorCid?: string; delegation?: string; revokedAt?: string };
type Resource = AccountDelegationRecord['resources'][number];
export type InterimResult = { state: 'live' | 'renewed' | 'lapsed' | 'revoked' | 'owner-revoked' | 'unavailable'; delegation?: PortableDelegation; reason?: 'no-extension' };

/** Per-action canonical equality includes conditions, never just permission subsets. */
export function issuedAuthority(resources: readonly Resource[]): string {
  const tuples = resources.flatMap(entry => entry.actions.map(action => canonicalJson({
    resource: entry.resource, action, caveats: canonicalizeRecapCaveats(entry.caveats.every(caveat => Object.keys(caveat).length === 0) ? undefined : entry.caveats),
  })));
  return canonicalJson([...new Set(tuples)].sort());
}

function permissions(resources: readonly Resource[]): PermissionEntry[] {
  return resources.map(entry => {
    const { space, path } = parseCanonicalRecapResource(entry.resource);
    const service = entry.resource.slice(space.length + 1).split('/')[0];
    if (service !== 'kv' && service !== 'hooks') throw new CourierError('renewal-unavailable', "Courier couldn't safely renew access, so your current access is unchanged. Try again later.");
    return { space, service: `tinycloud.${service}`, path, actions: [...entry.actions], ...(entry.caveats.some(caveat => Object.keys(caveat).length > 0) ? { caveats: entry.caveats } : {}) };
  });
}

function bindingAuthority(profile: Profile, peer: StoredPeer): string {
  return issuedAuthority(peerReadPermissions(peer.handle, profile.spaceId!, peer.sessionId).map(entry => ({
    resource: `${entry.space}/${entry.service.replace(/^tinycloud\./, '')}/${entry.path}`,
    actions: entry.actions, caveats: [],
  })));
}

function sameBinding(profile: Profile, peer: StoredPeer, record: AccountDelegationRecord): boolean {
  return bareDid(record.delegatorDid) === profile.courierDid && bareDid(record.delegateDid) === peer.courierDid
    && issuedAuthority(record.resources.map(entry => ({ ...entry, caveats: [] }))) === bindingAuthority(profile, peer);
}

function ledgerTip(peer: InterimPeer): LedgerEntry | undefined {
  return [...peer.outbound].reverse().find(entry => !(entry as LedgerEntry).revokedAt && !peer.interim?.cleanup[entry.cid]);
}

function stateOf(peer: InterimPeer): InterimState {
  return peer.interim ??= { cleanup: {} };
}

function liveEnd(value: Date | null | undefined, now: number): number {
  const end = value?.getTime();
  if (end === undefined || !Number.isFinite(end) || end <= now) throw new CourierError('peer-expired', 'A new pairing is required.');
  return end;
}

/** Local-only on terminal states: a restarted supervisor never probes a lapsed/latched peer. */
export function interimLocalState(peer: InterimPeer, now = Date.now()): InterimResult['state'] {
  if (peer.interim?.ownerRevoked) return 'owner-revoked';
  if (peer.interim?.latchedAt) return 'revoked';
  const tip = ledgerTip(peer);
  if (!tip || !Number.isFinite(Date.parse(tip.expiresAt)) || Date.parse(tip.expiresAt) <= now) return 'lapsed';
  return 'live';
}

function parentOf(node: TinyCloudNode, profile: Profile, now: number): { cid: string; end: number } {
  const session = node.restorableSession;
  const end = session && siweTimes(session.siwe).expiresAt?.getTime();
  if (!session?.delegationCid || !end || !Number.isFinite(end) || end <= now || node.credentialHolderDid !== profile.courierDid) {
    throw new CourierError('grant-expired', `Courier needs your approval again. Run \`${cmd('init --request')}\` to request it.`);
  }
  return { cid: session.delegationCid, end };
}

async function issued(node: TinyCloudNode, profile: Profile): Promise<AccountDelegationRecord[]> {
  const result = await node.delegationManager.queryAllIssued({ space: profile.spaceId, maxItems: MAX_ISSUED + 1 });
  if (!result.ok && [401, 403].includes(Number(result.error.meta?.status))) throw new CourierError('owner-authority-refused', `Courier's access was refused. Run \`${cmd('init --request')}\` to request new approval.`);
  if (!result.ok || result.data.length > MAX_ISSUED) throw new CourierError('renewal-unavailable', "Courier couldn't safely renew access, so your current access is unchanged. Try again later.");
  return result.data;
}

async function cleanup(node: TinyCloudNode, peer: InterimPeer, cid: string, save: () => void): Promise<boolean> {
  const state = stateOf(peer);
  state.cleanup[cid] ??= { intentAt: new Date().toISOString() };
  save(); // durable intent precedes every cleanup invocation
  if (stateOf(peer).cleanup[cid].revokedAt) return true;
  const result = await node.delegationManager.revokeIssued(cid);
  if (!result.ok) return false;
  const revokedAt = new Date().toISOString();
  stateOf(peer).cleanup[cid].revokedAt = revokedAt;
  const entry = peer.outbound.find(item => item.cid === cid) as LedgerEntry | undefined;
  if (entry) entry.revokedAt = revokedAt;
  save();
  return true;
}

/** Runs only while the shared async profile transaction is held by the caller. */
async function checkSiblings(node: TinyCloudNode, profile: Profile, peer: InterimPeer, save: () => void, now: number): Promise<{ tip: AccountDelegationRecord; records: AccountDelegationRecord[] } | InterimResult> {
  parentOf(node, profile, now);
  const records = await issued(node, profile);
  const ledger = peer.outbound as LedgerEntry[];
  const current = ledgerTip(peer);
  if (!current) return { state: 'unavailable' };
  const tip = records.find(item => item.cid === current.cid);
  if (!tip || !sameBinding(profile, peer, tip)) return { state: 'unavailable' };
  const siblings = records.filter(item => sameBinding(profile, peer, item) && issuedAuthority(item.resources) === issuedAuthority(tip.resources));
  const bad = ledger.map(entry => ({ entry, record: siblings.find(item => item.cid === entry.cid) }))
    .filter(({ entry, record }) => !stateOf(peer).cleanup[entry.cid]?.intentAt && record
      && (record.status === 'revoked' || record.status === 'ancestor_revoked'));
  if (bad.length) {
    const state = stateOf(peer);
    state.latchedAt ??= new Date(now).toISOString();
    const ancestor = bad.find(item => item.record?.status === 'ancestor_revoked')?.record;
    if (ancestor) { state.ownerRevoked = true; state.ownerRevokedCid = ancestor.revokedAncestorCid ?? ancestor.parents[0]; }
    save();
    for (const record of siblings) if (record.status === 'active' && record.expiresAt && record.expiresAt.getTime() > now) {
      await cleanup(node, peer, record.cid, save);
    }
    return { state: state.ownerRevoked ? 'owner-revoked' : 'revoked' };
  }
  let orphaned = false;
  for (const record of siblings) {
    if (record.status === 'active' && record.expiresAt && record.expiresAt.getTime() > now && !ledger.some(entry => entry.cid === record.cid)) {
      orphaned = true;
      await cleanup(node, peer, record.cid, save);
    }
  }
  if (orphaned) return { state: 'unavailable' };
  for (const entry of ledger) {
    if (entry.revokedAt || stateOf(peer).cleanup[entry.cid]?.intentAt) continue;
    if (entry.cid !== current.cid && Date.parse(entry.expiresAt) <= now) continue;
    const record = siblings.find(item => item.cid === entry.cid);
    if (!record || record.status !== 'active') return { state: 'unavailable' };
    liveEnd(record.expiresAt, Date.now());
  }
  liveEnd(tip.expiresAt, Date.now());
  parentOf(node, profile, Date.now());
  return { tip, records };
}

/** Decode our own just-signed bytes; node activation verifies their signature and parent chain. */
export function successorRecord(node: Pick<TinyCloudNode, 'computeDelegationCid'>, delegation: PortableDelegation): AccountDelegationRecord {
  const authorization = delegation.delegationHeader.Authorization.replace(/^Bearer\s+/i, '');
  const parts = authorization.split('.');
  if (parts.length !== 3) throw new CourierError('renewal-unavailable', "Courier couldn't safely renew access, so your current access is unchanged. Try again later.");
  parseSignedCompactUcanAttenuation(authorization);
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (node.computeDelegationCid(delegation.delegationHeader.Authorization) !== delegation.cid || typeof payload.exp !== 'number'
    || new Date(payload.exp * 1000).getTime() !== delegation.expiry.getTime() || !Array.isArray(payload.prf)) {
    throw new CourierError('renewal-unavailable', "Courier couldn't safely renew access, so your current access is unchanged. Try again later.");
  }
  const resources = Object.entries(payload.att as Record<string, Record<string, Record<string, unknown>[]>>).flatMap(([resource, abilities]) =>
    Object.entries(abilities).map(([action, caveats]) => ({ resource, actions: [action], caveats })));
  const projected = delegation.resources?.map(entry => ({
    resource: `${entry.space}/${entry.service.replace(/^tinycloud\./, '')}/${entry.path}`,
    actions: entry.actions, caveats: entry.caveats ?? [],
  }));
  const primary = delegation.resources?.find(entry => entry.path === delegation.path
    && canonicalJson([...entry.actions].sort()) === canonicalJson([...delegation.actions].sort()));
  const owner = /^tinycloud:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40}):/.exec(delegation.spaceId);
  if (!projected || issuedAuthority(projected) !== issuedAuthority(resources) || !primary
    || canonicalizeRecapCaveats(delegation.caveats) !== canonicalizeRecapCaveats(primary.caveats)
    || bareDid(delegation.delegateDID) !== bareDid(payload.aud)
    || (delegation.delegatorDID && bareDid(delegation.delegatorDID) !== bareDid(payload.iss))
    || !owner || Number(owner[1]) !== delegation.chainId || owner[2].toLowerCase() !== delegation.ownerAddress.toLowerCase()) {
    throw new CourierError('renewal-unavailable', "Courier couldn't safely renew access, so your current access is unchanged. Try again later.");
  }
  return {
    cid: delegation.cid, direction: 'granted', delegatorDid: bareDid(payload.iss), delegateDid: bareDid(payload.aud),
    resources, parents: payload.prf, issuedAt: typeof payload.nbf === 'number' ? new Date(payload.nbf * 1000) : null,
    notBefore: typeof payload.nbf === 'number' ? new Date(payload.nbf * 1000) : null, expiresAt: new Date(payload.exp * 1000), status: 'active',
  };
}

export function assertSuccessor(profile: Profile, peer: StoredPeer, prior: AccountDelegationRecord, next: AccountDelegationRecord, parent: { cid: string; end: number }, now = Date.now()): void {
  if (!sameBinding(profile, peer, prior) || !sameBinding(profile, peer, next)
    || issuedAuthority(prior.resources) !== issuedAuthority(next.resources)
    || next.parents.length !== 1 || next.parents[0] !== parent.cid
    || liveEnd(next.expiresAt, now) <= liveEnd(prior.expiresAt, now)
    || next.expiresAt!.getTime() > Math.min(now + INTERIM_PERIOD_MS, parent.end)) {
    throw new CourierError('renewal-unavailable', "Courier couldn't safely renew access, so your current access is unchanged. Try again later.");
  }
}

/** Issue only our own child. The caller holds withProfileTransaction across every awaited boundary. */
export async function maintainOutbound(node: TinyCloudNode, profile: Profile, peer: InterimPeer, persist: () => void, options: { force?: boolean; manual?: boolean } = {}): Promise<InterimResult> {
  const save = () => { profile.version = 4; persist(); };
  const local = interimLocalState(peer);
  if (local !== 'live') return { state: local };
  if (peer.status !== 'paired') return { state: 'unavailable' };
  const checked = await checkSiblings(node, profile, peer, save, Date.now());
  if ('state' in checked) return checked;
  const { tip } = checked;
  const end = liveEnd(tip.expiresAt, Date.now());
  const parent = parentOf(node, profile, Date.now());
  const ledger = peer.outbound.find(entry => entry.cid === tip.cid);
  const started = (tip.notBefore ?? tip.issuedAt)?.getTime() ?? (ledger ? Date.parse(ledger.issuedAt) : undefined);
  if (started === undefined || !Number.isFinite(started) || started >= end) return { state: 'unavailable' };
  const state = stateOf(peer);
  const now = Date.now();
  const lastAttempt = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : tip.issuedAt?.getTime();
  if (!options.force && ((!options.manual && now < started + (end - started) / 2)
    || (lastAttempt !== undefined && now - lastAttempt < DAY))) return { state: 'live' };
  if (Math.floor(Math.min(now + INTERIM_PERIOD_MS, parent.end) / 1000) * 1000 <= end) return { state: 'live', reason: 'no-extension' };
  state.lastAttemptAt = new Date(now).toISOString();
  save();
  const key = k.peerDelegation(peer.handle, peer.sessionId);
  let before = await getJson<{ cid?: string; delegation?: string }>(node.kv, key);
  if (!before) {
    // Existing pairings may have only a node-issued prior record. Establish a CAS marker, never a new grant.
    await putCreate(node.kv, key, { v: 0, cid: tip.cid, issuedAt: tip.issuedAt?.toISOString() });
    before = await getJson<{ cid?: string; delegation?: string }>(node.kv, key);
  }
  const publishedCid = before?.value.delegation ? deserializeDelegation(before.value.delegation).cid : before?.value.cid;
  if (!before?.etag || publishedCid !== tip.cid) return { state: 'unavailable' };
  // No grace: recheck the original and parent immediately before delegateTo signs.
  liveEnd(tip.expiresAt, Date.now());
  parentOf(node, profile, Date.now());
  const result = await node.delegateTo(peer.courierDid, permissions(tip.resources), { expiry: INTERIM_PERIOD_MS, requireActivation: true });
  const next = result.delegation;
  if (next.cid === tip.cid) return { state: 'live', reason: 'no-extension' };
  const record = { cid: next.cid, priorCid: tip.cid, issuedAt: new Date().toISOString(), expiresAt: next.expiry.toISOString(), delegation: serializeDelegation(next) };
  (peer.outbound as LedgerEntry[]).push(record);
  save(); // even a rejected result is recorded before any cleanup/network action
  try {
    assertSuccessor(profile, peer, tip, successorRecord(node, next), parentOf(node, profile, Date.now()));
    liveEnd(tip.expiresAt, Date.now());
    const rechecked = await checkSiblings(node, profile, peer, save, Date.now());
    if ('state' in rechecked) throw new CourierError('renewal-unavailable', "Courier couldn't safely renew access, so your current access is unchanged. Try again later.");
    liveEnd(tip.expiresAt, Date.now());
    parentOf(node, profile, Date.now());
    await putMatch(node.kv, key, { v: 0, delegation: record.delegation, issuedAt: record.issuedAt }, before.etag);
    return { state: 'renewed', delegation: next };
  } catch (error) {
    await cleanup(node, peer, next.cid, save);
    throw error;
  }
}
