import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  cidOf,
  sealInvitation,
  openInvitation,
  uploadSealed,
  fetchSealed,
  deleteSealed,
  formatInviteString,
  parseInviteString,
  inviteOrigin,
  MAX_SEALED_BYTES,
} from '../dist/invite-link.js';

const HELLO_CID = 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e';

function assertCode(code) {
  return (error) => error?.code === code;
}

/** Local fake of the share-link store. Records every request; never touches the network beyond loopback. */
async function fakeStore(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

test('cidOf matches the known CIDv1 raw sha2-256 vector', () => {
  const cid = cidOf(new TextEncoder().encode('hello world'));
  assert.equal(cid, HELLO_CID);
  assert.equal(cid.length, 59);
});

test('seal then open round-trips and the key is 43 unpadded base64url chars', () => {
  const plain = new TextEncoder().encode('artifact A + one-time key + permission');
  const { key, sealed } = sealInvitation(plain);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(sealed.byteLength, 12 + plain.byteLength + 16);
  assert.deepEqual(Buffer.from(openInvitation(sealed, key)), Buffer.from(plain));
});

test('any single flipped byte in sealed data fails to open', () => {
  const { key, sealed } = sealInvitation(new TextEncoder().encode('payload'));
  for (let i = 0; i < sealed.byteLength; i++) {
    const tampered = Uint8Array.from(sealed);
    tampered[i] ^= 0x01;
    assert.throws(() => openInvitation(tampered, key), assertCode('bad-invite'), `byte ${i}`);
  }
});

test('wrong key fails to open', () => {
  const { sealed } = sealInvitation(new TextEncoder().encode('payload'));
  const other = randomBytes(32).toString('base64url');
  assert.throws(() => openInvitation(sealed, other), assertCode('bad-invite'));
});

test('upload then fetch round-trips through the store and verifies the cid', async () => {
  const sealed = new TextEncoder().encode('sealed-bytes-for-round-trip');
  const expiresAt = new Date('2030-01-02T03:04:05.678Z');
  const store = await fakeStore((req, res, body) => {
    if (req.method === 'POST') {
      const { ciphertext } = JSON.parse(body.toString('utf8'));
      store.stored = Buffer.from(ciphertext, 'base64url');
      json(res, 201, { id: 'abcdefghijklmnopqrstuvwxyz', cid: store.cidOverride ?? cidOf(store.stored), deleteToken: 'tok-secret' });
    } else {
      res.writeHead(200);
      res.end(store.stored);
    }
  });
  try {
    const up = await uploadSealed(store.origin, sealed, expiresAt);
    assert.equal(up.id, 'abcdefghijklmnopqrstuvwxyz');
    assert.equal(up.cid, cidOf(sealed));
    assert.equal(up.deleteToken, 'tok-secret');

    const post = store.requests[0];
    assert.equal(post.url, '/api/share-links');
    const sent = JSON.parse(post.body.toString('utf8'));
    assert.equal(sent.expiresAt, '2030-01-02T03:04:05.678Z');
    assert.deepEqual(Buffer.from(sent.ciphertext, 'base64url'), Buffer.from(sealed));
    assert.match(post.headers['user-agent'], /^tinycloud-courier\/\d/);

    const got = await fetchSealed(store.origin, up.id, up.cid);
    assert.deepEqual(Buffer.from(got), Buffer.from(sealed));
  } finally {
    await store.close();
  }
});

test('upload rejects a store response whose cid does not match the sealed bytes', async () => {
  const store = await fakeStore((req, res) => {
    json(res, 201, { id: 'abcdefghijklmnopqrstuvwxyz', cid: HELLO_CID, deleteToken: 'tok' });
  });
  try {
    await assert.rejects(uploadSealed(store.origin, new TextEncoder().encode('other'), new Date()), (e) => e.code === 'invite-store-error');
  } finally {
    await store.close();
  }
});

test('oversize sealed data is refused before any request is sent', async () => {
  const store = await fakeStore((req, res) => json(res, 201, {}));
  try {
    const big = new Uint8Array(MAX_SEALED_BYTES + 1);
    await assert.rejects(uploadSealed(store.origin, big, new Date()), assertCode('invite-too-large'));
    assert.equal(store.requests.length, 0);
  } finally {
    await store.close();
  }
});

test('fetch maps 404 to invite-gone', async () => {
  const store = await fakeStore((req, res) => {
    res.writeHead(404);
    res.end();
  });
  try {
    await assert.rejects(fetchSealed(store.origin, 'abcdefghijklmnopqrstuvwxyz', HELLO_CID), assertCode('invite-gone'));
  } finally {
    await store.close();
  }
});

test('fetch rejects bytes whose cid does not match the invitation string', async () => {
  const store = await fakeStore((req, res) => {
    res.writeHead(200);
    res.end(Buffer.from('not the sealed bytes'));
  });
  try {
    await assert.rejects(fetchSealed(store.origin, 'abcdefghijklmnopqrstuvwxyz', HELLO_CID), assertCode('bad-invite'));
  } finally {
    await store.close();
  }
});

test('429 maps to invite-rate-limited and 503 maps to invite-unavailable', async () => {
  let status = 429;
  const store = await fakeStore((req, res) => {
    res.writeHead(status);
    res.end();
  });
  try {
    await assert.rejects(fetchSealed(store.origin, 'abcdefghijklmnopqrstuvwxyz', HELLO_CID), (e) => e.code === 'invite-rate-limited' && e.message.includes('429'));
    status = 503;
    await assert.rejects(fetchSealed(store.origin, 'abcdefghijklmnopqrstuvwxyz', HELLO_CID), assertCode('invite-unavailable'));
  } finally {
    await store.close();
  }
});

test('delete sends the bearer token and accepts 204', async () => {
  const store = await fakeStore((req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    await deleteSealed(store.origin, 'abcdefghijklmnopqrstuvwxyz', 'tok-123');
    assert.equal(store.requests[0].method, 'DELETE');
    assert.equal(store.requests[0].headers.authorization, 'Bearer tok-123');
  } finally {
    await store.close();
  }
});

test('delete failure never includes the delete token in the error message', async () => {
  const token = 'tok-must-not-leak';
  const store = await fakeStore((req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  try {
    await assert.rejects(deleteSealed(store.origin, 'abcdefghijklmnopqrstuvwxyz', token), (e) => e.code === 'invite-store-error' && !String(e.message).includes(token));
  } finally {
    await store.close();
  }
});

test('format then parse round-trips and parse trims surrounding whitespace', () => {
  const parts = { id: 'abcdefghijklmnopqrstuvwxyz', key: 'A'.repeat(43), cid: HELLO_CID };
  const s = formatInviteString(parts);
  assert.equal(s, `tcinvite1:${parts.id}:${parts.key}:${parts.cid}`);
  assert.deepEqual(parseInviteString(`  ${s}\n`), parts);
});

test('parse rejects malformed invitation strings', () => {
  const id = 'abcdefghijklmnopqrstuvwxyz';
  const key = 'A'.repeat(43);
  const cid = HELLO_CID;
  const bad = [
    '',
    `tcinvite2:${id}:${key}:${cid}`,
    `tcinvite1:${id.slice(0, 25)}:${key}:${cid}`,
    `tcinvite1:${id.toUpperCase()}:${key}:${cid}`,
    `tcinvite1:abcdefghijklmnopqrstuvwxy0:${key}:${cid}`,
    `tcinvite1:${id}:${key}:${cid}:extra`,
    `tcinvite1:${id}:${key.slice(0, 42)}:${cid}`,
    `tcinvite1:${id}:${key}:${cid.slice(0, -1)}`,
    `tcinvite1:${id}:${key}:bafybei${cid.slice(7)}`,
    `tcinvite1:${id} :${key}:${cid}`,
    `tcinvite1:${id}:${key}`,
  ];
  for (const s of bad) {
    assert.throws(() => parseInviteString(s), assertCode('bad-invite'), JSON.stringify(s));
  }
  assert.throws(() => parseInviteString(undefined), assertCode('bad-invite'));
});

test('parse rejects a non-canonical key with trailing bits set', () => {
  // 43 base64url chars: the final char's low 2 bits are padding and must be zero.
  const id = 'abcdefghijklmnopqrstuvwxyz';
  const cid = HELLO_CID;
  const nonCanonical = 'A'.repeat(42) + 'B';
  assert.throws(() => parseInviteString(`tcinvite1:${id}:${nonCanonical}:${cid}`), assertCode('bad-invite'));
});

test('inviteOrigin defaults to the share origin and honours the override', () => {
  const saved = process.env.COURIER_INVITE_ORIGIN;
  try {
    delete process.env.COURIER_INVITE_ORIGIN;
    assert.equal(inviteOrigin(), 'https://share.tinycloud.xyz');
    process.env.COURIER_INVITE_ORIGIN = 'http://127.0.0.1:9999/';
    assert.equal(inviteOrigin(), 'http://127.0.0.1:9999');
  } finally {
    if (saved === undefined) delete process.env.COURIER_INVITE_ORIGIN;
    else process.env.COURIER_INVITE_ORIGIN = saved;
  }
});
