import { randomBytes } from 'node:crypto';
import {
  TinyCloudNode, NodeWasmBindings, PrivateKeySigner,
} from '@tinycloud/node-sdk';
import { activateSessionWithHost } from '@tinycloud/sdk-core';

export const HOST = process.env.COURIER_FAKE_OPENKEY_HOST ?? 'https://tee.node.tinycloud.xyz';
const PREFIX = 'xyz.tinycloud.courier';
const wasm = new NodeWasmBindings();
const nodeOptions = {
  host: HOST,
  tinycloudFallbackHosts: [HOST],
  autoDiscoverLocalNode: false,
  enablePublicSpace: false,
  autoBootstrapAccount: false,
  includeAccountRegistryPermissions: false,
};
function ownerManifest(space) {
  return {
    app_id: PREFIX,
    name: 'Courier disposable owner',
    space,
    prefix: PREFIX,
    defaults: false,
    includePublicSpace: false,
    expiry: '2h',
    permissions: [
      { service: 'tinycloud.kv', path: '/', actions: ['get', 'put', 'list', 'del', 'metadata'] },
      { service: 'tinycloud.hooks', path: `kv/${PREFIX}/`, actions: ['subscribe'], skipPrefix: true },
    ],
  };
}

async function createOwnerInSpace(space) {
  const privateKey = randomBytes(32).toString('hex');
  const node = new TinyCloudNode({ ...nodeOptions, privateKey, autoCreateSpace: true, manifest: ownerManifest(space) });
  await node.signIn();
  return { node, privateKey, ownerDid: node.did, spaceId: node.spaceId };
}

export async function createOwner() {
  return createOwnerInSpace('agents');
}

export async function createOwnerWithoutAgents() {
  return createOwnerInSpace('default');
}

export async function grantFromRequest(owner, request, extraPermissions = []) {
  const signer = new PrivateKeySigner(owner.privateKey);
  const address = await signer.getAddress();
  const chainId = 1;
  const spaceId = wasm.makeSpaceId(address, chainId, request.space);
  const abilities = {};
  for (const permission of [...request.permissions, ...extraPermissions]) {
    const service = permission.service.replace(/^tinycloud\./, '');
    (abilities[service] ??= {})[permission.path] = permission.actions;
  }
  const now = new Date();
  const expiryMatch = /^(\d+)([smhd])$/.exec(request.expiry ?? '30d');
  if (!expiryMatch) throw new Error(`unsupported fake OpenKey expiry: ${request.expiry}`);
  const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[expiryMatch[2]];
  const expiryMs = Number(expiryMatch[1]) * factor;
  const prepared = wasm.prepareSession({
    abilities,
    address,
    chainId,
    domain: 'courier.fake-openkey',
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + expiryMs).toISOString(),
    spaceId,
    jwk: request.publicJwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const activated = await activateSessionWithHost(HOST, session.delegationHeader);
  if (!activated.success) throw new Error(`fake OpenKey activation failed: ${activated.error}`);
  return {
    delegationHeader: session.delegationHeader,
    delegationCid: session.delegationCid,
    spaceId,
    address,
    chainId,
    siwe: prepared.siwe,
    signature,
    verificationMethod: request.did,
    jwk: request.publicJwk,
  };
}
