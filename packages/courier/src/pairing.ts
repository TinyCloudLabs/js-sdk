import { serializeDelegation, type PortableDelegation } from '@tinycloud/node-sdk';
import { COURIER_SPACE } from './keys.js';
import { cmd } from './program.js';
import { CourierError } from './errors.js';
import type { Profile, StoredPeer } from './profile.js';

/**
 * Pairing artifacts, spec §5.
 * Three artifacts cross the chat channel between the two sides (two humans,
 * or two Courier agents of one owner — the pair is the courier did:key,
 * never the owner DID alone):
 *   A: issuer → acceptor. Carries issuer DIDs + space + the handles.
 *   B: acceptor → issuer. Carries acceptor DIDs + space + delegation to the
 *      acceptor's `to/<peer-of-issuer>/` mailbox.
 *   C: issuer → acceptor. Carries the issuer's delegation to the acceptor's
 *      mailbox on the issuer's space.
 *
 * Handle semantics (each artifact is self-describing):
 *   `peer`   — the handle the ISSUER uses for the acceptor. The issuer's mailbox
 *              for the acceptor is `to/<peer>/` on the issuer's space, and any
 *              delegation embedded in the artifact covers exactly that prefix.
 *   `callMe` — the handle the ACCEPTOR should use for the issuer. The acceptor's
 *              mailbox for the issuer is `to/<callMe>/` on the acceptor's space.
 */

export interface PairArtifact {
  type: 'courier-pair';
  v: 0;
  step: 'A' | 'B' | 'C';
  from: { owner: string; courier: string; label?: string };
  spaceId: string;
  peer: string;
  callMe: string;
  delegation?: string;
  delegationExpiresAt?: string;
  issuedAt: string;
}

export const PEER_DELEGATION_EXPIRY = '7d';
export function validateArtifactIdentity(art: PairArtifact): void {
  if (!/^did:pkh:eip155:\d+:0x[a-fA-F0-9]{40}$/.test(art.from.owner)) {
    throw new CourierError('bad-artifact', 'Artifact owner must be a did:pkh identity.');
  }
  if (!/^did:key:z[^#]+$/.test(art.from.courier)) {
    throw new CourierError('bad-artifact', 'Artifact courier must be a bare did:key.');
  }
  const [, chainId, address] = /^did:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40})$/.exec(art.from.owner)!;
  const expected = `tinycloud:pkh:eip155:${chainId}:${address}:${COURIER_SPACE}`;
  if (art.spaceId.toLowerCase() !== expected.toLowerCase()) {
    throw new CourierError('bad-artifact', `Peer space ${art.spaceId} is not an ${COURIER_SPACE} space; the peer must upgrade Courier and re-run \`${cmd('init --rotate-key')}\`.`);
  }
}

export function parseArtifact(input: string): PairArtifact {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new CourierError('bad-artifact', 'Artifact is not valid JSON. Pipe the whole artifact (or use --file/--stdin).');
  }
  const a = raw as Partial<PairArtifact>;
  if (a?.type !== 'courier-pair' || a.v !== 0) {
    throw new CourierError('bad-artifact', 'Not a courier-pair v0 artifact.');
  }
  if (a.step !== 'A' && a.step !== 'B' && a.step !== 'C') {
    throw new CourierError('bad-artifact', `Unknown artifact step "${String(a.step)}".`);
  }
  for (const f of ['spaceId', 'peer', 'callMe'] as const) {
    if (typeof a[f] !== 'string' || !a[f]) throw new CourierError('bad-artifact', `Artifact is missing "${f}".`);
  }
  if (!a.from || typeof a.from.owner !== 'string' || typeof a.from.courier !== 'string') {
    throw new CourierError('bad-artifact', 'Artifact is missing from.owner/from.courier.');
  }
  if ((a.step === 'B' || a.step === 'C') && !a.delegation) {
    throw new CourierError('bad-artifact', `Step ${a.step} must carry a delegation.`);
  }
  return a as PairArtifact;
}

export function artifactA(profile: Profile, peerHandle: string, callMe: string): PairArtifact {
  return {
    type: 'courier-pair',
    v: 0,
    step: 'A',
    from: { owner: profile.ownerDid!, courier: profile.courierDid, label: profile.label },
    spaceId: profile.spaceId!,
    peer: peerHandle,
    callMe,
    issuedAt: new Date().toISOString(),
  };
}

export function artifactWithDelegation(
  step: 'B' | 'C',
  profile: Profile,
  delegation: PortableDelegation,
  peer: string,
  callMe: string,
): PairArtifact {
  return {
    type: 'courier-pair',
    v: 0,
    step,
    from: { owner: profile.ownerDid!, courier: profile.courierDid, label: profile.label },
    spaceId: profile.spaceId!,
    peer,
    callMe,
    delegation: serializeDelegation(delegation),
    delegationExpiresAt: delegation.expiry instanceof Date ? delegation.expiry.toISOString() : new Date(delegation.expiry).toISOString(),
    issuedAt: new Date().toISOString(),
  };
}

/** Peer-record body stored at `me/peers/<handle>.json`; portable grants stay local. */
export function peerRecordBody(peer: StoredPeer) {
  return {
    courierPeer: true,
    handle: peer.handle,
    ownerDid: peer.ownerDid,
    courierDid: peer.courierDid,
    label: peer.label,
    spaceId: peer.spaceId,
    theirHandleForMe: peer.theirHandleForMe,
    inbound: peer.inbound ? { cid: peer.inbound.cid, expiresAt: peer.inbound.expiresAt } : undefined,
    outbound: peer.outbound,
    pairedAt: peer.pairedAt,
    status: peer.status,
  };
}
