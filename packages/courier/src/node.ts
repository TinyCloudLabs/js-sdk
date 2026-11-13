import { TinyCloudNode, DelegatedAccess, NodeWasmBindings, activateValidatedRuntimeDelegation, deserializeDelegation, serializeDelegation } from '@tinycloud/node-sdk';
import { createRegistryVerdictCache } from '@tinycloud/sdk-core/registry-verdict-cache';
import { createInMemoryRegistryCacheStore, createInMemoryRegistrySequenceStore, type RegistryCacheStore, type RegistrySequenceStore } from '@tinycloud/sdk-core';
import type { IHooksService, PortableDelegation, TinyCloudSession, ValidatedRuntimeDelegation } from '@tinycloud/node-sdk';
import { cmd } from './program.js';
import { CourierError } from './errors.js';
import { COURIER_SPACE, k } from './keys.js';
import type { Profile, StoredPeer } from './profile.js';
import { loadGrant, loadKey, withProfileTransaction } from './profile.js';
import { canonicalJson } from './canonical.js';
import { getJson } from './store.js';
import { assertAgentGrant, assertPeerDelegation, bareDid, siweTimes } from './authority.js';

/**
 * One registry verdict cache for every node this process creates (TC-2970): each owner is looked up once per command,
 * and a long-running `watch`, `intake` or `outbox serve` looks again after the SDK's bounds (a record 5 min, no record
 * 60 s). Failed or unavailable lookups are not kept. The nodes also share one registry sequence store and one saved-settings
 * store: the SDK serves a cached verdict only to a client whose own stores agree with it, so shared stores keep the
 * rollback and known-owner checks the same for every node and let all of them reuse the lookup.
 */
const registry = {
  registryVerdictCache: createRegistryVerdictCache(),
  registrySequenceStore: createInMemoryRegistrySequenceStore() as RegistrySequenceStore,
  registryCacheStore: createInMemoryRegistryCacheStore() as RegistryCacheStore,
};

export function nodeOpts(host: string) {
  return {
    host,
    tinycloudFallbackHosts: [host],
    autoDiscoverLocalNode: false,
    enablePublicSpace: false,
    autoBootstrapAccount: false,
    includeAccountRegistryPermissions: false,
    ...registry,
  };
}

/**
 * The node each peer's reads go through, and the grant installed on it for that peer. The SDK uses the first installed
 * grant that covers an operation (TC-2938), so a superseded grant must never sit beside its successor: the first grant
 * of a peer is installed on the main node, and any later one on a fresh reader node that holds only it.
 */
const peerReaders = new WeakMap<TinyCloudNode, Map<string, { cid: string; reader: TinyCloudNode; activated: ValidatedRuntimeDelegation }>>();

function readersOf(node: TinyCloudNode) {
  let readers = peerReaders.get(node);
  if (!readers) peerReaders.set(node, readers = new Map());
  return readers;
}

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
  const readers = readersOf(node);
  const known = readers.get(peer.handle);
  if (known?.cid !== peer.inbound.cid) {
    const delegation: PortableDelegation = deserializeDelegation(peer.inbound.delegation);
    // A peer whose earlier grant is installed on the main node gets a reader of its own for the new one.
    const reader = known ? await courierNode(profile) : node;
    const activated = await activateValidatedRuntimeDelegation(reader, delegation, { host: profile.host });
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
    readers.set(peer.handle, { cid: activated.cid, reader, activated });
  }
  const current = readers.get(peer.handle)!.activated;
  assertInboundLive(peer, current.expiry);
  return current;
}

/** The node holding only this peer's current grant (after `currentInbound`). */
function peerReader(node: TinyCloudNode, peer: StoredPeer): TinyCloudNode {
  return readersOf(node).get(peer.handle)!.reader;
}

/** `renew: false` skips reading the peer's renewal marker; the watcher reads it on its renewal schedule instead. */
export async function peerKv(node: TinyCloudNode, profile: Profile, peer: StoredPeer, options: { renew?: boolean } = {}) {
  const original = renewalBinding(profile, peer);
  const current = await currentInbound(node, profile, peer);
  const kv = peerReader(node, peer).kvForSpace(peer.spaceId);
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
  // The successor goes on a fresh reader: installed next to the current grant it would never be used.
  const reader = await courierNode(profile);
  const renewed = await activateValidatedRuntimeDelegation(reader, delegation, {
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
  readersOf(node).set(peer.handle, { cid: renewed.cid, reader, activated: renewed });
  return reader.kvForSpace(peer.spaceId);
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
