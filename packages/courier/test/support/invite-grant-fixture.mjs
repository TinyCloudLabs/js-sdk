// Real signatures, no hand-built authority objects: an owner wallet signs (a) the Courier agent's main grant and (b) a per-invitation
// grant shaped like OpenKey's (one raw encryption key, a `Request ID:` field in the signed SIWE). The node is a real TinyCloudNode
// restored from the main grant; only the network edge (activating a delegation at the host) is stubbed.
import { randomBytes } from 'node:crypto';
import { REGISTRY_NOT_FOUND_BODY } from '@tinycloud/sdk-core';
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from '@tinycloud/node-sdk';
import { siweTimes, ownerEncryptionNetwork, parseApprovalSiwe } from '../../dist/authority.js';
import { AGENT_GRANT, COURIER_SPACE } from '../../dist/keys.js';
import { nodeOpts } from '../../dist/node.js';

export const HOST = 'https://node.example';
export const DAY = 86_400_000;
export const wasm = new NodeWasmBindings();
const manager = wasm.createSessionManager();

export function newAgent(label = 'agent') {
  const keyId = manager.createSessionKey(`${label}-${randomBytes(4).toString('hex')}`);
  return { v: 1, did: manager.getDID(keyId).split('#')[0], jwk: JSON.parse(manager.jwk(keyId)), createdAt: new Date().toISOString() };
}

export async function newOwner() {
  const signer = new PrivateKeySigner(randomBytes(32).toString('hex'));
  const address = await signer.getAddress();
  return { signer, address, did: `did:pkh:eip155:1:${address}`, space: wasm.makeSpaceId(address, 1, COURIER_SPACE) };
}

export const requestIdOf = () => Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + (byte % 26))).join('');
export const bodyCidOf = () => `bafy${randomBytes(12).toString('hex')}`;
export const shareIdOf = () => randomBytes(16).toString('hex');
export const KEY_ACTIONS = ['tinycloud.encryption/key.create', 'tinycloud.encryption/decrypt'];

const bindingLine = (request) => `Request ID: urn:tinycloud:approval-request:${request.requestId}:${request.bodyCid}`;

/**
 * The owner-signed grant for ONE invitation key, as OpenKey issues it: a raw encryption resource (no space), key.create + decrypt,
 * for `holder`, ending `lifetimeMs` from `issuedAt`. `bind` puts the request's `Request ID:` field into the signed message
 * (a string inserts that exact line; false leaves it out; `lines` adds raw lines for duplicate/malformed cases).
 */
export async function inviteGrant(owner, holder, { shareId = shareIdOf(), request, bind = true, lines = [], lifetimeMs = 3_000_000, issuedAt = new Date(), rawAbilities, networkOwner = owner.did, rewrite } = {}) {
  const network = ownerEncryptionNetwork(networkOwner);
  const prepared = wasm.prepareSession({
    abilities: {}, rawAbilities: rawAbilities ?? { [`${network}/share/${shareId}`]: KEY_ACTIONS },
    address: owner.address, chainId: 1, domain: 'openkey.fixture', issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + lifetimeMs).toISOString(), spaceId: wasm.makeSpaceId(owner.address, 1, 'default'), jwk: holder.jwk,
  });
  let siwe = prepared.siwe;
  const extra = [...(bind && request ? [typeof bind === 'string' ? bind : bindingLine(request)] : []), ...lines];
  if (extra.length > 0) siwe = siwe.replace(/\nResources:/, `\n${extra.join('\n')}\nResources:`);
  // The owner signs the CANONICAL message and the session is completed from that signature. A test may then alter only the raw text handed to the
  // caller (`rewrite`): the original signature, delegation header and CID are kept, which is the shape of the real attack on unchecked bytes.
  const signature = await owner.signer.signMessage(siwe);
  const session = wasm.completeSessionSetup({ ...prepared, siwe, signature });
  let delivered = siwe;
  if (rewrite) {
    // Baseline: what the owner really signed parses strictly; only the delivered text below differs.
    parseApprovalSiwe(siwe);
    delivered = rewrite(siwe, { binding: request ? bindingLine(request) : undefined });
    if (delivered === siwe) throw new Error('rewrite did not change the raw text');
  }
  return {
    shareId,
    payload: { delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId: wasm.makeSpaceId(owner.address, 1, 'default'),
      address: owner.address, chainId: 1, siwe: delivered, signature, verificationMethod: holder.did },
  };
}

/** A real Courier node: the owner's main AGENT_GRANT restored for `agent`, with activation at the host answered locally. */
export async function courierNodeFor(owner, agent, { grantLifetimeMs = 20 * DAY } = {}) {
  const issued = new Date();
  const abilities = {};
  for (const permission of AGENT_GRANT) (abilities[permission.service.replace(/^tinycloud\./, '')] ??= {})[permission.path] = permission.actions;
  const prepared = wasm.prepareSession({
    abilities, address: owner.address, chainId: 1, domain: 'courier.fixture', issuedAt: issued.toISOString(),
    expirationTime: new Date(issued.getTime() + grantLifetimeMs).toISOString(), spaceId: owner.space, jwk: agent.jwk,
  });
  const signature = await owner.signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const node = new TinyCloudNode(nodeOpts(HOST));
  await node.restoreSession({
    delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId: owner.space, jwk: agent.jwk, verificationMethod: agent.did,
    address: owner.address, chainId: 1, siwe: prepared.siwe, signature, expiresAt: siweTimes(prepared.siwe).expiresAt.toISOString(), tinycloudHosts: [HOST],
  });
  return node;
}

/** Answer the node's delegation-activation request locally; everything else is refused. Returns a restore function. */
export function stubActivation() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === HOST && url.pathname === '/delegate') return Response.json({ activated: true });
    // The merged SDK asks the location registry where the owner's node is; the answer 'not registered' falls back to the configured host.
    if (url.origin === 'https://registry.tinycloud.xyz' && /^\/v[12]\/locations\//.test(url.pathname)) return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404, headers: { 'content-type': 'application/json' } });
    throw new Error(`blocked request to ${url.origin}`);
  };
  return () => { globalThis.fetch = original; };
}
