import type { AccountDelegationRecord, TinyCloudNode } from '@tinycloud/node-sdk';
import { oneLine } from './a2a.js';
import { bareDid } from './authority.js';
import { cmd } from './program.js';
import { CourierError } from './errors.js';
import { peerReadPermissions } from './keys.js';
import type { Profile, StoredPeer } from './profile.js';

function nodeFailure(code: string): string {
  if (code === 'PERMISSION_DENIED') return 'the node refused';
  if (code === 'NETWORK_ERROR' || code === 'CHAIN_TOO_DEEP') return "the node couldn't be reached";
  return 'unexpected node response';
}

type Scope = { courierDid: string; spaceId: string };
type Fail = (reason: string) => never;

/** Only children of this agent for this audience and exact mailbox/session, regardless of local ledger state. */
export async function issuedPeerGrants(node: TinyCloudNode, scope: Scope, peer: StoredPeer, failed: Fail): Promise<AccountDelegationRecord[]> {
  const listed = await node.delegationManager.queryAllIssued({ space: scope.spaceId });
  if (!listed.ok) return failed(nodeFailure(listed.error.code));
  const expected = peerReadPermissions(peer.handle, scope.spaceId, peer.sessionId).flatMap((p) =>
    p.actions.map((action) => JSON.stringify([`${p.space}/${p.service.replace('tinycloud.', '')}/${p.path}`, action]))).sort();
  return listed.data.filter((record) => {
    if (bareDid(record.delegatorDid) !== scope.courierDid || bareDid(record.delegateDid) !== peer.courierDid) return false;
    if (record.resources.some((r) => r.caveats.length !== r.actions.length || r.caveats.some((c) => Object.keys(c).length !== 0))) return false;
    const actual = record.resources.flatMap((r) => r.actions.map((action) => JSON.stringify([r.resource, action]))).sort();
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
}

/**
 * Grants this agent issued over any part of a mailbox, to any audience, that the node does not show are over. Fail
 * closed: only a revocation, or an `expired` status whose own expiry has passed, ends one; `pending` stays live.
 */
export async function liveMailboxGrants(node: TinyCloudNode, scope: Scope, handle: string, failed: Fail): Promise<AccountDelegationRecord[]> {
  const listed = await node.delegationManager.queryAllIssued({ space: scope.spaceId });
  if (!listed.ok) return failed(nodeFailure(listed.error.code));
  const [read, subscribe] = peerReadPermissions(handle, scope.spaceId);
  const kv = `${scope.spaceId}/kv/${read!.path}`;
  const hooks = `${scope.spaceId}/hooks/${subscribe!.path}`;
  const now = Date.now();
  return listed.data.filter((record) => {
    if (bareDid(record.delegatorDid) !== scope.courierDid) return false;
    if (!record.resources.some((r) => r.resource.startsWith(kv) || r.resource === hooks || r.resource.startsWith(`${hooks}/`))) return false;
    if (record.status === 'revoked' || record.status === 'ancestor_revoked') return false;
    return !(record.status === 'expired' && record.expiresAt !== null && record.expiresAt.getTime() <= now);
  });
}

/** Reconcile node-issued children, including replacements not yet saved in the local ledger. */
export async function revokePeerGrants(
  node: TinyCloudNode, scope: Scope, getPeer: () => StoredPeer, save: () => void | Promise<void>, failed: Fail,
  strictPrepared = false,
): Promise<void> {
  const peer = getPeer();
  const matches = await issuedPeerGrants(node, scope, peer, failed);
  const byCid = new Map(matches.map((r) => [r.cid, r]));
  // A local CID alone is never authority to revoke another holder or another mailbox.
  for (const entry of peer.outbound) {
    if (!entry.revokedAt && !byCid.has(entry.cid)) failed('unexpected node response');
  }
  for (const record of matches) {
    const current = getPeer();
    let entry = current.outbound.find((e) => e.cid === record.cid);
    if (entry?.revokedAt) continue;
    if (!entry) {
      entry = { cid: record.cid, issuedAt: record.issuedAt?.toISOString() ?? new Date().toISOString(), expiresAt: record.expiresAt?.toISOString() ?? '' };
      current.outbound.push(entry);
      await save();
    }
    const result = await node.delegationManager.revokeIssued(record.cid);
    if (!result.ok) failed(nodeFailure(result.error.code));
    getPeer().outbound.find((e) => e.cid === record.cid)!.revokedAt = new Date().toISOString();
    await save();
  }
  // A renewal may have signed and persisted a child just before activation, then lost the local-save race to this
  // revoke (the SDK aborts activation on that save's refusal) or crashed between the two: best-effort, so a prepared
  // CID this revoke's own inventory pass never saw (not yet active, or the node hasn't indexed it yet) is not left live.
  const preparing = getPeer().interim?.preparing;
  if (preparing && !getPeer().outbound.some((e) => e.cid === preparing.cid && e.revokedAt)) {
    const result = await node.delegationManager.revokeIssued(preparing.cid).catch(() => undefined);
    // Strict callers clear a refused CID only when a fresh issued inventory proves it never reached the node: the signed
    // child then exists only in the caller's private record, which this unpair is about to delete.
    let neverActivated = false;
    if (strictPrepared && !result?.ok) {
      if (result?.error.code !== 'PERMISSION_DENIED') failed(result ? nodeFailure(result.error.code) : "the node couldn't be reached");
      const listed = await node.delegationManager.queryAllIssued({ space: scope.spaceId });
      if (!listed.ok) failed(nodeFailure(listed.error.code));
      if (listed.data.some((record) => record.cid === preparing.cid)) failed(nodeFailure(result.error.code));
      neverActivated = true;
    }
    if (result?.ok || neverActivated) {
      const current = getPeer();
      const revokedAt = new Date().toISOString();
      const entry = current.outbound.find((e) => e.cid === preparing.cid);
      if (entry && result?.ok) entry.revokedAt = revokedAt;
      if (current.interim?.preparing?.cid === preparing.cid) delete current.interim.preparing;
      await save();
    }
  }
}

export async function revokePeer(node: TinyCloudNode, profile: Profile, handle: string, save: () => void): Promise<void> {
  const shown = oneLine(handle);
  await revokePeerGrants(node, { courierDid: profile.courierDid, spaceId: profile.spaceId! }, () => profile.peers[handle]!, save, reason => {
    throw new CourierError('revoke-failed', `Couldn't finish revoking ${shown}: ${reason}. The pairing is kept, so run \`${cmd(`revoke ${shown}`)}\` again to finish.`);
  });
}
