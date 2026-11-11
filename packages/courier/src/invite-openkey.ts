import { createDecipheriv, createECDH, createHash, createHmac, createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { buildShareInvitationApprovalSpec, createApprovalRequest, signerFromJwk } from '@tinycloud/share-envelope/links';
import type { Ed25519PrivateJwk, LinkRecord, OpenKeyApprovalRequestV1 } from '@tinycloud/share-envelope/links';
import { CourierError } from './errors.js';
import { resolveOpenKeyApiHost } from './grant.js';
import type { GrantPayload } from './grant.js';
import type { InviteApprovalTransport, PendingInvite } from './invite-approval.js';
import type { AgentKey } from './profile.js';
import { loadProfile } from './profile.js';

const DEFAULT_LINKS_API = 'https://api.tinycloud.xyz';

/** What is kept between runs for one approval request. The relay private key never leaves this file. */
interface RequestState {
  requestId: string;
  bodyCid: string;
  record: LinkRecord;
  request: OpenKeyApprovalRequestV1;
  apiOrigin: string;
  relayPrivateKey: string;
  ackId: string;
  resultRef?: string;
  resultEnvelope?: unknown;
  resultExpiresAt?: string;
}

type Action = 'discover' | 'fetch' | 'ack';

const unavailable = (message: string): CourierError => new CourierError('approval-unavailable', message);

function origin(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw unavailable(`${label} is not an origin.`); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw unavailable(`${label} must be an HTTPS origin.`);
  return url.origin;
}

function sessionProof(state: RequestState, key: AgentKey, action: Action, resultRef: string, ackId: string): string {
  const jwk = key.jwk as unknown as Ed25519PrivateJwk;
  const jkt = createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: jwk.x })).digest('base64url');
  const path = action === 'discover' ? `/api/approval-requests/${state.requestId}/result` : `/api/approval-results/${resultRef}/${action}`;
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: jkt, typ: 'openkey-session-proof+jwt' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    client_id: 'openkey-approval-result-v1',
    cred_hash: createHash('sha256').update(JSON.stringify([action, state.requestId, state.bodyCid, resultRef, ackId])).digest('base64url'),
    htm: 'POST', htu: state.apiOrigin + path, iat: Math.floor(Date.now() / 1000), jti: randomBytes(24).toString('base64url'),
  })).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(input), createPrivateKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }, format: 'jwk' }));
  return `${input}.${signature.toString('base64url')}`;
}

function canonicalB64(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw unavailable('OpenKey returned an invalid result.');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw unavailable('OpenKey returned an invalid result.');
  return decoded;
}

/** The result is AES-GCM under an ECDH-P-256 key only this request's relay key can derive. Node's ECDH refuses off-curve points. */
function decryptResult(envelope: unknown, requestId: string, relay: ReturnType<typeof createECDH>): Record<string, unknown> {
  const value = envelope as { version?: unknown; algorithm?: unknown; ephemeralPublicJwk?: { x?: unknown; y?: unknown }; nonce?: unknown; ciphertext?: unknown } | null;
  if (!value || value.version !== 1 || value.algorithm !== 'ECDH-P256-A256GCM') throw unavailable('OpenKey returned an unsupported result.');
  const x = canonicalB64(value.ephemeralPublicJwk?.x);
  const y = canonicalB64(value.ephemeralPublicJwk?.y);
  const nonce = canonicalB64(value.nonce);
  const ciphertext = canonicalB64(value.ciphertext);
  if (x.length !== 32 || y.length !== 32 || nonce.length !== 12 || ciphertext.length <= 16) throw unavailable('OpenKey returned an invalid result.');
  let secret: Buffer;
  try { secret = relay.computeSecret(Buffer.concat([Buffer.from([4]), x, y])); } catch { throw unavailable('OpenKey returned an invalid result key.'); }
  const extracted = createHmac('sha256', Buffer.from(requestId)).update(secret).digest();
  const aesKey = createHmac('sha256', extracted).update(Buffer.from('openkey-device-relay-v1')).update(Buffer.from([1])).digest();
  const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAAD(Buffer.from(requestId));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  try {
    const opened: unknown = JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8'));
    if (opened && typeof opened === 'object' && !Array.isArray(opened)) return opened as Record<string, unknown>;
  } catch { /* falls through */ }
  throw unavailable('OpenKey returned an unreadable result.');
}

export interface OpenKeyInviteDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * The OpenKey side of one invitation approval: a signed intent request, then repeatable requester-authenticated reads of
 * its encrypted result. Result verification beyond the binding to this request (holder, owner, key, expiry) is done by
 * the caller from the signed SIWE, never from anything the transport reports.
 */
