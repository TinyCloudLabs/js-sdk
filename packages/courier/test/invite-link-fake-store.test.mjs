import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  cidOf, sealInvitation, openInvitation, uploadSealed, fetchSealed, deleteSealed,
  formatInviteString, parseInviteString, MAX_SEALED_BYTES,
} from '../dist/invite-link.js';

const TOKEN = 'DELETE-TOKEN-SECRET-7f3a';
const PLAIN = new TextEncoder().encode('{"v":1,"hello":"world"}');

// In-memory stand-in for the invitation store: upload, fetch and delete by id.
let server;
let origin;
const blobs = new Map();
let nextId = 0;
let force = null; // { status } forces the next response status for any request

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (force) {
        const status = force.status;
        force = null;
        res.writeHead(status).end();
        return;
      }
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && url.pathname === '/api/share-links') {
        const bytes = Buffer.from(JSON.parse(Buffer.concat(chunks).toString('utf8')).ciphertext, 'base64url');
        const id = 'a'.repeat(25) + 'abcdefghijklmnopqrstuvwxyz234567'[nextId++ % 32];
        blobs.set(id, { bytes: new Uint8Array(bytes), token: TOKEN });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, cid: cidOf(bytes), deleteToken: TOKEN }));
        return;
      }
      const m = /^\/api\/share-links\/([a-z0-9]+)$/.exec(url.pathname);
      const entry = m && blobs.get(m[1]);
      if (req.method === 'GET' && entry) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from(entry.bytes));
        return;
      }
      if (req.method === 'DELETE' && entry) {
        if (req.headers.authorization !== `Bearer ${entry.token}`) return res.writeHead(401).end();
        blobs.delete(m[1]);
        return res.writeHead(204).end();
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('seal, upload, fetch, open round-trips the plaintext and the invite string', async () => {
  const { key, sealed } = sealInvitation(PLAIN);
  const up = await uploadSealed(origin, sealed, new Date(Date.now() + 3600e3));
  const parts = { id: up.id, key, cid: up.cid };
  const text = formatInviteString(parts);
  assert.deepEqual(parseInviteString(text), parts);
  const fetched = await fetchSealed(origin, parts.id, parts.cid);
  assert.deepEqual(Buffer.from(openInvitation(fetched, key)), Buffer.from(PLAIN));
});

test('a flipped byte in the sealed data fails to open', () => {
  const { key, sealed } = sealInvitation(PLAIN);
  const tampered = Uint8Array.from(sealed);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => openInvitation(tampered, key), (e) => e.code === 'bad-invite');
});

test('a different key fails to open', () => {
  const { sealed } = sealInvitation(PLAIN);
  const other = sealInvitation(PLAIN).key;
  assert.throws(() => openInvitation(sealed, other), (e) => e.code === 'bad-invite');
});

test('fetch rejects bytes whose content id differs from the invite string', async () => {
  const { sealed } = sealInvitation(PLAIN);
  const up = await uploadSealed(origin, sealed, new Date(Date.now() + 3600e3));
  const wrongCid = cidOf(new TextEncoder().encode('something else'));
  await assert.rejects(fetchSealed(origin, up.id, wrongCid), (e) => e.code === 'bad-invite');
});

test('a missing invitation surfaces as invite-gone', async () => {
  const { sealed } = sealInvitation(PLAIN);
  const cid = cidOf(sealed);
  await assert.rejects(fetchSealed(origin, 'zzzzzzzzzzzzzzzzzzzzzzzzzz', cid), (e) => e.code === 'invite-gone');
  await assert.rejects(deleteSealed(origin, 'zzzzzzzzzzzzzzzzzzzzzzzzzz', TOKEN), (e) => e.code === 'invite-gone');
});

test('store rate limiting maps to invite-rate-limited', async () => {
  const { sealed } = sealInvitation(PLAIN);
  force = { status: 429 };
  await assert.rejects(uploadSealed(origin, sealed, new Date(Date.now() + 3600e3)), (e) => e.code === 'invite-rate-limited');
});

test('error messages never include the delete token', async () => {
  const { sealed } = sealInvitation(PLAIN);
  const up = await uploadSealed(origin, sealed, new Date(Date.now() + 3600e3));
  await assert.rejects(deleteSealed(origin, up.id, 'wrong-token'), (e) => {
    assert.ok(!String(e.message).includes(TOKEN));
    return e.code === 'invite-store-error';
  });
  await deleteSealed(origin, up.id, TOKEN);
});

test('oversize sealed data is refused before any request is made', async () => {
  const big = new Uint8Array(MAX_SEALED_BYTES + 1);
  await assert.rejects(uploadSealed('http://127.0.0.1:9', big, new Date(Date.now() + 3600e3)), (e) => e.code === 'invite-too-large');
});

test('invite string parser rejects malformed input as bad-invite', () => {
  assert.throws(() => parseInviteString('tcinvite1:short:key:cid'), (e) => e.code === 'bad-invite');
  assert.throws(() => parseInviteString('not an invite'), (e) => e.code === 'bad-invite');
});
