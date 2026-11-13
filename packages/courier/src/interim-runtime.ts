import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { CourierError, isAuthorizationRefusal, isNotFoundError } from './errors.js';
import { cmd } from './program.js';
import { stateKeys } from './keys.js';
import { oneLine } from './a2a.js';
import { loadGrant, loadProfile, withProfileTransaction } from './profile.js';
import type { StoredPeer } from './profile.js';
import { courierNode, peerKv } from './node.js';
import { clearReadCache } from './thread.js';
import { maintainOutbound } from './interim-renewal.js';
import { markOwnerRefused, preflightOwner } from './interim-owner.js';

export async function prepareOwnerAccess(request = false) {
  const result = await preflightOwner({ request });
  if (result.state === 'revoked') throw new CourierError('owner-revoked', `Courier access was revoked. Run \`${cmd('init --request')}\` to request new approval.`);
  if (result.state === 'approval-required') {
    throw new CourierError('approval-required', result.approvalUrl
      ? `Courier needs your approval to keep renewing access. Approve the request in OpenKey, then run \`${cmd('init --wait')}\`.\n${result.approvalUrl}`
      : `Courier access has expired. Run \`${cmd('init --request')}\` to request new approval.`);
  }
  if (result.notify) console.error(result.approvalUrl
    ? `Courier needs your approval to keep renewing access. Approve the request in OpenKey, then run \`${cmd('init --wait')}\`.\n${result.approvalUrl}`
    : `Courier couldn't create an approval request. Run \`${cmd('init --request')}\` to try again.`);
  return result;
}

/** Explicit and automatic paths use the same profile transaction and the same issuance policy. */
export async function maintainPeerSet(node: TinyCloudNode, target?: string, collect = false): Promise<void> {
  const handles = Object.values(loadProfile().peers).filter(peer => peer.status === 'paired' && (!target || peer.handle === target)).map(peer => peer.handle);
  let canRequestApproval = true;
  for (const handle of handles) {
    try {
      await withProfileTransaction(async (profile, save) => {
        const peer = profile.peers[handle];
        if (!peer || !watchPeerEligible(peer)) return;
        if (node.credentialHolderDid !== profile.courierDid) { canRequestApproval = false; return; }
        try {
          const result = await maintainOutbound(node, profile, peer, save);
          if (result.state === 'lapsed' || result.state === 'owner-revoked') canRequestApproval = false;
          if (result.state === 'unavailable') {
            canRequestApproval = false;
            if (!peer.interim?.unavailableAt) {
              peer.interim ??= { cleanup: {} };
              peer.interim.unavailableAt = new Date().toISOString();
              profile.version = 4; save();
            }
          } else if (peer.interim?.unavailableAt) { delete peer.interim.unavailableAt; save(); }
        } catch (error) {
          if (isAuthorizationRefusal(error) || (error instanceof CourierError && error.code === 'owner-authority-refused')) throw error;
          canRequestApproval = false;
          peer.interim ??= { cleanup: {} };
          peer.interim.unavailableAt ??= new Date().toISOString();
          profile.version = 4; save();
        }
      });
      if (collect) {
        const current = loadProfile();
        const peer = current.peers[handle];
        if (peer && watchPeerEligible(peer)) {
          try { await peerKv(node, current, peer); }
          catch (error) {
            if (isAuthorizationRefusal(error)) await recordAuthorityRefusal(`peer:${handle}`);
            else if (!(error instanceof CourierError)) throw error;
          }
        }
      }
    } catch (error) {
      if (isAuthorizationRefusal(error) || (error instanceof CourierError && error.code === 'owner-authority-refused')) {
        await markOwnerRefused();
        throw new CourierError('owner-authority-refused', `Courier's access was refused, so automatic renewal has stopped. Run \`${cmd('init --request')}\` to request new approval.`);
      }
      if (!(error instanceof CourierError)) throw error;
      canRequestApproval = false;
      // Other peers stay independent; the normal requested read still reports this peer's refusal.
      console.error(`Courier couldn't renew access for ${oneLine(handle)}. Its current access is unchanged.`);
    }
  }
  const owner = await prepareOwnerAccess();
  if (canRequestApproval && owner.requestDue) {
    // restoreSession is local. Even with no eligible peer lineage, prove owner authority on the node before asking.
    let authenticated = false;
    try {
      // This agent's own watch.json: a read only, and never another agent's state.
      const read = await node.kv.get(stateKeys(loadProfile().courierDid).watch, { prefix: '' });
      if (!read.ok && !isNotFoundError(read.error)) throw read.error;
      authenticated = true; // A signed, authorized 404 also proves the read was accepted.
    } catch (error) {
      if (isAuthorizationRefusal(error)) {
        await markOwnerRefused();
        throw new CourierError('owner-authority-refused', `Courier's access was refused, so automatic renewal has stopped. Run \`${cmd('init --request')}\` to request new approval.`);
      }
      // Unknown and transient results cannot authorize an automatic request.
    }
    if (authenticated) await prepareOwnerAccess(true);
  }
}

export function watchPeerEligible(peer: StoredPeer, now = Date.now()): boolean {
  return peer.status === 'paired' && !!peer.inbound && !!peer.theirHandleForMe
    && Number.isFinite(Date.parse(peer.inbound.expiresAt)) && Date.parse(peer.inbound.expiresAt) > now
    && !peer.interim?.latchedAt && !peer.interim?.inboundRefusedAt;
}

export async function recordAuthorityRefusal(source: string): Promise<void> {
  clearReadCache();
  if (!source.startsWith('peer:')) { await markOwnerRefused(); return; }
  const handle = source.split(':')[1];
  await withProfileTransaction(async (profile, save) => {
    const peer = profile.peers[handle];
    if (!peer) return;
    peer.interim ??= { cleanup: {} };
    peer.interim.inboundRefusedAt ??= new Date().toISOString();
    profile.version = 4; save();
  });
}

export async function createRuntimeNode(): Promise<TinyCloudNode> {
  await prepareOwnerAccess();
  try { return await courierNode(loadProfile()); }
  catch (error) {
    if (isAuthorizationRefusal(error)) await markOwnerRefused();
    throw error;
  }
}

/** Local only: owner access state, and a changed owner grant restarts a service so every captured SDK service uses the verified new session. */
export async function watchOwnerPreflight(node: TinyCloudNode): Promise<void> {
  await prepareOwnerAccess();
  if (loadGrant()?.delegationCid !== node.restorableSession?.delegationCid) {
    throw new CourierError('owner-grant-changed', `Your approval for Courier changed. Run your \`${cmd('watch')}\` command again to use it.`);
  }
}

export async function watchPreflight(node: TinyCloudNode): Promise<void> {
  await watchOwnerPreflight(node);
  await maintainPeerSet(node);
}
