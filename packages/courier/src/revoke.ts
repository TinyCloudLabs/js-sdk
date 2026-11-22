import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { oneLine } from './a2a.js';
import { bareDid } from './authority.js';
import { cmd } from './program.js';
import { CourierError } from './errors.js';
import { peerReadPermissions } from './keys.js';
import type { Profile } from './profile.js';

function nodeFailure(code: string): string {
  if (code === 'PERMISSION_DENIED') return 'the node refused';
  if (code === 'NETWORK_ERROR' || code === 'CHAIN_TOO_DEEP') return "the node couldn't be reached";
  return 'unexpected node response';
}

/** Reconcile node-issued children, including replacements not yet saved in the local ledger. */
export async function revokePeer(node: TinyCloudNode, profile: Profile, handle: string, save: () => void): Promise<void> {
  const peer = profile.peers[handle]!;
  const shown = oneLine(handle);
  const failed = (reason: string): never => {
    throw new CourierError('revoke-failed', `Couldn't finish revoking ${shown}: ${reason}. The pairing is kept, so run \`${cmd(`revoke ${shown}`)}\` again to finish.`);
  };
  const listed = await node.delegationManager.queryAllIssued({ space: profile.spaceId! });
  if (!listed.ok) return failed(nodeFailure(listed.error.code));
  const expected = peerReadPermissions(handle, profile.spaceId!, peer.sessionId).flatMap((p) =>
    p.actions.map((action) => JSON.stringify([`${p.space}/${p.service.replace('tinycloud.', '')}/${p.path}`, action]))).sort();
  const matches = listed.data.filter((record) => {
    if (bareDid(record.delegatorDid) !== profile.courierDid || bareDid(record.delegateDid) !== peer.courierDid) return false;
    if (record.resources.some((r) => r.caveats.length !== r.actions.length || r.caveats.some((c) => Object.keys(c).length !== 0))) return false;
    const actual = record.resources.flatMap((r) => r.actions.map((action) => JSON.stringify([r.resource, action]))).sort();
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
  const byCid = new Map(matches.map((r) => [r.cid, r]));
  // A local CID alone is never authority to revoke another holder or another mailbox.
  for (const entry of peer.outbound) {
    if (!entry.revokedAt && !byCid.has(entry.cid)) failed('unexpected node response');
  }
  for (const record of matches) {
    const current = profile.peers[handle]!;
    let entry = current.outbound.find((e) => e.cid === record.cid);
    if (entry?.revokedAt) continue;
    if (!entry) {
      entry = { cid: record.cid, issuedAt: record.issuedAt?.toISOString() ?? new Date().toISOString(), expiresAt: record.expiresAt?.toISOString() ?? '' };
      current.outbound.push(entry);
      save();
    }
    const result = await node.delegationManager.revokeIssued(record.cid);
    if (!result.ok) failed(nodeFailure(result.error.code));
    profile.peers[handle]!.outbound.find((e) => e.cid === record.cid)!.revokedAt = new Date().toISOString();
    save();
  }
  // A renewal may have signed and persisted a child just before activation, then lost the local-save race to this
  // revoke (the SDK aborts activation on that save's refusal) or crashed between the two: best-effort, so a prepared
  // CID this revoke's own inventory pass never saw (not yet active, or the node hasn't indexed it yet) is not left live.
  const preparing = profile.peers[handle]!.interim?.preparing;
  if (preparing && !profile.peers[handle]!.outbound.some((e) => e.cid === preparing.cid && e.revokedAt)) {
    const result = await node.delegationManager.revokeIssued(preparing.cid).catch(() => undefined);
    if (result?.ok) {
      const current = profile.peers[handle]!;
      const revokedAt = new Date().toISOString();
      const entry = current.outbound.find((e) => e.cid === preparing.cid);
      if (entry) entry.revokedAt = revokedAt;
      if (current.interim?.preparing?.cid === preparing.cid) delete current.interim.preparing;
      save();
    }
  }
}
