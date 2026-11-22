import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { bases } from 'multiformats/basics';
import { SiweMessage } from 'siwe';
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from '@tinycloud/node-sdk';
import { DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL, REGISTRY_NOT_FOUND_BODY, parseSignedSiweCacao } from '@tinycloud/sdk-core';
import { RenewalAuthorityInactiveError } from '@tinycloud/sdk-core/delegations/renewal';
import { checkLinkRecord, type LinkRecord } from '@tinycloud/share-envelope/links';
import { encodeDagCbor } from '../../sdk-core/src/delegations/cacao';
import { AGENT_GRANT, COURIER_DEFAULT_LEASE_SECONDS, COURIER_SPACE } from '../src/keys';
import type { PendingGrantRequest } from '../src/approval-phase';

// TC-3522: an owner who approves the default lease ask gets a grant whose lease is verified, admitted at the node and saved
// beside it. Synthetic owner, agent key, node and lease only: this file's fetch stands in for the links API, OpenKey and the node.
const home = fs.mkdtempSync('/var/tmp/tc3522-courier-leased-');
fs.chmodSync(home, 0o700);
Object.assign(process.env, {
  COURIER_HOME: path.join(home, 'courier'), COURIER_TEST: '1', COURIER_TEST_HOME: home,
  TC_LINKS_API_ORIGIN: 'https://links.fixture.test', COURIER_OPENKEY_API_HOST: 'https://api.openkey.fixture.test',
});
// Imported after COURIER_HOME is set, so no module resolves a real profile directory.
const { main } = await import('../src/main');
const { courierNode } = await import('../src/node');
const { loadProfile } = await import('../src/profile');
const { preflightOwner } = await import('../src/interim-owner');
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const LINKS = 'https://links.fixture.test';
const OPENKEY_API = 'https://api.openkey.fixture.test';
const NODE = 'https://node.fixture.test';
const wasm = new NodeWasmBindings();
const owner = new PrivateKeySigner(randomBytes(32).toString('hex'));
const address = await owner.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const renewerPublicKey = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
const renewerDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...renewerPublicKey]))}`;
const nodeIdentity = { nodeDid: renewerDid, renewerDid, renewerPublicKey: Buffer.from(renewerPublicKey).toString('base64url'), renewerEpoch: 0 };
const readHome = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(process.env.COURIER_HOME!, name), 'utf8')) as T;

/** The owner's grant to the Courier key, as OpenKey signs it for the requested lifetime. */
async function signedGrant(lifetimeSeconds: number) {
  const agent = readHome<{ jwk: Record<string, string>; did: string }>('key.json');
  const spaceId = wasm.makeSpaceId(address, 1, COURIER_SPACE);
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const permission of AGENT_GRANT) ((abilities[permission.service.replace(/^tinycloud\./, '')] ??= {})[permission.path] ??= []).push(...permission.actions);
  const issuedAt = new Date();
  const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.fixture.test', issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + lifetimeSeconds * 1000).toISOString(), spaceId, jwk: agent.jwk });
  const signature = await owner.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const { d: _private, ...publicJwk } = agent.jwk;
  return { delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, address, chainId: 1,
    siwe: prepared.siwe, signature, verificationMethod: agent.did, jwk: publicJwk };
}

/** The owner-signed lease that lets the node renew `target` for `leaseSeconds` from the approval, as OpenKey returns it. */
async function renewalFor(target: string, leaseSeconds: number) {
  const issuedAt = new Date(Date.now() - 1000).toISOString();
  const approvedAt = new Date(Date.now() - 500).toISOString();
  const end = new Date(Date.now() + leaseSeconds * 1000 - 60_000);
  end.setUTCMilliseconds(0);
  const expiresAt = end.toISOString();
  const resource = `urn:cid:${target}`;
  const statement = `I further authorize the stated URI to perform the following actions on my behalf: (1) 'tinycloud.delegation': 'renew' for '${resource}'.`;
  const resources = [`urn:recap:${Buffer.from(JSON.stringify({ att: { [resource]: { 'tinycloud.delegation/renew': [{}] } }, prf: [] })).toString('base64url')}`];
  const message = new SiweMessage({ domain: 'localhost', address, uri: renewerDid, version: '1', chainId: 1,
    nonce: '12345678', issuedAt, expirationTime: expiresAt, statement, resources }).prepareMessage();
  const signature = await owner.signMessage(message);
  const leaseAuthorization = Buffer.from(encodeDagCbor({ h: { t: 'eip4361' }, p: { domain: 'localhost', iss: ownerDid,
    aud: renewerDid, version: 1, nonce: '12345678', iat: issuedAt, exp: expiresAt, statement, resources },
    s: { t: 'eip191', s: new Uint8Array(Buffer.from(signature.slice(2), 'hex')) } })).toString('base64url');
  const lease = await parseSignedSiweCacao(leaseAuthorization);
  return { version: 1 as const, approvedAt, approvedLeaseLifetimeSeconds: leaseSeconds, receipt: {
    originalCid: target, leaseCid: lease.cid, leaseAuthorization, leaseExpiresAt: expiresAt, leaseGeneration: 1, nodeIdentity } };
}

/** The result envelope OpenKey relays: ECDH-P256 to the request's relay key, AES-256-GCM bound to the request id. */
function sealRelay(publicJwk: { x: string; y: string }, requestId: string, plaintext: unknown) {
  const ephemeral = createECDH('prime256v1');
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x, 'base64url'), Buffer.from(publicJwk.y, 'base64url')]));
  const extracted = createHmac('sha256', Buffer.from(requestId)).update(shared).digest();
  const key = createHmac('sha256', extracted).update('openkey-device-relay-v1').update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(requestId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const point = ephemeral.getPublicKey();
  return { version: 1, algorithm: 'ECDH-P256-A256GCM',
    ephemeralPublicJwk: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
    nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

test('a leased approval is verified, admitted at the node and saved with the grant; every Courier file is 0600', async () => {
  const admitted: string[] = [];
  const acks: string[] = [];
  let relay: unknown;
  const resultExpiresAt = new Date(Date.now() + 600_000).toISOString();
  const realFetch = globalThis.fetch;
  const kv = Object.getOwnPropertyDescriptor(TinyCloudNode.prototype, 'kv')!;
  Object.defineProperty(TinyCloudNode.prototype, 'kv', { configurable: true, get: () => ({ list: async () => ({ ok: true, data: { keys: [] } }) }) });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, string> : {};
    if (url === `${LINKS}/v1/links`) {
      const checked = await checkLinkRecord(body as unknown as LinkRecord, Date.now());
      return Response.json({ id: 'leasedrequestabcdefghijklm', expiresAt: checked.header.expiresAt }, { status: 201 });
    }
    if (url === `${NODE}/info`) return Response.json({ nodeId: nodeIdentity.nodeDid });
    if (url === `${NODE}/.well-known/tinycloud/node-keys`) return Response.json(nodeIdentity);
    // The owner has no registry entry, so the configured host is used (as registry-fixture.mjs answers it).
    if (new URL(url).origin === new URL(DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL).origin && /^\/v[12]\/locations\/[^/]+$/.test(new URL(url).pathname)) {
      return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404, headers: { 'content-type': 'application/json' } });
    }
    if (url === `${NODE}/delegate`) {
      admitted.push(new Headers(init?.headers).get('Authorization') ?? '');
      return Response.json({ cid: 'admitted', activated: [] });
    }
    if (!url.startsWith(`${OPENKEY_API}/api/approval-`)) throw new Error(`unexpected network call: ${url}`);
    const pending = readHome<PendingGrantRequest>('approval-pending.json');
    if (url.includes('/api/approval-requests/')) return Response.json({ resultRef: 'leased-result-reference-123456', expiresAt: resultExpiresAt });
    if (url.endsWith('/fetch')) {
      return Response.json({ requestId: pending.requestId, bodyCid: pending.bodyCid, resultRef: 'leased-result-reference-123456', expiresAt: resultExpiresAt, relay });
    }
    acks.push(body.ackId!);
    return Response.json({ ackId: body.ackId, status: 'acknowledged' });
  }) as typeof fetch;
  try {
    expect(await main(['init', '--request', '--host', NODE])).toBe(0);
    const pending = readHome<PendingGrantRequest>('approval-pending.json');
    expect(pending.request.renewal).toEqual({ version: 1, leaseLifetimeSeconds: COURIER_DEFAULT_LEASE_SECONDS });

    const grant = await signedGrant(pending.request.grantLifetimeSeconds);
    const renewal = await renewalFor(grant.delegationCid, COURIER_DEFAULT_LEASE_SECONDS);
    const delegationExpiresAt = new Date(Date.parse(grant.siwe.match(/^Expiration Time:\s*(.+)$/m)![1]!)).toISOString();
    relay = sealRelay(pending.request.resultEncryptionPublicJwk as { x: string; y: string }, pending.requestId, {
      resultVersion: 1, requestId: pending.requestId, requestDigest: pending.bodyCid, requesterDid: pending.request.issuer, ownerDid,
      targetDid: pending.request.targetDid, delegationExpiresAt, delegation: grant, renewalChoice: 'leased', renewal });

    expect(await main(['init', '--wait'])).toBe(0);
    const saved = readHome<{ renewal?: unknown; renewalChoice?: string; delegationCid: string }>('grant.json');
    expect(saved.delegationCid).toBe(grant.delegationCid);
    expect(saved.renewal).toEqual(renewal);
    expect(saved.renewalChoice).toBeUndefined();
    expect(admitted).toEqual([renewal.receipt.leaseAuthorization]);
    expect(acks).toHaveLength(1);
    for (const file of fs.readdirSync(process.env.COURIER_HOME!)) {
      const stat = fs.statSync(path.join(process.env.COURIER_HOME!, file));
      if (stat.isFile()) expect([file, stat.mode & 0o777]).toEqual([file, 0o600]);
    }
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(TinyCloudNode.prototype, 'kv', kv);
  }
});

test('a leased grant holds to its signed end until the node renews it, and is not restored once the node reports it revoked', async () => {
  // Uses the grant and lease the previous test installed.
  const saved = readHome<{ siwe: string; delegationCid: string }>('grant.json');
  const signedEnd = new Date(saved.siwe.match(/^Expiration Time:\s*(.+)$/m)![1]!);
  const statusCalls: string[] = [];
  let status: Record<string, unknown> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${NODE}/delegation/status`) {
      const { cid } = JSON.parse(String(init?.body)) as { cid: string };
      statusCalls.push(cid);
      return Response.json({ cid, ...status });
    }
    if (url === `${NODE}/info`) return Response.json({ nodeId: nodeIdentity.nodeDid });
    if (url === `${NODE}/.well-known/tinycloud/node-keys`) return Response.json(nodeIdentity);
    if (new URL(url).origin === new URL(DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL).origin && /^\/v[12]\/locations\/[^/]+$/.test(new URL(url).pathname)) {
      return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected network call: ${url}`);
  }) as typeof fetch;
  try {
    // Not renewed yet: no renewal to restore through, so the grant restores as signed and delegates no further than its end.
    status = { status: 'active', exists: true, active: true, revoked: false, expired: false, effective_expiry: Math.floor(signedEnd.getTime() / 1000), renewal_history: [] };
    const node = await courierNode(loadProfile());
    expect(statusCalls).toEqual([saved.delegationCid]);
    expect(node.sessionEnd?.toISOString()).toBe(signedEnd.toISOString());

    status = { status: 'revoked', exists: true, active: false, revoked: true, expired: false };
    await expect(courierNode(loadProfile())).rejects.toBeInstanceOf(RenewalAuthorityInactiveError);
    expect(await preflightOwner()).toEqual({ state: 'approval-unavailable' });
  } finally {
    globalThis.fetch = realFetch;
  }
});
