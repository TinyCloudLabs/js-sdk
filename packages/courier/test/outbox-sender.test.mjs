import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { REFUSAL_CODES, groupGid, startOutbox } from '../dist/outbox.js';
import { requestHash } from '../dist/canonical.js';
import { CourierError } from '../dist/errors.js';
import * as outboxModule from '../dist/outbox.js';

const GROUP = 'courier-test';
const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-20T12:00:00Z');

function makeEnv({ peers = { alpha: { status: 'paired' } }, peersJson } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc712-outbox-'));
  const sockDir = path.join(base, 'sock');
  fs.mkdirSync(sockDir, { mode: 0o750 });
  fs.chmodSync(sockDir, 0o750);
  const outboxRoot = path.join(base, 'outbox');
  fs.mkdirSync(outboxRoot, { mode: 0o700 });
  const env = {
    base,
    pipe: path.join(sockDir, 'outbox.sock'),
    outboxRoot,
    sentDir: path.join(base, 'sent'),
    peersFile: path.join(base, 'peers.json'),
    profile: { peers },
    calls: [],
    logs: [],
    clock: { t: T0 },
  };
  if (peersJson !== undefined) fs.writeFileSync(env.peersFile, JSON.stringify(peersJson), { mode: 0o600 });
  return env;
}

function optionsFor(env, extra = {}) {
  return {
    outboxRoot: env.outboxRoot,
    sentDir: env.sentDir,
    pipe: env.pipe,
    socketGroup: GROUP,
    peersFile: env.peersFile,
    groups: () => fs.statSync(path.dirname(env.pipe)).gid,
    loadProfile: () => env.profile,
    send: async (_profile, peerHandle, input) => {
      env.calls.push({ peerHandle, input });
      return { messageId: `msg-${env.calls.length}` };
    },
    now: () => env.clock.t,
    log: (event, fields) => env.logs.push({ event, fields }),
    ...extra,
  };
}

async function withSender(env, fn, extra) {
  const handle = await startOutbox(optionsFor(env, extra));
  try {
    return await fn();
  } finally {
    await handle.close();
  }
}

function request(pipe, line) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    let reply = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      reply += chunk;
    });
    sock.on('error', reject);
    sock.on('close', () => resolve(reply));
    sock.end(`${line}\n`);
  });
}

function requestFor(itemId) {
  return JSON.stringify({ v: 1, itemId });
}

function writeItem(env, {
  itemId = ulid(), dir = 'alpha', to = 'alpha', thread = ulid(), subject, text = 'hello', approve = true, mode = 0o644,
} = {}) {
  const body = subject === undefined
    ? { v: 1, itemId, to, thread, text }
    : { v: 1, itemId, to, thread: null, subject, text };
  const item = { ...body, approvedSha256: approve ? requestHash(body) : '0'.repeat(64) };
  const peerDir = path.join(env.outboxRoot, dir);
  fs.mkdirSync(peerDir, { recursive: true });
  const file = path.join(peerDir, `${itemId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(item, null, 2)}\n`);
  fs.chmodSync(file, mode);
  return { itemId, file, thread };
}

function seedMarker(env, peer, at) {
  fs.mkdirSync(env.sentDir, { recursive: true });
  fs.writeFileSync(path.join(env.sentDir, ulid()), JSON.stringify({ v: 1, peer, at: new Date(at).toISOString() }));
}

/** Single-use markers only; excludes serve.lock and result files, which contain a dot. */
function markers(env) {
  if (!fs.existsSync(env.sentDir)) return [];
  return fs.readdirSync(env.sentDir).filter((name) => !name.includes('.'));
}

