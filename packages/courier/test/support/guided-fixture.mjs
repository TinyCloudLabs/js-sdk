import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, createPublicKey, verify } from 'node:crypto';
import { NodeWasmBindings, PrivateKeySigner } from '@tinycloud/node-sdk';
import { checkLinkRecord, linkIssuerPublicKey } from '@tinycloud/share-envelope/links';
import { canonicalize } from '@tinycloud/share-envelope';
import { AGENT_GRANT, COURIER_SPACE } from '../../dist/keys.js';

const wasm = new NodeWasmBindings();
const bare = (did) => did.split('#')[0];
const payloadOf = (authorization) => JSON.parse(Buffer.from(authorization.replace(/^Bearer /, '').split('.')[1], 'base64url').toString());

export async function createGuidedFixture(root, cli = new URL('../../dist/cli.js', import.meta.url).pathname) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const cert = path.join(root, 'cert.pem');
  const key = path.join(root, 'tls-key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const values = new Map();
  const delegations = new Map();
  const rootAuthorizations = new Map();
  const links = new Map();
  const requests = [];
  const children = new Set();
  let version = 0;
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)); };
  const publicKey = (did) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(linkIssuerPublicKey(bare(did))).toString('base64url') }, format: 'jwk' });
  function compact(authorization) {
    const token = authorization.replace(/^Bearer /, '');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('compact token required');
    const data = payloadOf(token);
    if (!verify(null, Buffer.from(parts.slice(0, 2).join('.')), publicKey(data.iss), Buffer.from(parts[2], 'base64url'))) throw new Error('bad UCAN signature');
    if (data.exp * 1000 <= Date.now()) throw new Error('expired UCAN');
    return data;
  }
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const url = new URL(req.url, 'https://127.0.0.1');
    const authorization = req.headers.authorization ?? '';
    try {
      if (url.pathname === '/delegate') {
        const cid = rootAuthorizations.get(authorization) ?? wasm.computeCid(new TextEncoder().encode(authorization.replace(/^Bearer /, '')), 0x55n);
        if (!delegations.has(cid)) {
          const data = compact(authorization);
          const parents = data.prf?.map((id) => delegations.get(id));
          if (!parents?.length || parents.some((parent) => !parent || bare(parent.aud) !== bare(data.iss))) throw new Error('unverified delegation parent');
          // Real signature, audience and parent provenance are checked here; the SDK validates attenuation before import.
          delegations.set(cid, data);
        }
        requests.push({ route: 'delegate', cid });
        return send(res, 200, { activated: ['agents'], skipped: [] });
      }
      if (url.pathname === '/v1/links' && req.method === 'POST') {
        const record = JSON.parse(bytes.toString());
        await checkLinkRecord(record, Date.now());
        const id = 'a'.repeat(24) + ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'][Math.floor(links.size / 8)] + ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'][links.size % 8];
        links.set(id, record);
        return send(res, 201, { id, expiresAt: record.header.expiresAt });
      }
      if (url.pathname.startsWith('/v1/links/') && req.method === 'GET') {
        const record = links.get(url.pathname.split('/').at(-1));
        if (!record) return send(res, 404, { error: 'not_found' });
        return send(res, 200, Buffer.from(record.body, 'base64url'), { 'content-type': 'application/octet-stream', 'x-link-record': Buffer.from(canonicalize({ header: record.header, signature: record.signature })).toString('base64url') });
      }
      if (url.pathname !== '/invoke') return send(res, 404, { error: 'not_found' });
      const invocation = compact(authorization);
      requests.push({ route: 'invoke', payload: invocation, headers: req.headers });
      const entries = Object.entries(invocation.att ?? {});
      if (entries.length !== 1) throw new Error(`unsupported invocation payload ${JSON.stringify(invocation)}`);
      const [resource, actions] = entries[0];
      const action = Object.keys(actions)[0];
      const at = resource.indexOf('/kv/');
      if (at < 0) throw new Error('KV resource required');
      const space = resource.slice(0, at);
      const item = resource.slice(at + 4);
      const mapKey = space + '/' + item;
      const current = values.get(mapKey);
      if (action === 'tinycloud.kv/list') return send(res, 200, [...values.keys()].filter((name) => name.startsWith(space + '/' + item)).map((name) => name.slice(space.length + 1)));
      if (action === 'tinycloud.kv/get') return current ? send(res, 200, current.bytes, { etag: current.etag }) : send(res, 404, 'Key not found');
      if (action === 'tinycloud.kv/put') {
        if ((req.headers['if-none-match'] === '*' && current) || (req.headers['if-match'] && req.headers['if-match'] !== current?.etag)) return send(res, 412, 'precondition failed');
        const etag = `"${++version}"`;
        values.set(mapKey, { bytes, etag });
        return send(res, 200, '', { etag });
      }
      if (action === 'tinycloud.kv/del') { values.delete(mapKey); return send(res, 200, ''); }
      return send(res, 400, `unsupported action ${action}`);
    } catch (error) {
      requests.push({ route: req.url, refused: error.message });
      return send(res, 403, error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `https://127.0.0.1:${server.address().port}`;
  const envFor = (home) => ({ ...process.env, HOME: home, COURIER_HOME: home, NODE_EXTRA_CA_CERTS: cert, COURIER_LINKS_API_ORIGIN: host, COURIER_LINK_ORIGIN: host });
  async function home(name, ownerPrivateKey = randomBytes(32).toString('hex')) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { mode: 0o700 });
    const manager = wasm.createSessionManager();
    const keyId = manager.createSessionKey('courier');
    const agent = { v: 1, jwk: JSON.parse(manager.jwk(keyId)), did: manager.getDID(keyId), createdAt: new Date().toISOString() };
    const signer = new PrivateKeySigner(ownerPrivateKey);
    const address = await signer.getAddress();
    const spaceId = wasm.makeSpaceId(address, 1, COURIER_SPACE);
    const abilities = {};
    for (const permission of AGENT_GRANT) (abilities[permission.service.replace('tinycloud.', '')] ??= {})[permission.path] = permission.actions;
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: 'courier.test', issuedAt, expirationTime: expiresAt, spaceId, jwk: agent.jwk });
    const signature = await signer.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    const grant = { v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, ownerDid: `did:pkh:eip155:1:${address}`, address, chainId: 1, verificationMethod: agent.did, siwe: prepared.siwe, signature, expiresAt, receivedAt: issuedAt };
    // Only this fixture's actual owner-signed root can start a delegation chain.
    delegations.set(session.delegationCid, { aud: bare(agent.did), att: {} });
    rootAuthorizations.set(session.delegationHeader.Authorization, session.delegationCid);
    const profile = { version: 3, host, openkeyHost: 'https://openkey.so', label: name, courierDid: bare(agent.did), ownerDid: grant.ownerDid, spaceId, grantExpiresAt: expiresAt, status: 'ready', peers: {} };
    for (const [file, value] of [['key.json', agent], ['grant.json', grant], ['profile.json', profile]]) fs.writeFileSync(path.join(dir, file), JSON.stringify(value), { mode: 0o600 });
    return { home: dir, profile, agent, ownerPrivateKey };
  }
  function launch(agent, args) {
    const child = spawn(process.execPath, [cli, ...args], { env: envFor(agent.home), stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    let lineBuffer = '';
    const lines = [];
    const listeners = [];
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      lineBuffer += chunk;
      for (;;) {
        const end = lineBuffer.indexOf('\n');
        if (end < 0) break;
        const line = lineBuffer.slice(0, end); lineBuffer = lineBuffer.slice(end + 1);
        try { const value = JSON.parse(line); lines.push(value); for (const listener of listeners) listener(value); } catch { /* pretty JSON is read on completion */ }
      }
    });
    child.stderr.on('data', (chunk) => stderr += chunk);
    const done = new Promise((resolve) => child.on('close', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr, lines }); }));
    return { child, done, async first() {
      if (lines.length) return lines[0];
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI emitted no JSON line: ${stderr}`)); }, 15000);
        listeners.push((line) => { clearTimeout(timer); resolve(line); });
        void done.then((result) => { if (!lines.length) { clearTimeout(timer); reject(new Error(`CLI exited ${result.code}: ${result.stderr}`)); } });
      });
    } };
  }
  async function run(agent, args) {
    const result = await launch(agent, args).done;
    if (result.code !== 0) throw Object.assign(new Error(result.stderr), { result });
    return JSON.parse(result.stdout);
  }
  return { root, host, cert, values, links, requests, delegations, home, launch, run, envFor, cli,
    async close() { for (const child of children) child.kill(); await new Promise((resolve) => server.close(resolve)); },
  };
}
