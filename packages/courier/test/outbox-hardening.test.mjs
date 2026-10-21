import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { startOutbox, ensurePeerDir, publishItem } from '../dist/outbox.js';
import { canonicalJson, requestHash } from '../dist/canonical.js';

const GROUP = 'courier-test';
const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-20T12:00:00Z');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeEnv({ peers = { alpha: { status: 'paired' } }, peersJson } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc712-outbox-hardening-'));
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

/** Writes raw bytes, then half-closes: the sender sees exactly these bytes and EOF. */
function send(pipe, bytes) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    let reply = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      reply += chunk;
    });
    sock.on('error', reject);
    sock.on('close', () => resolve(reply));
    sock.end(bytes);
  });
}

function request(pipe, line) {
  return send(pipe, `${line}\n`);
}

/** The single canonical request frame body for an item (no line terminator). */
function requestFor(itemId) {
  return JSON.stringify({ v: 1, itemId });
}

/**
 * Writes an item in its canonical byte form. The approval ledger (`approved/<itemId>`, owner-only) holds the
 * hash `outbox add` would have recorded. `raw` replaces the canonical bytes for negative cases.
 */
function writeItem(env, {
  itemId = ulid(), dir = 'alpha', to = 'alpha', thread = ulid(), subject, text = 'hello', approve = true,
  ledger = true, mode = 0o600, raw,
} = {}) {
  const body = subject === undefined
    ? { v: 1, itemId, to, thread, text }
    : { v: 1, itemId, to, thread: null, subject, text };
  const item = { ...body, approvedSha256: approve ? requestHash(body) : '0'.repeat(64) };
  const peerDir = path.join(env.outboxRoot, dir);
  fs.mkdirSync(peerDir, { recursive: true });
  const file = path.join(peerDir, `${itemId}.json`);
  const bytes = raw ? raw(canonicalJson(item)) : `${canonicalJson(item)}\n`;
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, mode);
  if (ledger) {
    const approvedDir = path.join(env.outboxRoot, 'approved');
    fs.mkdirSync(approvedDir, { recursive: true, mode: 0o700 });
    const entry = path.join(approvedDir, itemId);
    fs.writeFileSync(entry, `${requestHash(body)}\n`, { mode: 0o600 });
    fs.chmodSync(entry, 0o600);
  }
  return { itemId, file, body, item };
}

// --- framing: one canonical request line per connection (O3) -----------------------------------------------------

test('a request that is not the single canonical frame is refused as bad-request and reserves nothing', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env);
  const canon = requestFor(itemId);
  const cases = {
    reordered: `{"itemId":"${itemId}","v":1}\n`,
    'duplicate-key': `{"itemId":"${itemId}","itemId":"${itemId}","v":1}\n`,
    'numeric-v': `{"itemId":"${itemId}","v":1.0}\n`,
    'padded-to-65-bytes': `${canon}${' '.repeat(20)}\n`,
    'two-frames-in-one-write': `${canon}\n${canon}\n`,
    'short-ulid': `{"itemId":"${itemId.slice(1)}","v":1}\n`,
    'escaped-newline-in-id': `{"itemId":"${itemId.slice(0, 10)}\\n${itemId.slice(10, 25)}","v":1}\n`,
  };
  await withSender(env, async () => {
    for (const [name, bytes] of Object.entries(cases)) {
      assert.equal(await send(env.pipe, bytes), 'refused:bad-request\n', name);
    }
    assert.equal(env.calls.length, 0);
    assert.equal(await request(env.pipe, canon), 'ok\n', 'the canonical frame still sends the item');
  });
  assert.equal(env.calls.length, 1);
});

test('a complete frame ended by EOF is accepted, and a truncated frame at EOF is refused as bad-request', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env);
  await withSender(env, async () => {
    assert.equal(await send(env.pipe, requestFor(itemId)), 'ok\n');
    assert.equal(await send(env.pipe, requestFor(itemId).slice(0, -1)), 'refused:bad-request\n');
  });
  assert.equal(env.calls.length, 1);
});

// --- approval ledger (O1) ---------------------------------------------------------------------------------------

test('an item without an approval ledger entry is never sent', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env, { ledger: false });
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:not-approved\n');
  });
  assert.equal(env.calls.length, 0);
});

test('a recomputed embedded digest cannot replace the protected ledger value', async () => {
  const env = makeEnv();
  const original = writeItem(env, { text: 'original' });
  const edited = { ...original.body, text: 'changed' };
  fs.writeFileSync(original.file, `${canonicalJson({ ...edited, approvedSha256: requestHash(edited) })}\n`);
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(original.itemId)), 'refused:hash-mismatch\n');
  });
  assert.equal(env.calls.length, 0);
});

