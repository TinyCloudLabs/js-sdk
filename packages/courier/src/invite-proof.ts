import {
  RuntimeDelegationRejectedError,
  activateValidatedRuntimeDelegation,
  deserializeDelegation,
  type PermissionEntry,
  type PortableDelegation,
  type RuntimeDelegationActivator,
  type ValidatedRuntimeDelegation,
  type TinyCloudNode,
} from '@tinycloud/node-sdk';
import { activateSessionWithHost } from '@tinycloud/sdk-core';
import { bareDid, assertExactAuthority } from './authority.js';
import { ed25519DidKey } from './did-key.js';
import { CourierError } from './errors.js';
import { ownerMatches, type InviteBlob } from './invite-schema.js';

/**
 * Proof that an invitation's grants come from the inviter the person joining named, checked before `join` grants, claims or writes anything.
 *
 * The invitation is a bearer string anyone can make, so its `from.owner` is only a claim. What cannot be made up is the chain behind the two
 * delegations it carries (the one-time key's `put` and `read`): the host accepts a delegation only when its chain ends at the owner of the space it names.
 * Each delegation is therefore activated at the host (the one-time key is its audience, so the activation runs as that key) and then read back from the
 * signed authority: space, issuer, audience and exact capabilities. Refusals have fixed messages; an unavailable host is distinguished from a grant
 * that does not verify, and nothing from the invitation or the host is printed.
 */

export const INVITER_UNPROVEN = 'inviter-unproven';
export const INVITER_UNCHECKED = 'inviter-unchecked';

const unchecked = (): CourierError =>
  new CourierError(INVITER_UNCHECKED, "Couldn't check the inviter right now. Try again in a few minutes.");

/** The host answers within this, or the proof is unchecked; a join never waits on a silent host. */
export const HOST_TIMEOUT_MS = 15_000;

/** Why the proof failed. A fixed set: the message never carries invitation or host text. */
export type UnprovenReason = 'malformed' | 'space' | 'owner' | 'issuer' | 'audience' | 'authority' | 'host';

export const unproven = (which: 'read' | 'put', reason: UnprovenReason): CourierError =>
  new CourierError(
    INVITER_UNPROVEN,
    `The invitation's ${which} grant does not verify as coming from the inviter you named (${reason}). Nothing was granted, claimed, created or sent.`,
  );

const SPACE_OWNER = /^tinycloud:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40}):/;

/** Production activates at the host; tests can supply an activator or shorten the activation timeout. */
export interface ProofDeps {
  activator?: (blob: InviteBlob) => RuntimeDelegationActivator;
  hostTimeoutMs?: number;
}

/**
 * Acts as the one-time key (the audience of both delegations) and activates a delegation at the invitation's host. Nothing is installed in the joiner's
 * own node: the installed list is local to this proof.
 */
export function oneTimeKeyActivator(node: Pick<TinyCloudNode, 'computeDelegationCid'>, blob: InviteBlob, hostTimeoutMs = HOST_TIMEOUT_MS): RuntimeDelegationActivator {
  const installed: PortableDelegation[] = [];
  return {
    sessionDid: ed25519DidKey(blob.oneTimeKey.x),
    computeDelegationCid: (authorization) => node.computeDelegationCid(authorization),
    getRuntimePermissionDelegations: () => installed,
    async useRuntimeDelegation(delegation) {
      const signal = AbortSignal.timeout(hostTimeoutMs);
      let result;
      try {
        result = await activateSessionWithHost(delegation.host ?? blob.host, delegation.delegationHeader, signal);
        signal.throwIfAborted();
      } catch {
        throw Object.assign(new Error('The host could not be reached.'), { code: 'ACTIVATION_TRANSPORT_FAILED' });
      }
      if (result.status >= 500) throw new Error('The host is unavailable.', { cause: { status: result.status } });
      if (!result.success) throw new Error('The host did not accept the delegation.');
      installed.push(delegation);
    },
  };
}

function expectedAuthority(blob: InviteBlob, which: 'read' | 'put'): PermissionEntry[] {
  return which === 'read'
    ? [{ space: blob.spaceId, service: 'tinycloud.kv', path: blob.outPrefix, actions: ['tinycloud.kv/get', 'tinycloud.kv/list'] }]
    : [{ space: blob.spaceId, service: 'tinycloud.kv', path: blob.helloKey, actions: ['tinycloud.kv/put'] }];
}

async function proveOne(
  activator: RuntimeDelegationActivator,
  blob: InviteBlob,
  expectedInviter: string,
  which: 'read' | 'put',
): Promise<void> {
  let delegation: PortableDelegation;
  try {
    delegation = deserializeDelegation(blob.permissions[which]);
  } catch {
    throw unproven(which, 'malformed');
  }
  // The space is the owner's: its address must be the inviter's, and the transport fields must say the same.
  const space = SPACE_OWNER.exec(blob.spaceId);
  if (delegation.spaceId !== blob.spaceId) throw unproven(which, 'space');
  if (space === null || !ownerMatches(expectedInviter, `did:pkh:eip155:${space[1]}:${space[2]}`)) throw unproven(which, 'owner');
  if (typeof delegation.ownerAddress !== 'string' || delegation.ownerAddress.toLowerCase() !== space[2].toLowerCase()) throw unproven(which, 'owner');

  let active: ValidatedRuntimeDelegation;
  try {
    active = await activateValidatedRuntimeDelegation(activator, delegation, { host: blob.host });
  } catch (error) {
    if (error instanceof RuntimeDelegationRejectedError) {
      if (error.reason === 'activation_unavailable') throw unchecked();
      if (error.reason === 'audience_mismatch') throw unproven(which, 'audience');
      if (error.reason.startsWith('activation_')) throw unproven(which, 'host');
    }
    throw unproven(which, 'malformed');
  }
  if (bareDid(active.delegation.delegatorDID ?? '') !== bareDid(blob.artifactA.from.courier)) throw unproven(which, 'issuer');
  if (bareDid(active.audience) !== bareDid(ed25519DidKey(blob.oneTimeKey.x))) throw unproven(which, 'audience');
  try {
    assertExactAuthority(active.effectivePermissions, expectedAuthority(blob, which), `The invitation's ${which} grant`);
  } catch {
    throw unproven(which, 'authority');
  }
}

/** Refuses with `inviter-unproven` (or `inviter-unchecked` if the host is unavailable) unless both the read and the put delegation of the invitation verify as the named inviter's. Creates nothing. */
export async function proveInviter(node: Pick<TinyCloudNode, 'computeDelegationCid'>, blob: InviteBlob, expectedInviter: string, deps: ProofDeps = {}): Promise<void> {
  const activator = (deps.activator ?? ((b: InviteBlob) => oneTimeKeyActivator(node, b, deps.hostTimeoutMs)))(blob);
  await proveOne(activator, blob, expectedInviter, 'read');
  await proveOne(activator, blob, expectedInviter, 'put');
}
