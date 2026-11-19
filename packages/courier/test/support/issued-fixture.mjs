// TC2746 fixture API upgrade, authorized by Naomi 9dd22946 for authority.test.mjs,
// inbound-renewal.test.mjs, pairing-renew-guards.test.mjs and pairing-same-owner.test.mjs.
// This is not the real-node matrix: compact signatures/CIDs are checked, while the host remains a fixture.
import { NodeWasmBindings } from '@tinycloud/node-sdk';
import { parseSignedCompactUcanAttenuation } from '@tinycloud/sdk-core';

export function issuedFixture(hits = {}) {
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager(); const id = manager.createSessionKey('fixture-node');
  const nodeId = manager.getDID(id).split('#')[0];
  const records = new Map(); const kv = new Map(); let revision = 0;
  const compact = req => {
    const value = String(req.headers.authorization ?? '').replace(/^Bearer /i, '');
    const verified = parseSignedCompactUcanAttenuation(value);
    return { cid: verified.cid, ...JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8')) };
  };
  const json = (res, body, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  return {
    seed(serialized) {
      const grant = JSON.parse(serialized);
      const verified = parseSignedCompactUcanAttenuation(grant.delegationHeader.Authorization, grant.cid);
      const prefix = Object.keys(verified.payload.att).find(resource => resource.startsWith(`${grant.spaceId}/kv/`));
      if (!prefix || !records.has(grant.cid)) throw new Error('fixture source is not an activated KV child');
      kv.set(`${prefix.replace(/\/$/, '')}/pairing/delegation.json`, { body: JSON.stringify({ v: 0, delegation: serialized }), etag: `"fixture-${++revision}"` });
    },
    age(cid, ms) { const record = records.get(cid); if (!record) throw new Error('unknown fixture child'); record.issuedAt = new Date(Date.now() - ms).toISOString(); },
    async handle(req, res) {
      try {
        if (req.method === 'GET' && req.url === '/.well-known/tinycloud/node-keys') { json(res, { nodeDid: nodeId }); return; }
        if (req.method === 'GET' && req.url === '/info') { json(res, { nodeId, features: ['delegation-issued-query-v1'] }); return; }
        if (req.method === 'POST' && req.url === '/delegate') {
          hits.delegate = (hits.delegate ?? 0) + 1;
          if (String(req.headers.authorization ?? '').split('.').length === 3) {
            const p = compact(req);
            const resources = Object.entries(p.att).map(([resource, actions]) => ({ resource, actions: Object.keys(actions), caveats: Object.values(actions).flat() }));
            records.set(p.cid, { cid: p.cid, direction: 'granted', delegatorDid: p.iss.split('#')[0], delegateDid: p.aud.split('#')[0], resources,
              parents: p.prf, issuedAt: p.nbf ? new Date(p.nbf * 1000).toISOString() : new Date().toISOString(),
              notBefore: p.nbf ? new Date(p.nbf * 1000).toISOString() : null, expiresAt: new Date(p.exp * 1000).toISOString(), status: 'active' });
          }
          json(res, { activated: ['agents'], skipped: [] }); return;
        }
        if (req.method === 'POST' && req.url === '/delegation/query') {
          const p = compact(req); const issuer = p.iss.split('#')[0];
          const scope = `tinycloud:${issuer.slice(4)}:agent/delegation`;
          if (p.prf.length || Object.keys(p.att).length !== 1 || !p.att[scope]?.['tinycloud.delegation/list']) { json(res, {}, 403); return; }
          let body = ''; for await (const chunk of req) body += chunk;
          const options = JSON.parse(body);
          if (options.direction !== 'issued') { json(res, {}, 400); return; }
          const all = [...records.values()].filter(record => record.delegatorDid === issuer && (!options.space || record.resources.every(r => r.resource.startsWith(`${options.space}/`))));
          const offset = Number(options.cursor ?? 0); const limit = options.limit ?? 100;
          json(res, { schemaVersion: 2, items: all.slice(offset, offset + limit), ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}) }); return;
        }
        if (req.method === 'POST' && req.url === '/revoke') {
          const p = compact(req); const resource = Object.keys(p.att)[0]; const cid = resource?.replace(/^urn:cid:/, ''); const record = records.get(cid);
          if (p.prf.length || !record || record.delegatorDid !== p.iss.split('#')[0] || !p.att[resource]?.['tinycloud.delegation/revoke']) { json(res, {}, 403); return; }
          record.status = 'revoked'; record.revokedBy = p.iss; json(res, { revoked: true, cid }); return;
        }
        if (req.method === 'POST' && req.url === '/invoke') {
          hits.invoke = (hits.invoke ?? 0) + 1;
          const p = compact(req); const entries = Object.entries(p.att);
          if (entries.length !== 1 || Object.keys(entries[0][1]).length !== 1) { json(res, {}, 400); return; }
          const [resource, actions] = entries[0]; const action = Object.keys(actions)[0];
          if (!resource.includes('/kv/') || !action.startsWith('tinycloud.kv/')) { json(res, {}, 400); return; }
          const existing = kv.get(resource);
          if (action === 'tinycloud.kv/get') {
            if (!existing) { json(res, { code: 'KV_NOT_FOUND' }, 404); return; }
            res.writeHead(200, { 'content-type': 'application/json', etag: existing.etag }); res.end(existing.body); return;
          }
          if (action === 'tinycloud.kv/put') {
            if ((req.headers['if-none-match'] === '*' && existing) || (req.headers['if-match'] && existing?.etag !== req.headers['if-match'])) { json(res, {}, 412); return; }
            let body = ''; for await (const chunk of req) body += chunk;
            const etag = `"fixture-${++revision}"`; kv.set(resource, { body, etag }); json(res, {}, 200, { etag }); return;
          }
          if (action === 'tinycloud.kv/list') { json(res, { keys: [], truncated: false }); return; }
          if (action === 'tinycloud.kv/del') { kv.delete(resource); json(res, {}); return; }
          if (action === 'tinycloud.kv/metadata') { json(res, {}); return; }
          json(res, {}, 400); return;
        }
        json(res, {}, 404);
      } catch { json(res, { code: 'FIXTURE_REFUSED' }, 403); }
    },
  };
}