test('an approved thread item is sent once; a repeat is already-used', async () => {
  const env = makeEnv();
  const { itemId, thread } = writeItem(env);
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'ok\n');
    assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:already-used\n');
  });
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].peerHandle, 'alpha');
  assert.equal(env.calls[0].input.which, 'thread');
  assert.equal(env.calls[0].input.threadId, thread);
  assert.equal(env.calls[0].input.text, 'hello');
  assert.equal(env.calls[0].input.intent, 'request');
  const result = JSON.parse(fs.readFileSync(path.join(env.sentDir, `${itemId}.result.json`), 'utf8'));
  assert.equal(result.state, 'sent');
  assert.equal(result.messageId, 'msg-1');
});

test('a subject item starts a new thread', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env, { subject: 'Hello there' });
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'ok\n');
  });
  assert.equal(env.calls[0].input.which, 'new');
  assert.equal(env.calls[0].input.subject, 'Hello there');
  assert.match(env.calls[0].input.threadId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('refusals reply with a fixed code and echo nothing from the request', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env, { approve: false, text: 'secret words' });
  const missing = ulid();
  const cases = [
    ['not json', 'not json', 'bad-request'],
    ['extra key', JSON.stringify({ v: 1, itemId: missing, extra: 1 }), 'bad-request'],
    ['bad version', JSON.stringify({ v: 2, itemId: missing }), 'bad-request'],
    ['bad id', JSON.stringify({ v: 1, itemId: 'nope' }), 'bad-request'],
    ['missing item', requestFor(missing), 'not-found'],
    ['hash mismatch', requestFor(itemId), 'hash-mismatch'],
  ];
  await withSender(env, async () => {
    for (const [name, line, code] of cases) {
      assert.equal(await request(env.pipe, line), `refused:${code}\n`, name);
      assert.ok(REFUSAL_CODES.includes(code), name);
    }
  });
  assert.equal(env.calls.length, 0);
  for (const { event, fields } of env.logs) {
    assert.ok(!JSON.stringify(fields ?? {}).includes(itemId), event);
  }
});

test('a request with a malformed id is refused before the outbox root is touched', async () => {
  const env = makeEnv();
  fs.rmSync(env.outboxRoot, { recursive: true });
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, JSON.stringify({ v: 1, itemId: 'nope' })), 'refused:bad-request\n');
    assert.equal(await request(env.pipe, requestFor(ulid())), 'refused:root-unsafe\n');
  });
});

test('an item whose hash does not match is refused and sends nothing', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env, { approve: false });
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:hash-mismatch\n');
  });
  assert.equal(env.calls.length, 0);
  assert.deepEqual(markers(env), []);
});

test('an item for an unpaired or unknown peer is refused and leaves no marker', async () => {
  const env = makeEnv({ peers: { alpha: { status: 'awaiting-C' } } });
  const pending = writeItem(env);
  const unknown = writeItem(env, { dir: 'gamma', to: 'gamma' });
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(pending.itemId)), 'refused:unpaired-peer\n');
    assert.equal(await request(env.pipe, requestFor(unknown.itemId)), 'refused:unpaired-peer\n');
  });
  assert.equal(env.calls.length, 0);
  assert.deepEqual(markers(env), []);
});

test('text over 2000 characters is refused', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env, { text: 'x'.repeat(2001) });
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:invalid-text\n');
  });
  assert.equal(env.calls.length, 0);
});

test('an item filed under a peer directory other than its "to" is bad', async () => {
  const env = makeEnv({ peers: { alpha: { status: 'paired' }, beta: { status: 'paired' } } });
  const { itemId } = writeItem(env, { dir: 'beta', to: 'alpha' });
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:bad-item\n');
  });
  assert.equal(env.calls.length, 0);
});

test('the same item id under two peer directories is ambiguous', async () => {
  const env = makeEnv({ peers: { alpha: { status: 'paired' }, beta: { status: 'paired' } } });
  const itemId = ulid();
  writeItem(env, { itemId });
  writeItem(env, { itemId, dir: 'beta', to: 'beta' });
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:ambiguous-item\n');
  });
  assert.equal(env.calls.length, 0);
});

