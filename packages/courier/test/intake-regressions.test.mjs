import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { memoryKv } from './memory-kv.mjs';
import { k } from '../dist/keys.js';
import { capUtf8, flagsFor, initFromNow, intakeCycle } from '../dist/intake/intake.js';
import { FLAG_TABLE, severityFor } from '../dist/intake/flags.js';
import { readState, ensureRealDir } from '../dist/intake/queue.js';

const NOW = Date.UTC(2026, 9, 20, 18, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HANDLE = 'alice';
const THREAD = ulid(NOW - HOUR);

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-regress-'));
  const dirs = {
    queueRoot: path.join(root, 'queue'),
    stateDir: path.join(root, 'state'),
    doneRoot: path.join(root, 'done'),
    overflowRoot: path.join(root, 'overflow'),
  };
  ensureRealDir(dirs.queueRoot, 0o750);
  ensureRealDir(dirs.stateDir, 0o700);
  ensureRealDir(dirs.doneRoot, 0o700);
  ensureRealDir(dirs.overflowRoot, 0o700);
  return dirs;
}

function profileWith(peers) {
  return { version: 3, peers };
}

function pairedPeer(handle = HANDLE, extra = {}) {
  return { handle, ownerDid: 'did:test:o', courierDid: 'did:test:c', spaceId: 's', outbound: [], status: 'paired', pairedAt: 'x', ...extra };
}

async function putMessage(kv, msgId, parts, { peer = HANDLE, thread = THREAD, messageId = msgId, contextId = thread } = {}) {
  await kv.put(k.mirrorMsg(peer, thread, msgId), { messageId, contextId, parts });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function harness(overrides = {}) {
  const dirs = sandbox();
  const kv = memoryKv();
  const events = [];
  let clock = NOW;
  const input = {
    kv,
    profile: profileWith({ [HANDLE]: pairedPeer() }),
    peers: {},
    queueRoot: dirs.queueRoot,
    stateDir: dirs.stateDir,
    doneRoot: dirs.doneRoot,
    overflowRoot: dirs.overflowRoot,
    state: { v: 1, peers: {} },
    now: () => clock,
    log: (event, fields) => events.push({ event, fields }),
    ...overrides,
  };
  const listing = (root, peer) => {
    const dir = path.join(root, peer);
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  };
  return {
    kv,
    input,
    events,
    dirs,
    setClock(t) {
      clock = t;
    },
    readQueue(peer, msgId) {
      return readJson(path.join(dirs.queueRoot, peer, `${msgId}.json`));
    },
    readDone(peer, msgId) {
      return readJson(path.join(dirs.doneRoot, peer, `${msgId}.json`));
    },
    queueFiles: (peer) => listing(dirs.queueRoot, peer),
    doneFiles: (peer) => listing(dirs.doneRoot, peer),
    overflowFiles: (peer) => listing(dirs.overflowRoot, peer),
    eventsNamed: (name) => events.filter((e) => e.event === name),
  };
}

test('a pre-provisioned setgid queue root keeps its mode', () => {
  const h = harness();
  fs.chmodSync(h.dirs.queueRoot, 0o2750);
  ensureRealDir(h.dirs.queueRoot, 0o750);
  assert.equal(fs.statSync(h.dirs.queueRoot).mode & 0o7777, 0o2750);
});

test('peer queue directories created by intake are setgid 2750', async () => {
  const h = harness();
  const id = ulid(NOW);
  await putMessage(h.kv, id, [{ text: 'hello' }]);
  await intakeCycle(h.input);
  assert.equal(fs.statSync(path.join(h.dirs.queueRoot, HANDLE)).mode & 0o7777, 0o2750);
});

test('hard Unicode check still applies when the text is also too long', async () => {
  const h = harness({ peers: { alice: { tier: 'trusted', ratePerHour: 100, outPerHour: 100 } } });
  const id = ulid(NOW);
  await putMessage(h.kv, id, [{ text: 'a '.repeat(4000) + '\u202e' + 'z' }]);
  await intakeCycle(h.input);
  const flags = h.readQueue(HANDLE, id).cheapChecks.flags;
  assert.ok(flags.includes('too-long'));
  assert.ok(flags.includes('unicode'));
});

test('a failed queue publication does not spend the peer admission', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 1, outPerHour: 1 } } });
  const id = ulid(NOW);
  await putMessage(h.kv, id, [{ text: 'hello' }]);
  const realLink = fs.linkSync;
  mock.method(fs, 'linkSync', (from, to) => {
    if (String(to).startsWith(h.dirs.queueRoot + path.sep)) throw Object.assign(new Error('fixture full'), { code: 'ENOSPC' });
    return realLink(from, to);
  });
  try {
    await intakeCycle(h.input);
  } finally {
    mock.restoreAll();
  }
  h.input.state = readState(path.join(h.dirs.stateDir, 'intake-state.json'));
  await intakeCycle(h.input);
  assert.ok(h.queueFiles(HANDLE).includes(id + '.json'));
  assert.deepEqual(h.overflowFiles(HANDLE), []);
});

test('prototype-named paired handles are independent peers', async () => {
  const handle = 'constructor';
  const h = harness({ profile: profileWith({ [handle]: pairedPeer(handle) }) });
  const id = ulid(NOW);
  await putMessage(h.kv, id, [{ text: 'hello' }], { peer: handle });
  await intakeCycle(h.input);
  assert.ok(h.queueFiles(handle).includes(id + '.json'));
});