test('an approval ledger entry that another user could write is refused as unsafe-item', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env);
  fs.chmodSync(path.join(env.outboxRoot, 'approved', itemId), 0o664);
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:unsafe-item\n');
  });
  assert.equal(env.calls.length, 0);
});

// --- canonical item bytes (O2) ----------------------------------------------------------------------------------

test('an item that is not in canonical bytes is refused as bad-item', async () => {
  const cases = {
    'leading-space': (canon) => ` ${canon}\n`,
    'pretty-printed': (canon) => `${JSON.stringify(JSON.parse(canon), null, 2)}\n`,
    'duplicate-text': (canon) => `${canon.replace('"text":"hello"', '"text":"discarded","text":"hello"')}\n`,
  };
  for (const [name, raw] of Object.entries(cases)) {
    const env = makeEnv();
    const { itemId } = writeItem(env, { raw });
    await withSender(env, async () => {
      assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:bad-item\n', name);
    });
    assert.equal(env.calls.length, 0, name);
  }
});

test('the item is read once; replacing its path after the read cannot change the sent text', async () => {
  const env = makeEnv();
  const { itemId, file } = writeItem(env, { text: 'original fixture' });
  const realRead = fs.readSync;
  let swapped = false;
  mock.method(fs, 'readSync', (fd, ...rest) => {
    const bytes = realRead(fd, ...rest);
    if (!swapped) {
      swapped = true;
      fs.unlinkSync(file);
      fs.writeFileSync(file, 'replacement');
    }
    return bytes;
  });
  try {
    await withSender(env, async () => {
      assert.equal(await request(env.pipe, requestFor(itemId)), 'ok\n');
    });
  } finally {
    mock.restoreAll();
  }
  assert.equal(env.calls[0].input.text, 'original fixture');
});

test('an item owned by another user is refused as unsafe-item', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env);
  const realFstat = fs.fstatSync;
  mock.method(fs, 'fstatSync', (fd, ...rest) => {
    const stats = realFstat(fd, ...rest);
    stats.uid += 1;
    return stats;
  });
  try {
    await withSender(env, async () => {
      assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:unsafe-item\n');
    });
  } finally {
    mock.restoreAll();
  }
  assert.equal(env.calls.length, 0);
});

// --- reservations (O4) and durability (R10 analogue) ------------------------------------------------------------

test('a reservation left without a result is reported uncertain at startup and never resent', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env);
  fs.mkdirSync(env.sentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(env.sentDir, itemId),
    JSON.stringify({ v: 1, peer: 'alpha', at: new Date(T0).toISOString() }),
    { mode: 0o600 },
  );
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'refused:uncertain\n');
  });
  assert.equal(env.calls.length, 0);
  assert.ok(env.logs.some((entry) => entry.event === 'outbox.uncertain' && entry.fields.count === 1), JSON.stringify(env.logs));
});

test('the reservation is durable in the sent directory before the item is sent', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env);
  const dirFds = new Set();
  const events = [];
  const realOpen = fs.openSync;
  mock.method(fs, 'openSync', (file, ...rest) => {
    const fd = realOpen(file, ...rest);
    if (String(file) === env.sentDir) dirFds.add(fd);
    return fd;
  });
  const realFsync = fs.fsyncSync;
  mock.method(fs, 'fsyncSync', (fd) => {
    events.push(dirFds.has(fd) ? 'fsync-dir' : 'fsync-file');
    return realFsync(fd);
  });
  try {
    await withSender(env, async () => {
      assert.equal(await request(env.pipe, requestFor(itemId)), 'ok\n');
    }, {
      send: async () => {
        events.push('send');
        return { messageId: 'msg-1' };
      },
    });
  } finally {
    mock.restoreAll();
  }
  assert.ok(events.indexOf('send') >= 0);
  assert.ok(events.slice(0, events.indexOf('send')).includes('fsync-dir'), events.join(','));
});

test('publishing an item fsyncs the peer directory after the link', () => {
  const env = makeEnv();
  const peerDir = ensurePeerDir(env.outboxRoot, 'alpha');
  const itemId = ulid();
  const dirFds = new Set();
  const events = [];
  const realOpen = fs.openSync;
  mock.method(fs, 'openSync', (file, ...rest) => {
    const fd = realOpen(file, ...rest);
    if (String(file) === peerDir) dirFds.add(fd);
    return fd;
  });
  const realLink = fs.linkSync;
  mock.method(fs, 'linkSync', (existing, target) => {
    events.push('link');
    return realLink(existing, target);
  });
  const realFsync = fs.fsyncSync;
  mock.method(fs, 'fsyncSync', (fd) => {
    events.push(dirFds.has(fd) ? 'fsync-dir' : 'fsync-file');
    return realFsync(fd);
  });
  try {
    assert.equal(publishItem(peerDir, itemId, '{"v":1}\n'), true);
  } finally {
    mock.restoreAll();
  }
  const link = events.indexOf('link');
  assert.ok(link >= 0);
  assert.ok(events.indexOf('fsync-dir', link) > link, events.join(','));
});