export function openKeyInviteTransport(deps: OpenKeyInviteDeps = {}): InviteApprovalTransport & { acknowledge(pending: PendingInvite, key: AgentKey): Promise<void> } {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const post = async (state: RequestState, key: AgentKey, action: Action): Promise<Response> => {
    const resultRef = action === 'discover' ? '' : state.resultRef ?? '';
    const path = action === 'discover' ? `/api/approval-requests/${state.requestId}/result` : `/api/approval-results/${resultRef}/${action}`;
    const body = action === 'discover'
      ? { bodyCid: state.bodyCid, header: state.record.header, signature: state.record.signature }
      : { requestId: state.requestId, bodyCid: state.bodyCid, ...(action === 'ack' ? { ackId: state.ackId } : {}) };
    return fetchFn(state.apiOrigin + path, {
      method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'content-type': 'application/json', 'OpenKey-Session-Proof': sessionProof(state, key, action, resultRef, action === 'ack' ? state.ackId : '') },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
  };
  return {
    async create({ context, key, host }) {
      const profile = loadProfile();
      const openkeyOrigin = origin(profile.openkeyHost, 'OpenKey');
      const apiOrigin = origin(resolveOpenKeyApiHost({ env: process.env.COURIER_OPENKEY_API_HOST, openkeyHost: openkeyOrigin }), 'OpenKey API');
      const jwk = key.jwk as unknown as Ed25519PrivateJwk;
      const signer = signerFromJwk(jwk);
      const spec = buildShareInvitationApprovalSpec({ targetDid: signer.did, targetPublicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, nodeOrigin: host, context, now: now() });
      const relay = createECDH('prime256v1');
      relay.generateKeys();
      const point = relay.getPublicKey();
      const request = { ...spec, resultEncryptionPublicJwk: { kty: 'EC' as const, crv: 'P-256' as const, x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } };
      let created;
      try {
        created = await createApprovalRequest({ request, issuerKey: signer, apiOrigin: origin(process.env.COURIER_LINKS_API_ORIGIN ?? DEFAULT_LINKS_API, 'Links API'),
          openkeyOrigin, expiresAt: new Date(context.acceptanceExpiresAt), now: now(), fetch: fetchFn });
      } catch { throw unavailable('The approval request could not be created.'); }
      const state: RequestState = { requestId: created.id, bodyCid: created.bodyCid, record: created.record, request, apiOrigin,
        relayPrivateKey: relay.getPrivateKey().toString('base64url'), ackId: randomUUID() };
      return { approvalUrl: created.link, transport: state as unknown as Record<string, unknown> };
    },
    async poll(pending, key) {
      const state = pending.transport as unknown as RequestState | undefined;
      if (!state) throw unavailable('No approval request exists for this invitation.');
      if (!state.resultEnvelope) {
        let response: Response;
        try { response = await post(state, key, 'discover'); } catch { return { status: 'pending' }; }
        if (response.status === 202) return { status: 'pending' };
        if (!response.ok) {
          const code = ((await response.clone().json().catch(() => null)) as { code?: unknown } | null)?.code;
          if (code === 'expired_request' || code === 'expired_result') return { status: 'expired' };
          if (code === 'denied') return { status: 'denied' };
          if (code === 'not_found' || code === 'request_binding' || code === 'invalid_proof') throw unavailable('OpenKey does not recognise this approval request.');
          return { status: 'pending' };
        }
        const found = await response.json() as { resultRef?: unknown; expiresAt?: unknown };
        if (typeof found.resultRef !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(found.resultRef) || typeof found.expiresAt !== 'string') throw unavailable('OpenKey returned an invalid result reference.');
        state.resultRef = found.resultRef;
        state.resultExpiresAt = found.expiresAt;
        let fetched: Response;
        try { fetched = await post(state, key, 'fetch'); } catch { return { status: 'pending' }; }
        if (!fetched.ok) return { status: 'pending' };
        const result = await fetched.json() as Record<string, unknown>;
        if (result.requestId !== state.requestId || result.bodyCid !== state.bodyCid || result.resultRef !== state.resultRef || result.expiresAt !== state.resultExpiresAt || !result.relay) {
          throw unavailable('The approval result does not match this request.');
        }
        state.resultEnvelope = result.relay;
      }
      const relay = createECDH('prime256v1');
      relay.setPrivateKey(Buffer.from(state.relayPrivateKey, 'base64url'));
      const opened = decryptResult(state.resultEnvelope, state.requestId, relay);
      const delegation = opened.delegation as Record<string, unknown> | undefined;
      if (opened.resultVersion !== 1 || opened.requestId !== state.requestId || opened.requestDigest !== state.bodyCid
        || opened.requesterDid !== state.request.issuer || opened.targetDid !== state.request.targetDid || !delegation || typeof delegation !== 'object') {
        throw new CourierError('bad-grant', 'The approval result does not belong to this request.');
      }
      return { status: 'approved', payload: delegation as unknown as GrantPayload };
    },
    async acknowledge(pending, key) {
      const state = pending.transport as unknown as RequestState | undefined;
      if (!state?.resultRef) return;
      try { await post(state, key, 'ack'); } catch { /* the stored approval is already committed; OpenKey may be told on the next run */ }
    },
  };
}