test('a newline-suffixed peer id is rejected before any mirror lookup', async () => {
  const handle = 'alice\n';
  const h = harness({ profile: profileWith({ [handle]: pairedPeer(handle) }) });
  let lists = 0;
  const real = h.kv.list.bind(h.kv);
  h.kv.list = (a) => {
    lists++;
    return real(a);
  };
  await intakeCycle(h.input);
  assert.equal(lists, 0);
});

test('rate record stays deduped after it is archived within its window', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 1, outPerHour: 1 } } });
  for (let i = 0; i < 2; i++) await putMessage(h.kv, ulid(NOW + i), [{ text: 'hello' }]);
  await intakeCycle(h.input);
  const rate = h.queueFiles(HANDLE).find((x) => x.startsWith('rate-'));
  ensureRealDir(path.join(h.dirs.doneRoot, HANDLE), 0o700);
  fs.renameSync(path.join(h.dirs.queueRoot, HANDLE, rate), path.join(h.dirs.doneRoot, HANDLE, rate));
  await putMessage(h.kv, ulid(NOW + 5), [{ text: 'hello' }]);
  await intakeCycle(h.input);
  assert.equal(h.eventsNamed('peer-over-rate').length, 1);
});

test('overflow retention is finite: overflow files are retired after a month', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 1, outPerHour: 1 } } });
  for (let i = 0; i < 150; i++) await putMessage(h.kv, ulid(NOW + i), [{ text: 'hello' }]);
  await intakeCycle(h.input);
  assert.equal(h.overflowFiles(HANDLE).length, 149);
  h.setClock(NOW + 30 * DAY);
  await intakeCycle(h.input);
  assert.equal(h.overflowFiles(HANDLE).length, 0);
});

test('two stale-lock contenders cannot both acquire the lock', async () => {
  const { acquireLock } = await import('../dist/intake/queue.js');
  const h = harness();
  const file = path.join(h.dirs.stateDir, 'fixture.lock');
  fs.writeFileSync(file, '313131\n');
  const rename = fs.renameSync;
  let entered = false;
  let secondRelease;
  mock.method(process, 'kill', () => {
    throw Object.assign(new Error('fixture dead'), { code: 'ESRCH' });
  });
  mock.method(fs, 'renameSync', (from, to) => {
    if (from === file && !entered) {
      entered = true;
      secondRelease = acquireLock(file);
    }
    return rename(from, to);
  });
  let firstRelease;
  try {
    try {
      firstRelease = acquireLock(file);
    } catch (error) {
      assert.equal(error.code, 'locked');
    }
    assert.equal(Boolean(firstRelease) && Boolean(secondRelease), false);
  } finally {
    mock.restoreAll();
    firstRelease?.();
    secondRelease?.();
  }
});

test('a peers file swapped for a symlink between check and read is not trusted', async () => {
  const { loadPeers } = await import('../dist/intake/peers.js');
  const h = harness();
  const file = path.join(h.dirs.stateDir, 'peers.json');
  const other = file + '.replacement';
  fs.writeFileSync(file, JSON.stringify({ alice: { ratePerHour: 1 } }), { mode: 0o600 });
  fs.writeFileSync(other, JSON.stringify({ alice: { tier: 'trusted' } }), { mode: 0o666 });
  fs.chmodSync(other, 0o666);
  const fstat = fs.fstatSync;
  let swapped = false;
  mock.method(fs, 'fstatSync', (fd, ...rest) => {
    if (!swapped) {
      swapped = true;
      fs.unlinkSync(file);
      fs.symlinkSync(other, file);
    }
    return fstat(fd, ...rest);
  });
  try {
    let policy;
    let error;
    try {
      policy = loadPeers(file);
    } catch (e) {
      error = e;
    }
    assert.ok(swapped, 'the swap must land between the open and the check');
    if (error) assert.equal(error.code, 'insecure-peers');
    else assert.notEqual(policy.alice.tier, 'trusted', 'the replacement file must not be trusted');
  } finally {
    mock.restoreAll();
  }
});

test('an invalid policy reload cannot raise a previously lowered cap', async () => {
  const { loadPeers } = await import('../dist/intake/peers.js');
  const h = harness();
  const file = path.join(h.dirs.stateDir, 'peers.json');
  fs.writeFileSync(file, JSON.stringify({ alice: { ratePerHour: 1, outPerHour: 1 } }), { mode: 0o600 });
  assert.equal(loadPeers(file).alice.outPerHour, 1);
  fs.writeFileSync(file, JSON.stringify({ alice: { ratePerHour: 1, outPerHour: 101 } }));
  let peers;
  let error;
  try {
    peers = loadPeers(file);
  } catch (e) {
    error = e;
  }
  assert.ok(error || (peers.alice.outPerHour <= 1 && peers.alice.ratePerHour <= 1));
});

test('an overflowing ULID is rejected before any filesystem lookup', async () => {
  const h = harness();
  const id = 'Z'.repeat(26);
  await putMessage(h.kv, id, [{ text: 'hello' }]);
  const lstat = fs.lstatSync;
  let idLookups = 0;
  mock.method(fs, 'lstatSync', (p, ...args) => {
    if (String(p).includes(id)) idLookups++;
    return lstat(p, ...args);
  });
  try {
    await intakeCycle(h.input);
  } finally {
    mock.restoreAll();
  }
  assert.equal(idLookups, 0);
  assert.equal(h.doneFiles(HANDLE).length, 0);
});