// --- serialization, socket, and group (guards) ------------------------------------------------------------------

test('concurrent requests for one item reserve it once and sends never overlap', async () => {
  const env = makeEnv();
  const { itemId } = writeItem(env);
  let active = 0;
  let maxActive = 0;
  const send = async (_profile, peerHandle, input) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    env.calls.push({ peerHandle, input });
    await sleep(20);
    active -= 1;
    return { messageId: 'msg-1' };
  };
  await withSender(env, async () => {
    const replies = await Promise.all(Array.from({ length: 10 }, () => request(env.pipe, requestFor(itemId))));
    assert.equal(replies.filter((reply) => reply === 'ok\n').length, 1);
    assert.equal(replies.filter((reply) => reply === 'refused:already-used\n').length, 9);
  }, { send });
  assert.equal(env.calls.length, 1);
  assert.equal(maxActive, 1);
});

test('the sender socket is group-accessible (0660) once it is listening', async () => {
  const env = makeEnv();
  await withSender(env, async () => {
    assert.equal(fs.statSync(env.pipe).mode & 0o777, 0o660);
  });
});

test('socket groups that can read or write other services are refused', async () => {
  const env = makeEnv();
  for (const socketGroup of ['tinycloud', 'tinycloud-dev', 'sudo', 'docker']) {
    await assert.rejects(startOutbox(optionsFor(env, { socketGroup })), { code: 'unsafe-socket-group' }, socketGroup);
  }
});

// --- budgets (O6) and logging (O5) ------------------------------------------------------------------------------

test('invalid-request logging is capped per minute', async () => {
  const env = makeEnv();
  await withSender(env, async () => {
    for (let i = 0; i < 101; i++) {
      assert.equal(await request(env.pipe, '{}'), 'refused:bad-request\n');
    }
  });
  const refusals = env.logs.filter(({ event }) => event === 'outbox.refused');
  assert.ok(refusals.length <= 60, `logged ${refusals.length} refusals`);
});

test('sender logs never carry the peer id, even when the peer policy is invalid', async () => {
  const peer = 'sentinel-peer';
  const env = makeEnv({
    peers: { [peer]: { status: 'paired' } },
    peersJson: { [peer]: { tier: 'trusted', ratePerHour: 100, outPerHour: 101 } },
  });
  const { itemId } = writeItem(env, { dir: peer, to: peer });
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(itemId)), 'ok\n');
  });
  assert.equal(env.calls.length, 1);
  assert.ok(!JSON.stringify(env.logs).includes(peer));
});

test('connections beyond the connection budget are closed without a reply', async () => {
  const env = makeEnv();
  await withSender(env, async () => {
    const socks = [];
    let closed = 0;
    for (let i = 0; i < 80; i++) {
      const sock = net.connect(env.pipe);
      sock.on('error', () => {});
      sock.on('close', () => {
        closed += 1;
      });
      socks.push(sock);
    }
    await sleep(300);
    for (const sock of socks) sock.destroy();
    assert.ok(closed >= 16, `closed ${closed}`);
  });
});

test('requests beyond the pending budget are refused busy without waiting for the queue', async () => {
  const env = makeEnv();
  const ids = Array.from({ length: 40 }, () => writeItem(env).itemId);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const send = async (_profile, peerHandle, input) => {
    env.calls.push({ peerHandle, input });
    await gate;
    return { messageId: `msg-${env.calls.length}` };
  };
  await withSender(env, async () => {
    const pending = ids.map((itemId) => request(env.pipe, requestFor(itemId)));
    await sleep(300);
    release();
    const replies = await Promise.all(pending);
    assert.equal(replies.filter((reply) => reply === 'refused:busy\n').length, 7);
    assert.equal(replies.filter((reply) => reply === 'ok\n').length, 33);
  }, { send });
  assert.equal(env.calls.length, 33);
});

// --- peers policy (unchanged semantics) -------------------------------------------------------------------------

test('a peers policy change takes effect at the next send, and the rate window survives a restart', async () => {
  const env = makeEnv({
    peersJson: { alpha: { tier: 'trusted', ratePerHour: 100, outPerHour: 1 } },
  });
  const first = writeItem(env);
  const second = writeItem(env);
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(first.itemId)), 'ok\n');
  });
  env.clock.t -= 2 * HOUR_MS;
  await withSender(env, async () => {
    assert.equal(await request(env.pipe, requestFor(second.itemId)), 'refused:rate-limited\n');
  });
  assert.equal(env.calls.length, 1);
});
