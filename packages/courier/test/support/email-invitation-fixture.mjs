// Shared fixtures for the email-invitation tests: a valid email invitation body and the share-link plumbing around it.
import { ulid } from 'ulid';
import { NodeWasmBindings } from '@tinycloud/node-sdk';

export const OWNER = 'did:pkh:eip155:1:0xA2dF5051172C5Bc1D7FdB33ACC30f7B3C3A7efdF';
export const SPACE = 'tinycloud:pkh:eip155:1:0xA2dF5051172C5Bc1D7FdB33ACC30f7B3C3A7efdF:agents';
export const HOST = 'https://node.example';
export const ADDRESS = 'reader@example.com';
export const LINK = 'https://share.example/s/aaaaaaaaaaaaaaaaaaaaaaaaaa#v=4&k=KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK&c=bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const manager = new NodeWasmBindings().createSessionManager();
export const identity = (label) => {
  const keyId = manager.createSessionKey(label);
  return { did: manager.getDID(keyId).split('#')[0], jwk: JSON.parse(manager.jwk(keyId)) };
};
const issuer = identity('issuer');
const relay = identity('relay');
export const ISSUER_DID = issuer.did;

/** The invitation Courier encrypts into the Share envelope. */
export function invitationBody(over = {}) {
  const id = ulid();
  return {
    type: 'courier-invitation', v: 1, id, issuer: issuer.did, host: HOST, mode: 'email', recipient: ADDRESS,
    session: { sessionId: ulid(), subject: 'plan', createdAt: new Date().toISOString() },
    expiresAt: new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000).toISOString(),
    artifact: { type: 'courier-pair', v: 0, step: 'A', from: { owner: OWNER, courier: issuer.did }, spaceId: SPACE, peer: `chat-${id}-recipient`, callMe: `chat-${id}-issuer`, issuedAt: new Date().toISOString() },
    relay: { key: { v: 1, did: relay.did, jwk: relay.jwk }, delegation: 'x' },
    ...over,
  };
}

/** The Share config document the issuer and recipient read; every origin is a loopback-free example host. */
export const shareConfigResponse = () => Response.json({
  version: 'tinycloud.share/config-v2', shareOrigin: 'https://share.example', registryOrigin: 'https://registry.example', credentialsOrigin: 'https://credentials.example',
});
