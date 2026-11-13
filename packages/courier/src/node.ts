import { TinyCloudNode, DelegatedAccess, NodeWasmBindings, activateValidatedRuntimeDelegation, deserializeDelegation, serializeDelegation } from '@tinycloud/node-sdk';
import type { IHooksService, PortableDelegation, TinyCloudSession, ValidatedRuntimeDelegation } from '@tinycloud/node-sdk';
import { cmd } from './program.js';
import { CourierError } from './errors.js';
import { COURIER_SPACE, k } from './keys.js';
import type { Profile, StoredPeer } from './profile.js';
import { loadGrant, loadKey, withProfileTransaction } from './profile.js';
import { canonicalJson } from './canonical.js';
import { getJson } from './store.js';
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

const activatedCids = new WeakMap<TinyCloudNode, Map<string, ValidatedRuntimeDelegation>>();

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

export async function currentInbound(node: TinyCloudNode, profile: Profile, peer: StoredPeer): Promise<ValidatedRuntimeDelegation> {
  if (!peer.inbound) {
    throw new CourierError('not-paired', `No delegation from ${peer.handle} yet (status ${peer.status}). Finish pairing first.`);
  }
  if (!peer.theirHandleForMe) {
    throw new CourierError('not-paired', `Peer ${peer.handle} is missing its mailbox handle; finish pairing first.`);
  }
  if (peer.interim?.latchedAt || peer.interim?.inboundRefusedAt) throw new CourierError('peer-revoked', `Sharing with ${peer.handle} was revoked. A new pairing is required.`);
  assertInboundLive(peer);
  let cids = activatedCids.get(node);
  if (!cids) {
    cids = new Map<string, ValidatedRuntimeDelegation>();
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
    cids.set(peer.inbound.cid, activated);
  }
  const current = cids.get(peer.inbound.cid)!;
  assertInboundLive(peer, current.expiry);
  return current;
}

/** `renew: false` skips reading the peer's renewal marker; the watcher reads it on its renewal schedule instead. */
export async function peerKv(node: TinyCloudNode, profile: Profile, peer: StoredPeer, options: { renew?: boolean } = {}) {
  const original = renewalBinding(profile, peer);
  const current = await currentInbound(node, profile, peer);
  const cids = activatedCids.get(node)!;
  const kv = node.kvForSpace(peer.spaceId);
  // Awaiting-C still needs the explicit pairing acknowledgement, not a renewal.
  if (peer.status !== 'paired' || options.renew === false) return kv;
  const update = await getJson<{ delegation?: string }>(kv, k.peerDelegation(peer.theirHandleForMe!, peer.sessionId));
  assertInboundLive(peer, current.expiry);
  if (!update?.value.delegation) return kv;
  const delegation = deserializeDelegation(update.value.delegation);
  if (delegation.cid === peer.inbound!.cid || delegation.expiry.getTime() <= Math.max(current.expiry.getTime(), Date.parse(peer.inbound!.expiresAt))) return kv;
  if (delegation.spaceId !== peer.spaceId || delegation.ownerAddress.toLowerCase() !== peer.ownerDid.split(':').at(-1)?.toLowerCase()) {
    throw new CourierError('bad-delegation', 'Peer renewal owner or space does not match the pairing.');
  }
  const renewed = await activateValidatedRuntimeDelegation(node, delegation, {
    host: profile.host,
    // Preserve signed caveats as well as the mailbox/session abilities.
    authorize: permissions => canonicalJson(permissions.map(entry => canonicalJson(entry)).sort()) === canonicalJson(current.effectivePermissions.map(entry => canonicalJson(entry)).sort()),
  });
  assertPeerDelegation(renewed, {
    issuer: peer.courierDid, audience: profile.courierDid, spaceId: peer.spaceId,
    mailbox: peer.theirHandleForMe!, sessionId: peer.sessionId,
  });
  assertInboundLive(peer, current.expiry);
  await withProfileTransaction(async (disk, save) => {
    if (renewalBinding(disk, disk.peers[peer.handle]) !== original || bareDid(loadKey().did) !== disk.courierDid) {
      throw new CourierError('peer-changed', 'The pairing changed while Courier was renewing. Run the command again.');
    }
    const stored = disk.peers[peer.handle];
    assertInboundLive(stored, current.expiry);
    assertInboundLive(stored, renewed.expiry);
    const inbound = { delegation: serializeDelegation(renewed.delegation), cid: renewed.cid, expiresAt: renewed.expiry.toISOString() };
    stored.inbound = inbound;
    save();
    peer.inbound = inbound;
    if (profile.peers[peer.handle]) profile.peers[peer.handle].inbound = inbound;
  });
  cids.set(renewed.cid, renewed);
  return node.kvForSpace(peer.spaceId);
}


/** Ignore outbound issuance and display labels; compare identity, both mailbox handles and the original grant. */
export function renewalBinding(profile: Profile, peer: StoredPeer | undefined): string {
  return canonicalJson({
    host: profile.host, courierDid: profile.courierDid, ownerDid: profile.ownerDid,
    spaceId: profile.spaceId, selfHandle: profile.selfHandle, status: profile.status,
    peer: peer ? { ...peer, outbound: undefined, label: undefined, interim: peer.interim?.latchedAt || peer.interim?.inboundRefusedAt || peer.interim?.ownerRevoked
      ? { latchedAt: peer.interim.latchedAt, inboundRefusedAt: peer.interim.inboundRefusedAt, ownerRevoked: peer.interim.ownerRevoked, ownerRevokedCid: peer.interim.ownerRevokedCid } : undefined } : undefined,
  });
}

export function assertInboundLive(peer: StoredPeer, signedExpiry?: Date): void {
  const expiry = Date.parse(peer.inbound?.expiresAt ?? '');
  if (!Number.isFinite(expiry) || expiry <= Date.now() || (signedExpiry && signedExpiry.getTime() <= Date.now())) {
    throw new CourierError('peer-expired', `Access from ${peer.handle} has expired. A new pairing is required.`);
  }
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
