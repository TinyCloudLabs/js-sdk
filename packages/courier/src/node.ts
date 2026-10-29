import { TinyCloudNode, DelegatedAccess, NodeWasmBindings, activateValidatedRuntimeDelegation, deserializeDelegation } from '@tinycloud/node-sdk';
import type { IHooksService, PortableDelegation, TinyCloudSession } from '@tinycloud/node-sdk';
import { cmd } from './program.js';
import { CourierError } from './errors.js';
import { COURIER_SPACE } from './keys.js';
import type { Profile, StoredPeer } from './profile.js';
import { loadGrant, loadKey } from './profile.js';
import { assertAgentGrant, assertPeerDelegation, bareDid, siweTimes } from './authority.js';

export function nodeOpts(host: string) {
  return {
    host,
    tinycloudFallbackHosts: [host],
    autoDiscoverLocalNode: false,
    enablePublicSpace: false,
    autoBootstrapAccount: false,
    includeAccountRegistryPermissions: false,
  };
}

const activatedCids = new WeakMap<TinyCloudNode, Set<string>>();

export async function courierNode(profile: Profile, home?: string): Promise<TinyCloudNode> {
  const key = loadKey(home);
  const grant = loadGrant(home);
  if (profile.status === 'awaiting-space') {
    if (profile.spacePending) {
      throw new CourierError('no-space', `TinyCloud "${COURIER_SPACE}" space is still being set up by OpenKey; run \`${cmd('init --resume')}\`.`);
    }
    throw new CourierError('no-space', `TinyCloud "${COURIER_SPACE}" space is missing; after hosting it, run \`${cmd('init --resume')}\`.`);
  }
  if (!grant || profile.status === 'awaiting-grant') {
    throw new CourierError('no-grant', `No OpenKey owner grant is installed. Run \`${cmd('init')}\` and approve the request in OpenKey.`);
  }
  if (!grant.spaceId.toLowerCase().endsWith(`:${COURIER_SPACE}`)) {
    throw new CourierError('profile-outdated', `Courier grant space is not ${COURIER_SPACE}; run \`${cmd('init --rotate-key')}\`, then re-pair peers.`);
  }
  const expiry = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiry) || Date.now() >= expiry) {
    throw new CourierError('grant-expired', `The Courier grant expired; run \`${cmd('init')}\` to renew (the OpenKey owner must approve).`);
  }
  if (expiry - Date.now() < 3 * 24 * 3600 * 1000) {
    console.error(`warning: Courier grant expires ${new Date(expiry).toISOString()}; renew with [1m${cmd('init')}[0m and owner approval.`);
  }
  const node = new TinyCloudNode(nodeOpts(profile.host));
  await node.restoreSession({
    delegationHeader: grant.delegationHeader,
    delegationCid: grant.delegationCid,
    spaceId: grant.spaceId,
    jwk: key.jwk,
    verificationMethod: grant.verificationMethod,
    address: grant.address,
    chainId: grant.chainId,
    siwe: grant.siwe,
    signature: grant.signature,
    expiresAt: grant.expiresAt,
    tinycloudHosts: [profile.host],
  });
  if (node.credentialHolderDid !== profile.courierDid) {
    throw new CourierError('bad-grant', `Grant holder ${node.credentialHolderDid} does not match courier key ${profile.courierDid}.`);
  }
  assertAgentGrant(node.getVerifiedSessionCapabilities(), siweTimes(grant.siwe));
  const restored = node.restorableSession;
  const owner = restored ? `did:pkh:eip155:${restored.chainId}:${restored.address}` : '';
  if (profile.ownerDid?.toLowerCase() !== owner.toLowerCase() || profile.spaceId?.toLowerCase() !== restored?.spaceId.toLowerCase()) {
    throw new CourierError('bad-grant', 'Profile owner or space does not match the verified Courier grant.');
  }
  return node;
}

export async function peerKv(node: TinyCloudNode, profile: Profile, peer: StoredPeer) {
  if (!peer.inbound) {
    throw new CourierError('not-paired', `No delegation from ${peer.handle} yet (status ${peer.status}). Finish pairing first.`);
  }
  if (!peer.theirHandleForMe) {
    throw new CourierError('not-paired', `Peer ${peer.handle} is missing its mailbox handle; finish pairing first.`);
  }
  let cids = activatedCids.get(node);
  if (!cids) {
    cids = new Set<string>();
    activatedCids.set(node, cids);
  }
  if (!cids.has(peer.inbound.cid)) {
    const delegation: PortableDelegation = deserializeDelegation(peer.inbound.delegation);
    const activated = await activateValidatedRuntimeDelegation(node, delegation, { host: profile.host });
    assertPeerDelegation(activated, {
      issuer: peer.courierDid,
      audience: profile.courierDid,
      spaceId: peer.spaceId,
      mailbox: peer.theirHandleForMe,
      sessionId: peer.sessionId,
    });
    if (activated.cid !== peer.inbound.cid) {
      throw new CourierError('bad-delegation', `Peer delegation CID does not match the stored CID for ${peer.handle}.`);
    }
    cids.add(peer.inbound.cid);
  }
  return node.kvForSpace(peer.spaceId);
}


let wasm: NodeWasmBindings | undefined;

/**
 * Hook subscriptions on a peer's mailbox. The courier node cannot `useDelegation` (its holder is the owner's
 * did:pkh), and a hook ticket minted from the node's own session is refused for a peer's space (401), so the
 * stream runs on a `DelegatedAccess` whose session is the peer delegation, signed by the courier key (spec §8).
 */
export async function peerHooks(node: TinyCloudNode, profile: Profile, peer: StoredPeer): Promise<IHooksService> {
  await peerKv(node, profile, peer); // validates the delegation against the pairing record
  const delegation = deserializeDelegation(peer.inbound!.delegation);
  const key = loadKey();
  wasm ??= new NodeWasmBindings();
  const session: TinyCloudSession = {
    address: delegation.ownerAddress,
    chainId: delegation.chainId,
    sessionKey: JSON.stringify(key.jwk),
    spaceId: delegation.spaceId,
    delegationCid: delegation.cid,
    delegationHeader: delegation.delegationHeader,
    verificationMethod: node.sessionDid,
    jwk: key.jwk as never,
    siwe: '',
    signature: '',
  };
  return new DelegatedAccess(session, delegation, profile.host, wasm.invoke, wasm.invokeAny).hooks;
}
