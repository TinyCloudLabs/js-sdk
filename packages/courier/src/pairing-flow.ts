import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { activateValidatedRuntimeDelegation, deserializeDelegation, serializeDelegation, type DelegateToOptions, type PortableDelegation, type TinyCloudNode, type ValidatedRuntimeDelegation } from '@tinycloud/node-sdk';
import { assertExactAuthority, assertPeerDelegation } from './authority.js';
import { canonicalJson } from './canonical.js';
import { base64url32, ed25519DidKey } from './did-key.js';
import { CourierError } from './errors.js';
import { peerReadPermissions } from './keys.js';
import { PEER_DELEGATION_EXPIRY, type PairArtifact } from './pairing.js';
import type { StoredPeer } from './profile.js';

export interface PairIdentity { host: string; courierDid: string }
export function pendingFromA(art: PairArtifact): StoredPeer {
  return {
    handle: art.callMe, ownerDid: art.from.owner, courierDid: art.from.courier, label: art.from.label,
    spaceId: art.spaceId, outbound: [], theirHandleForMe: art.peer, status: 'awaiting-C', pairedAt: new Date().toISOString(),
  };
}

export function assertPairCompletion(peer: StoredPeer, art: PairArtifact): void {
  if (peer.handle !== art.callMe) {
    throw new CourierError('bad-artifact', `Artifact C names ${art.callMe}, but the matched peer handle is ${peer.handle}.`);
  }
  if (peer.status !== 'awaiting-C' && peer.status !== 'paired') {
    throw new CourierError('not-paired', `Cannot install artifact C for ${peer.handle}: pairing is not awaiting C or already paired.`);
  }
  if (art.from.courier !== peer.courierDid || art.spaceId !== peer.spaceId || art.from.owner !== peer.ownerDid) {
    throw new CourierError('bad-artifact', `Artifact C does not match the pairing with ${peer.handle}.`);
  }
  if (!peer.theirHandleForMe || art.peer !== peer.theirHandleForMe) {
    throw new CourierError('bad-artifact', `Artifact C changes the established mailbox scope for ${peer.handle}.`);
  }
}

export async function verifyPairDelegation(node: TinyCloudNode, identity: PairIdentity, peer: StoredPeer, serialized: string, original?: ValidatedRuntimeDelegation): Promise<ValidatedRuntimeDelegation> {
  const delegation = deserializeDelegation(serialized);
  if (delegation.spaceId !== peer.spaceId || delegation.ownerAddress.toLowerCase() !== peer.ownerDid.split(':').at(-1)?.toLowerCase()) {
    throw new CourierError('bad-artifact', 'Peer delegation space or owner does not match the pairing artifact.');
  }
  const mailbox = peer.theirHandleForMe;
  if (!mailbox) throw new CourierError('bad-artifact', 'Pairing artifact is missing the peer mailbox handle.');
  const active = await activateValidatedRuntimeDelegation(node, delegation, {
    host: identity.host,
    authorize: permissions => {
      assertExactAuthority(permissions, peerReadPermissions(mailbox, peer.spaceId, peer.sessionId), 'Pair renewal');
      if (original && canonicalJson(permissions.map(entry => canonicalJson(entry)).sort()) !== canonicalJson(original.effectivePermissions.map(entry => canonicalJson(entry)).sort())) {
        throw new CourierError('bad-delegation', "Couldn't renew: the renewal would change what the peer can access. Nothing changed.");
      }
      return true;
    },
  });
  assertPeerDelegation(active, {
    issuer: peer.courierDid, audience: identity.courierDid, spaceId: peer.spaceId, mailbox, sessionId: peer.sessionId,
  });
  return active;
}

export function inboundGrant(active: ValidatedRuntimeDelegation): NonNullable<StoredPeer['inbound']> {
  return { delegation: serializeDelegation(active.delegation), cid: active.cid, expiresAt: active.expiry.toISOString() };
}

export async function issuePairDelegation(node: TinyCloudNode, spaceId: string, peer: StoredPeer, options?: DelegateToOptions): Promise<PortableDelegation> {
  const result = await node.delegateTo(peer.courierDid, peerReadPermissions(peer.handle, spaceId, peer.sessionId), {
    expiry: PEER_DELEGATION_EXPIRY, ...options,
  });
  return result.delegation;
}

export function recordOutbound(peer: StoredPeer, delegation: PortableDelegation): void {
  peer.outbound.push({ cid: delegation.cid, issuedAt: new Date().toISOString(), expiresAt: delegation.expiry.toISOString(), delegation: serializeDelegation(delegation) });
}
// B's challenge is unique even if this pair already negotiated the very same mailbox and grant scope.
export function pairChallenge(challenge: unknown): void {
  if (!base64url32(challenge)) throw new CourierError('bad-artifact', 'Invalid pairing challenge.');
}

function completionBytes(b: PairArtifact, c: PairArtifact): Buffer {
  return Buffer.from(canonicalJson([
    'tinycloud-courier-pair/v1', b.challenge, b.from.owner, b.from.courier, b.spaceId,
    b.peer, b.callMe, deserializeDelegation(b.delegation!).cid,
    c.from.owner, c.from.courier, c.spaceId, c.peer, c.callMe, deserializeDelegation(c.delegation!).cid,
  ]));
}

export async function signPairCompletion(b: PairArtifact, c: PairArtifact, node: TinyCloudNode): Promise<void> {
  pairChallenge(b.challenge);
  const x = (node.restorableSession?.jwk as JsonWebKey | undefined)?.x;
  const bytes = base64url32(x);
  if (!bytes || ed25519DidKey(bytes) !== c.from.courier) throw new CourierError('bad-artifact', 'Pairing challenge requires this agent’s Ed25519 key.');
  c.completion = {
    x: x!,
    signature: Buffer.from(await node.signSessionBytes(completionBytes(b, c))).toString('base64url'),
  };
}

export function assertSignedPairCompletion(b: PairArtifact, c: PairArtifact): void {
  const x = base64url32(c.completion?.x);
  const signature = c.completion?.signature;
  if (!x || ed25519DidKey(x) !== c.from.courier || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) {
    throw new CourierError('bad-artifact', 'Pairing completion must sign the accepted challenge.');
  }
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: c.completion!.x }, format: 'jwk' });
  const bytes = Buffer.from(signature, 'base64url');
  if (bytes.toString('base64url') !== signature || !verify(null, completionBytes(b, c), key, bytes)) {
    throw new CourierError('bad-artifact', 'Pairing completion signature does not match the accepted challenge.');
  }
}
