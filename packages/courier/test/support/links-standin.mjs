// A stand-in for the links API: a plain http server on loopback that keeps records in memory. It accepts what the contract accepts and nothing else, using
// the SDK's own checks (`validateLinkHeader`, `checkLinkHeaderLife`, `checkLinkBody`, `verifyHeader`, `verifyDelete`): a create with a bad signature, a
// header outside the life window, a body over the cap or a hash that does not match is refused with the contract's error, exactly as the service would.
// The client under test reaches it through `fetch`, which rewrites the https API origin the SDK insists on to the loopback server. No other network.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { canonicalize, computeCid, fromBase64Url, toBase64Url } from '@tinycloud/share-envelope';
import {
  LINK_ID_PATTERN,
  LinkError,
  checkLinkBody,
  checkLinkHeaderLife,
  validateLinkDeleteRequest,
  validateLinkHeader,
  verifyDelete,
  verifyHeader,
} from '@tinycloud/share-envelope/links';

export const API_ORIGIN = 'https://api.links.test';
export const VIEWER_ORIGIN = 'https://share.links.test';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const newId = () => Array.from(randomBytes(26), (b) => BASE32[b & 31]).join('');

const MAX_REQUEST_BYTES = 100_000;

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new LinkError('response_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `now` is the service clock (epoch ms). `requests` logs every call as `{ method, path, status, reason? }` where `reason` is the SDK error code of a refusal.
 * `records` maps a link id to what was stored. `fail(status, times)` makes the next calls answer that status without touching state.
 */
export async function startLinksApi({ now = () => Date.now() } = {}) {
  const records = new Map();
  const requests = [];
  let forced = null;

  const server = http.createServer(async (req, res) => {
    const entry = { method: req.method, path: req.url, status: 0 };
    requests.push(entry);
    const send = (status, headers = {}, body = '') => {
      entry.status = status;
      res.writeHead(status, headers);
      res.end(body);
    };
    const refuse = (status, code) => {
      entry.reason = code;
      send(status, { 'content-type': 'application/json' }, JSON.stringify({ error: status === 404 ? 'not_found' : 'invalid_request' }));
    };
    try {
      if (forced !== null && forced.times > 0) {
        forced.times -= 1;
        await readBody(req).catch(() => undefined);
        return send(forced.status, { 'content-type': 'application/json' }, JSON.stringify({ error: 'forced' }));
      }
      const url = new URL(req.url, 'http://standin.invalid');
      if (req.method === 'POST' && url.pathname === '/v1/links') {
        const record = JSON.parse(await readBody(req));
        const header = validateLinkHeader(record.header, { mode: 'signed', audience: API_ORIGIN });
        if (Object.keys(record).sort().join(',') !== 'body,header,signature') throw new LinkError('record_fields');
        checkLinkHeaderLife(header, now());
        const body = fromBase64Url(record.body);
        checkLinkBody(header, body, await computeCid(body));
        if (!verifyHeader(header, record.signature)) throw new LinkError('bad_signature');
        const id = newId();
        records.set(id, { header, signature: record.signature, body, type: header.type });
        return send(201, { 'content-type': 'application/json' }, JSON.stringify({ id, expiresAt: header.expiresAt }));
      }
      const read = /^\/v1\/links\/([a-z2-7]{26})$/.exec(url.pathname);
      if (req.method === 'GET' && read) {
        const stored = records.get(read[1]);
        if (stored === undefined || Date.parse(stored.header.expiresAt) <= now()) return refuse(404, 'not_found');
        const text = canonicalize({ header: stored.header, signature: stored.signature });
        return send(200, { 'content-type': 'application/octet-stream', 'x-link-record': toBase64Url(new TextEncoder().encode(text)) }, stored.body);
      }
      const del = /^\/v1\/links\/([a-z2-7]{26})\/delete$/.exec(url.pathname);
      if (req.method === 'POST' && del) {
        const { request, signature } = JSON.parse(await readBody(req));
        const checked = validateLinkDeleteRequest(request, { audience: API_ORIGIN });
        if (!LINK_ID_PATTERN.test(del[1]) || checked.id !== del[1]) throw new LinkError('id_mismatch');
        if (!verifyDelete(checked, signature)) throw new LinkError('bad_signature');
        const stored = records.get(del[1]);
        // Unknown, expired and someone else's link answer the same 404: the service does not say which.
        if (stored === undefined || stored.header.issuer !== checked.issuer) return refuse(404, 'not_found');
        records.delete(del[1]);
        return send(204);
      }
      return refuse(404, 'no_route');
    } catch (error) {
      return refuse(400, error instanceof LinkError ? error.code : 'malformed');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** The `fetch` a client under test is given: the https API origin goes to the loopback server; any other URL is refused. */
  const standInFetch = (url, init) => {
    const target = String(url);
    if (!target.startsWith(`${API_ORIGIN}/`)) throw new Error(`stand-in: refusing a request outside the API origin (${target.slice(0, 40)})`);
    return fetch(`${base}${target.slice(API_ORIGIN.length)}`, init);
  };

  return {
    apiOrigin: API_ORIGIN,
    viewerOrigin: VIEWER_ORIGIN,
    fetch: standInFetch,
    /** A LinksConfig for the code under test. */
    config: { apiOrigin: API_ORIGIN, viewerOrigin: VIEWER_ORIGIN, fetch: standInFetch },
    records,
    requests,
    fail(status, times = 1) {
      forced = { status, times };
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
