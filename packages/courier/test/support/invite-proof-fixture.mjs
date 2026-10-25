// Delegations as an invitation carries them (compact UCANs for the one-time key), and the host they are activated at.
// The payload is built the way the SDK reads it (iss, aud, exp, prf, att); the signature is a placeholder, because the chain behind a delegation is
// checked by the host and not by the reader. `StandInHost` plays the host: it accepts exactly the authorizations its owner really issued.
import { inviteFolder } from '../../dist/invite-schema.js';
import { ed25519DidKey } from '../../dist/did-key.js';

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export const ONE_TIME_X = 'A'.repeat(43);
export const ONE_TIME_DID = ed25519DidKey(ONE_TIME_X);

/** One serialized delegation. Every field of the signed payload can be set to something wrong. */
export function delegationText({ inviteId, which, space, issuer, audience = ONE_TIME_DID, path, actions, ownerAddress, transportSpace, expSeconds, host }) {
  const folder = inviteFolder(inviteId);
  const entryPath = path ?? (which === 'read' ? `${folder}out/` : `${folder}in/hello.json`);
  const entryActions = actions ?? (which === 'read' ? ['tinycloud.kv/get', 'tinycloud.kv/list'] : ['tinycloud.kv/put']);
  const exp = expSeconds ?? Math.floor(Date.now() / 1000) + 3600;
  const payload = {
    iss: issuer,
    aud: audience,
    exp,
    prf: ['bafyparent'],
    att: { [`${space}/kv/${entryPath}`]: Object.fromEntries(entryActions.map((action) => [action, [{}]])) },
  };
  const authorization = `${b64({ alg: 'EdDSA', typ: 'JWT' })}.${b64(payload)}.${b64('signature')}`;
  return {
    authorization,
    text: JSON.stringify({
      cid: `cid:${authorization}`,
      delegationHeader: { Authorization: authorization },
      spaceId: transportSpace ?? space,
      path: entryPath,
      actions: entryActions,
      expiry: new Date(exp * 1000).toISOString(),
      ownerAddress,
      chainId: 1,
      delegateDID: audience,
      host,
    }),
  };
}

/** The host: it accepts the authorizations it was told about (a delegation the real owner chain issued) and nothing else; every attempt is recorded. */
export class StandInHost {
  constructor() {
    this.accepted = new Set();
    this.attempts = [];
  }

  /** Marks a delegation as really issued by the owner's chain. */
  issue(delegation) {
    this.accepted.add(delegation.authorization);
    return delegation.text;
  }

  /** `RuntimeDelegationActivator` for the one-time key (or, for a test, another session did). */
  activator(sessionDid = ONE_TIME_DID) {
    const installed = [];
    return {
      sessionDid,
      computeDelegationCid: (authorization) => `cid:${authorization}`,
      getRuntimePermissionDelegations: () => installed,
      useRuntimeDelegation: async (delegation) => {
        this.attempts.push(delegation.delegationHeader.Authorization);
        if (!this.accepted.has(delegation.delegationHeader.Authorization)) throw new Error('chain does not end at the space owner');
        installed.push(delegation);
      },
    };
  }
}

/** Both delegations an honest owner's courier issues for an invitation, already known to the host. */
export function honestPermissions(host, { inviteId, space, courier, ownerAddress }) {
  const make = (which) => host.issue(delegationText({ inviteId, which, space, issuer: courier, ownerAddress }));
  return { put: make('put'), read: make('read'), hooks: 'H' };
}