test('an item file that is a symlink or group-writable is unsafe', async () => {
  const env = makeEnv();
  const linked = writeItem(env);
  const target = path.join(env.base, 'elsewhere.json');
  fs.renameSync(linked.file, target);
  fs.symlinkSync(target, linked.file);
  const writable = writeItem(env, { mode: 0o664 });
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(linked.itemId)), 'refused:unsafe-item\n');
    assert.equal(await request(env.pipe, requestFor(writable.itemId)), 'refused:unsafe-item\n');
  });
  assert.equal(env.calls.length, 0);
});

test('a failed send is recorded as failed and never retried', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env);
  const send = async (_profile, peerHandle, input) => {
    env.calls.push({ peerHandle, input });
    throw new CourierError('send-down', 'transport unavailable');
  };
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:send-failed\n');
    assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:already-used\n');
  }, { send });
  assert.equal(env.calls.length, 1);
  const result = JSON.parse(fs.readFileSync(path.join(env.sentDir, `${itemId}.result.json`), 'utf8'));
  assert.equal(result.state, 'failed');
  assert.equal(result.messageId, undefined);
});

test('the default outbound cap is 100 per peer per rolling hour; other peers do not count', async () => {
  const env = makeEnv();
  for (let i = 0; i < 99; i++) seedMarker(env, 'alpha', T0 - 1000);
  for (let i = 0; i < 5; i++) seedMarker(env, 'alpha', T0 - 2 * HOUR_MS);
  for (let i = 0; i < 50; i++) seedMarker(env, 'beta', T0 - 1000);
  const first = writeItem(env);
  const second = writeItem(env);
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(first.itemId)), 'ok\n');
    assert.equal(await request(env.pipe, requestFor(second.itemId)), 'refused:rate-limited\n');
  });
  assert.equal(env.calls.length, 1);
});

test('markers age out of the rolling hour', async () => {
  const env = makeEnv();
  for (let i = 0; i < 100; i++) seedMarker(env, 'alpha', T0);
  const { itemId } = writeItem(env);
  env.clock.t = T0 + HOUR_MS;
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'ok\n');
  });
  assert.equal(env.calls.length, 1);
});

test('peers.json can lower the outbound cap', async () => {
  const env = makeEnv({
    peersJson: { alpha: { tier: 'trusted', ratePerHour: 100, outPerHour: 1 } },
  });
  const first = writeItem(env);
  const second = writeItem(env);
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(first.itemId)), 'ok\n');
    assert.equal(await request(env.pipe, requestFor(second.itemId)), 'refused:rate-limited\n');
  });
});

test('peers.json cannot raise the outbound cap above the default', async () => {
  const env = makeEnv({
    peersJson: { alpha: { tier: 'trusted', ratePerHour: 100, outPerHour: 500 } },
  });
  for (let i = 0; i < 100; i++) seedMarker(env, 'alpha', T0);
  const { itemId } = writeItem(env);
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:rate-limited\n');
  });
  assert.equal(env.calls.length, 0);
});

test('an unreadable sent marker fails closed', async () => {
  const env = makeEnv();
  fs.mkdirSync(env.sentDir, { recursive: true });
  fs.writeFileSync(path.join(env.sentDir, ulid()), 'not json');
  const { itemId } = writeItem(env);
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:internal\n');
  });
  assert.equal(env.calls.length, 0);
});

test('dry-run refuses after the checks and writes no marker', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env);
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:dry-run\n');
  }, { dryRun: true });
  assert.equal(env.calls.length, 0);
  assert.deepEqual(markers(env), []);
});

test('a once sender closes after the first connection and removes its socket', { timeout: 10000 }, async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env);
  const handle = await startOutbox(optionsFor(env, { once: true }));
  assert.equal(await request(env.pipe, requestFor(itemId)), 'ok\n');
  await handle.done;
  assert.equal(fs.existsSync(env.pipe), false);
});

test('a second sender on the same sent directory is refused while the first holds the lock', async () => {
  const env = makeEnv();
  const handle = await startOutbox(optionsFor(env));
  try {
    await assert.rejects(
      startOutbox(optionsFor(env, { pipe: path.join(path.dirname(env.pipe), 'second.sock') })),
      { code: 'locked' },
    );
  } finally {
    await handle.close();
  }
});

test('the socket directory must be a real, owner-only directory in the configured group', async () => {
  const env = makeEnv();
  const dir = path.dirname(env.pipe);
  const gid = fs.statSync(dir).gid;
  const link = path.join(env.base, 'link');
  fs.symlinkSync(dir, link);
  await assert.rejects(startOutbox(optionsFor(env, { pipe: path.join(link, 'outbox.sock') })), { code: 'unsafe-socket-dir' });
  fs.chmodSync(dir, 0o770);
  await assert.rejects(startOutbox(optionsFor(env)), { code: 'unsafe-socket-dir' });
  fs.chmodSync(dir, 0o750);
  await assert.rejects(startOutbox(optionsFor(env, { groups: () => gid + 1 })), { code: 'unsafe-socket-dir' });
  await assert.rejects(startOutbox(optionsFor(env, { socketGroup: 'sudo' })), { code: 'unsafe-socket-group' });
});

test('an existing non-socket at the pipe path is never removed', async () => {
  const env = makeEnv();
  fs.writeFileSync(env.pipe, 'keep');
  await assert.rejects(startOutbox(optionsFor(env)), { code: 'unsafe-pipe' });
  assert.equal(fs.readFileSync(env.pipe, 'utf8'), 'keep');
});

test('groupGid reads the numeric gid and rejects unknown groups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc712-group-'));
  const file = path.join(dir, 'group');
  fs.writeFileSync(file, 'root:x:0:\ncourier-test:x:4242:\n');
  assert.equal(groupGid('courier-test', file), 4242);
  assert.throws(() => groupGid('missing-group', file), { code: 'unknown-group' });
});

test('an outbox item is published 0640 in a 2750 peer directory', () => {
  const env = makeEnv();
  const peerDir = outboxModule.ensurePeerDir(env.outboxRoot, 'alpha');
  const itemId = ulid();
  assert.equal(outboxModule.publishItem(peerDir, itemId, '{"v":1}\n'), true);
  assert.equal(fs.statSync(peerDir).mode & 0o7777, 0o2750);
  assert.equal(fs.statSync(path.join(peerDir, `${itemId}.json`)).mode & 0o7777, 0o640);
  assert.deepEqual(fs.readdirSync(peerDir), [`${itemId}.json`]);
});

test('a reader scanning mid-publish never sees a partial <itemId>.json', () => {
  const env = makeEnv();
  const peerDir = outboxModule.ensurePeerDir(env.outboxRoot, 'alpha');
  const itemId = ulid();
  const finalName = `${itemId}.json`;
  const body = `${JSON.stringify({ v: 1, itemId, to: 'alpha', thread: ulid(), text: 'hello' }, null, 2)}\n`;
  const directOpens = [];
  const realOpen = fs.openSync;
  mock.method(fs, 'openSync', (file, ...rest) => {
    if (path.dirname(String(file)) === peerDir && path.basename(String(file)) === finalName) directOpens.push(String(file));
    return realOpen(file, ...rest);
  });
  const publishes = [];
  const realLink = fs.linkSync;
  mock.method(fs, 'linkSync', (existing, target) => {
    publishes.push({
      temp: path.basename(String(existing)),
      visibleBefore: fs.readdirSync(peerDir).filter((name) => name === finalName),
      content: fs.readFileSync(String(existing), 'utf8'),
    });
    return realLink(existing, target);
  });
  try {
    assert.equal(outboxModule.publishItem(peerDir, itemId, body), true);
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(directOpens, []);
  assert.equal(publishes.length, 1);
  assert.match(publishes[0].temp, /^\.tmp-/);
  assert.deepEqual(publishes[0].visibleBefore, []);
  assert.equal(publishes[0].content, body);
  assert.deepEqual(fs.readdirSync(peerDir), [finalName]);
});
