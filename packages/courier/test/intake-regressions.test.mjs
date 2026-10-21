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

test('admissions sharing one millisecond each count after the stored receipts are lost', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 2, outPerHour: 2 } } });
  await putMessage(h.kv, ulid(NOW), [{ text: 'a' }]);
  await putMessage(h.kv, ulid(NOW + 1), [{ text: 'b' }]);
  await intakeCycle(h.input);
  const queued = () => h.queueFiles(HANDLE).filter((x) => !x.startsWith('rate-'));
  assert.equal(queued().length, 2);
  h.input.state = { v: 1, peers: {} };
  await putMessage(h.kv, ulid(NOW + 2), [{ text: 'c' }]);
  await intakeCycle(h.input);
  assert.equal(queued().length, 2);
  assert.equal(h.overflowFiles(HANDLE).length, 1);
});

test('a queued admission whose state write failed still counts after restart', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 2, outPerHour: 2 } } });
  const stateFile = path.join(h.dirs.stateDir, 'intake-state.json');
  await putMessage(h.kv, ulid(NOW), [{ text: 'a' }]);
  await putMessage(h.kv, ulid(NOW + 1), [{ text: 'b' }]);
  const realRename = fs.renameSync;
  let stateWrites = 0;
  mock.method(fs, 'renameSync', (from, to) => {
    if (String(to) === stateFile && ++stateWrites === 2) throw Object.assign(new Error('fixture full'), { code: 'ENOSPC' });
    return realRename(from, to);
  });
  try {
    await intakeCycle(h.input);
  } finally {
    mock.restoreAll();
  }
  assert.equal(h.eventsNamed('intake-error').length, 1);
  const queued = () => h.queueFiles(HANDLE).filter((x) => !x.startsWith('rate-'));
  assert.equal(queued().length, 2);
  h.input.state = readState(stateFile);
  await putMessage(h.kv, ulid(NOW + 2), [{ text: 'c' }]);
  await intakeCycle(h.input);
  assert.equal(queued().length, 2);
  assert.equal(h.overflowFiles(HANDLE).length, 1);
});

test('two admissions at the same receive time both count after the first is archived and the second state write is lost', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 2, outPerHour: 2 } } });
  const stateFile = path.join(h.dirs.stateDir, 'intake-state.json');
  const queued = () => h.queueFiles(HANDLE).filter((x) => !x.startsWith('rate-'));
  const first = ulid(NOW);
  const second = ulid(NOW + 1);
  const third = ulid(NOW + 2);
  await putMessage(h.kv, first, [{ text: 'a' }]);
  await putMessage(h.kv, second, [{ text: 'b' }]);
  const realRename = fs.renameSync;
  let stateWrites = 0;
  mock.method(fs, 'renameSync', (from, to) => {
    if (String(to) === stateFile && ++stateWrites === 2) throw Object.assign(new Error('fixture full'), { code: 'ENOSPC' });
    return realRename(from, to);
  });
  try {
    await intakeCycle(h.input);
  } finally {
    mock.restoreAll();
  }
  assert.equal(queued().length, 2);
  // The owner archives A to done/; the state still holds A's receipt, and B's state write was lost.
  const doneDir = path.join(h.dirs.doneRoot, HANDLE);
  fs.mkdirSync(doneDir, { recursive: true });
  fs.renameSync(path.join(h.dirs.queueRoot, HANDLE, `${first}.json`), path.join(doneDir, `${first}.json`));
  h.input.state = readState(stateFile);
  await putMessage(h.kv, third, [{ text: 'c' }]);
  await intakeCycle(h.input);
  assert.deepEqual(queued(), [`${second}.json`]);
  assert.equal(h.overflowFiles(HANDLE).length, 1);
});

test('an idle cycle trims an overflow store above the per-peer cap, oldest first', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 1, outPerHour: 1 } } });
  const dir = path.join(h.dirs.overflowRoot, HANDLE);
  fs.mkdirSync(dir, { recursive: true });
  const names = [];
  for (let i = 0; i < 250; i++) {
    const name = `${ulid(NOW + i)}.json`;
    names.push(name);
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ receivedAt: new Date(NOW).toISOString() }));
  }
  await intakeCycle(h.input);
  assert.deepEqual(h.overflowFiles(HANDLE).sort(), names.slice(-200));
});

test('overflow files are retired once their message passes the stale horizon', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 1, outPerHour: 1 } } });
  for (let i = 0; i < 150; i++) await putMessage(h.kv, ulid(NOW + i), [{ text: 'hello' }]);
  await intakeCycle(h.input);
  assert.equal(h.overflowFiles(HANDLE).length, 149);
  h.setClock(NOW + 8 * DAY);
  await intakeCycle(h.input);
  assert.equal(h.overflowFiles(HANDLE).length, 0);
});

test('one cycle examines at most 200 mirror rows and the next cycle resumes after them', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 1, outPerHour: 1 } } });
  const ids = Array.from({ length: 450 }, (_, i) => ulid(NOW + i));
  for (const id of ids) await putMessage(h.kv, id, [{ text: 'hello' }]);
  const queuedMessages = () => h.queueFiles(HANDLE).filter((x) => !x.startsWith('rate-')).length;
  await intakeCycle(h.input);
  assert.equal(queuedMessages() + h.overflowFiles(HANDLE).length, 200);
  await intakeCycle(h.input);
  assert.deepEqual(
    h.overflowFiles(HANDLE),
    ids.slice(200, 400).map((id) => `${id}.json`).sort(),
  );
});

test('overflow is capped at 1 MiB and the oldest files go first', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 1, outPerHour: 1 } } });
  const text = 'x'.repeat(16 * 1024);
  for (let i = 0; i < 120; i++) await putMessage(h.kv, ulid(NOW + i), [{ text }]);
  await intakeCycle(h.input);
  const dir = path.join(h.dirs.overflowRoot, HANDLE);
  const bytes = h.overflowFiles(HANDLE).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  assert.ok(bytes <= 1024 * 1024, `overflow holds ${bytes} bytes`);
  assert.equal(h.overflowFiles(HANDLE).includes(`${ulid(NOW + 1)}.json`), false);
});

test('a message retired by the overflow cap is not admitted on a later cycle', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 1, outPerHour: 1 } } });
  for (let i = 0; i < 450; i++) await putMessage(h.kv, ulid(NOW + i), [{ text: 'hello' }]);
  for (let cycle = 0; cycle < 3; cycle++) await intakeCycle(h.input);
  assert.equal(await intakeCycle(h.input), 0);
  assert.equal(h.overflowFiles(HANDLE).length, 200);
});

test('an unparseable lock file is refused however old it is, and is never broken', async () => {
  const { acquireLock } = await import('../dist/intake/queue.js');
  const h = harness();
  const file = path.join(h.dirs.stateDir, 'old-empty.lock');
  fs.writeFileSync(file, '');
  const old = new Date(Date.now() - 365 * DAY);
  fs.utimesSync(file, old, old);
  assert.throws(() => acquireLock(file), { code: 'locked' });
  assert.equal(fs.readFileSync(file, 'utf8'), '');
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

function countGets(kv) {
  const keys = [];
  const real = kv.get;
  kv.get = async (key) => {
    keys.push(key);
    return real(key);
  };
  return keys;
}

function messageFiles(h) {
  return [...h.queueFiles(HANDLE), ...h.overflowFiles(HANDLE)].filter((x) => !x.startsWith('rate-')).sort();
}

test('a late older message is queued despite a newer arrival every hour', async () => {
  const h = harness({ batch: 2 });
  for (let i = 0; i < 4; i++) await putMessage(h.kv, ulid(NOW - (4 - i) * HOUR), [{ text: 'old' }]);
  const late = ulid(NOW - 3 * HOUR - 30 * 60_000);
  let admitted;
  for (let c = 0; c < 170; c++) {
    const clock = NOW + c * HOUR;
    h.setClock(clock);
    if (c === 3) await putMessage(h.kv, late, [{ text: 'late' }]);
    await putMessage(h.kv, ulid(clock - 60_000), [{ text: 'new' }]);
    await intakeCycle(h.input);
    if (admitted === undefined && h.queueFiles(HANDLE).includes(`${late}.json`)) admitted = c;
  }
  assert.notEqual(admitted, undefined);
});

test('a batch cap of three takes ten messages in four cycles with no repeats', async () => {
  const h = harness({ batch: 3 });
  for (let i = 0; i < 10; i++) await putMessage(h.kv, ulid(NOW - HOUR + i), [{ text: 'x' }]);
  const seen = [];
  for (let c = 0; c < 4; c++) {
    await intakeCycle(h.input);
    seen.push(messageFiles(h).length);
  }
  assert.deepEqual(seen, [3, 6, 9, 10]);
});

test('a message whose fetch throws does not stop the cursor', async () => {
  const h = harness({ batch: 1 });
  const ids = [ulid(NOW - 3 * HOUR), ulid(NOW - 2 * HOUR), ulid(NOW - HOUR)];
  for (const id of ids) await putMessage(h.kv, id, [{ text: 'x' }]);
  const realGet = h.kv.get;
  const bad = k.mirrorMsg(HANDLE, THREAD, ids[0]);
  h.kv.get = async (key) => {
    if (key === bad) throw new Error('boom');
    return realGet(key);
  };
  await intakeCycle(h.input);
  await intakeCycle(h.input);
  await intakeCycle(h.input);
  assert.deepEqual(messageFiles(h), [ids[1], ids[2]].map((id) => `${id}.json`).sort());
  assert.equal(readState(path.join(h.dirs.stateDir, 'intake-state.json')).peers[HANDLE].cursor, ids[2]);
});

test('the cursor is persisted, so a restarted process resumes after the last examined id', async () => {
  const h = harness({ batch: 2 });
  const ids = [0, 1, 2, 3, 4].map((i) => ulid(NOW - HOUR + i));
  for (const id of ids) await putMessage(h.kv, id, [{ text: 'x' }]);
  await intakeCycle(h.input);
  h.input.state = readState(path.join(h.dirs.stateDir, 'intake-state.json'));
  await intakeCycle(h.input);
  assert.deepEqual(messageFiles(h), ids.slice(0, 4).map((id) => `${id}.json`).sort());
});

test('a message older than seven days is skipped without a fetch or a marker', async () => {
  const h = harness();
  const old = ulid(NOW - 8 * DAY);
  await putMessage(h.kv, old, [{ text: 'x' }]);
  const keys = countGets(h.kv);
  await intakeCycle(h.input);
  assert.ok(!keys.includes(k.mirrorMsg(HANDLE, THREAD, old)));
  assert.deepEqual(messageFiles(h), []);
  assert.deepEqual(h.doneFiles(HANDLE), []);
});

test('a message stamped beyond the skew is skipped without a fetch or a marker', async () => {
  const h = harness();
  const future = ulid(NOW + 2 * HOUR);
  await putMessage(h.kv, future, [{ text: 'x' }]);
  const keys = countGets(h.kv);
  await intakeCycle(h.input);
  assert.ok(!keys.includes(k.mirrorMsg(HANDLE, THREAD, future)));
  assert.deepEqual(messageFiles(h), []);
  assert.deepEqual(h.doneFiles(HANDLE), []);
});

test('one cycle fetches at most the batch cap even when the mirror holds 5000 ids', async () => {
  const h = harness();
  for (let i = 0; i < 5000; i++) await putMessage(h.kv, ulid(NOW - HOUR + i), [{ text: 'x' }]);
  const keys = countGets(h.kv);
  await intakeCycle(h.input);
  assert.ok(keys.filter((key) => key.includes('/msg/')).length <= 200);
});

test('an id retired by the overflow cap keeps a done marker, so a later lap never fetches it again', async () => {
  const h = harness({ batch: 260, peers: { alice: { tier: 'strict', ratePerHour: 1, outPerHour: 1 } } });
  const ids = Array.from({ length: 260 }, (_, i) => ulid(NOW + i));
  for (const id of ids) await putMessage(h.kv, id, [{ text: 'hello' }]);
  const keys = countGets(h.kv);
  const fetches = (id) => keys.filter((key) => key === k.mirrorMsg(HANDLE, THREAD, id)).length;
  await intakeCycle(h.input);
  await intakeCycle(h.input);
  assert.equal(h.overflowFiles(HANDLE).length, 200);
  const retired = ids.slice(1, 60);
  for (const id of retired) {
    assert.equal(h.readDone(HANDLE, id).outcome, 'overflow');
    assert.equal(fetches(id), 1);
  }
  h.setClock(NOW + HOUR);
  await intakeCycle(h.input);
  for (const id of retired) {
    assert.equal(fetches(id), 1);
    assert.equal(h.queueFiles(HANDLE).includes(`${id}.json`), false);
    assert.equal(h.overflowFiles(HANDLE).includes(`${id}.json`), false);
  }
});

test('an overflow tombstone lives until its message id is 14 days old, then is pruned', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 1, outPerHour: 1 } } });
  const admitted = ulid(NOW);
  const overflowed = ulid(NOW + 1);
  await putMessage(h.kv, admitted, [{ text: 'hello' }]);
  await putMessage(h.kv, overflowed, [{ text: 'hello' }]);
  await intakeCycle(h.input);
  assert.deepEqual(h.overflowFiles(HANDLE), [`${overflowed}.json`]);
  h.setClock(NOW + 8 * DAY);
  await intakeCycle(h.input);
  assert.deepEqual(h.overflowFiles(HANDLE), []);
  assert.equal(h.readDone(HANDLE, overflowed).outcome, 'overflow');
  h.setClock(NOW + 14 * DAY - HOUR);
  await intakeCycle(h.input);
  assert.ok(h.doneFiles(HANDLE).includes(`${overflowed}.json`));
  h.setClock(NOW + 14 * DAY + HOUR);
  await intakeCycle(h.input);
  assert.equal(h.doneFiles(HANDLE).includes(`${overflowed}.json`), false);
});

test('the janitor retires at most 500 expired overflow files in one cycle, and converges to the cap', async () => {
  const h = harness();
  const dir = path.join(h.dirs.overflowRoot, HANDLE);
  ensureRealDir(dir, 0o700);
  const stamp = new Date(NOW - 8 * DAY).toISOString();
  for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(dir, `${ulid(NOW - 8 * DAY + i)}.json`), JSON.stringify({ receivedAt: stamp }));
  await intakeCycle(h.input);
  assert.ok(h.overflowFiles(HANDLE).length >= 4000, `${h.overflowFiles(HANDLE).length} files left after one cycle`);
  for (let cycle = 0; cycle < 10; cycle++) await intakeCycle(h.input);
  assert.ok(h.overflowFiles(HANDLE).length <= 200);
});

test('the janitor moves at most 500 expired queue records to done in one cycle', async () => {
  const h = harness();
  const dir = path.join(h.dirs.queueRoot, HANDLE);
  ensureRealDir(dir, 0o750);
  const stamp = new Date(NOW - 8 * DAY).toISOString();
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(dir, `${ulid(NOW - 8 * DAY + i)}.json`), JSON.stringify({ receivedAt: stamp }));
  await intakeCycle(h.input);
  assert.equal(h.doneFiles(HANDLE).length, 500);
});

test('receipts: owner-archived unreceipted admission is recovered', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 2, outPerHour: 2 } } });
  const stateFile = path.join(h.dirs.stateDir, 'intake-state.json');
  const a = ulid(NOW);
  const b = ulid(NOW + 1);
  const c = ulid(NOW + 2);
  await putMessage(h.kv, a, [{ text: 'a' }]);
  await intakeCycle(h.input);
  await putMessage(h.kv, b, [{ text: 'b' }]);
  const realRename = fs.renameSync;
  mock.method(fs, 'renameSync', (from, to) => {
    if (String(to) === stateFile) throw Object.assign(new Error('fixture full'), { code: 'ENOSPC' });
    return realRename(from, to);
  });
  try {
    await intakeCycle(h.input);
  } finally {
    mock.restoreAll();
  }
  assert.ok(h.queueFiles(HANDLE).includes(`${b}.json`));
  ensureRealDir(path.join(h.dirs.doneRoot, HANDLE), 0o700);
  fs.renameSync(path.join(h.dirs.queueRoot, HANDLE, `${b}.json`), path.join(h.dirs.doneRoot, HANDLE, `${b}.json`));
  h.input.state = readState(stateFile);
  await putMessage(h.kv, c, [{ text: 'c' }]);
  await intakeCycle(h.input);
  assert.ok(!h.queueFiles(HANDLE).includes(`${b}.json`), 'an archived admission is not admitted a second time');
  assert.ok(!h.queueFiles(HANDLE).includes(`${c}.json`), 'the cap of two still holds');
});

test('receipts: done entry older than the window is not counted', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 1, outPerHour: 1 } } });
  const old = ulid(NOW - 2 * HOUR);
  ensureRealDir(path.join(h.dirs.doneRoot, HANDLE), 0o700);
  const file = path.join(h.dirs.doneRoot, HANDLE, `${old}.json`);
  fs.writeFileSync(file, JSON.stringify({ receivedAt: new Date(NOW - 2 * HOUR).toISOString() }));
  fs.utimesSync(file, new Date(NOW - 2 * HOUR), new Date(NOW - 2 * HOUR));
  const fresh = ulid(NOW);
  await putMessage(h.kv, fresh, [{ text: 'hello' }]);
  await intakeCycle(h.input);
  assert.ok(h.queueFiles(HANDLE).includes(`${fresh}.json`));
});

test('receipts: reconcile reads peer records at start and after a persist failure only', async () => {
  const h = harness({ peers: { alice: { tier: 'strict', ratePerHour: 100, outPerHour: 100 } } });
  const stateFile = path.join(h.dirs.stateDir, 'intake-state.json');
  const queuePeer = path.join(h.dirs.queueRoot, HANDLE) + path.sep;
  const donePeer = path.join(h.dirs.doneRoot, HANDLE) + path.sep;
  const isPeerRecord = (p) => (String(p).startsWith(queuePeer) || String(p).startsWith(donePeer)) && String(p).endsWith('.json');
  let reads = 0;
  let failState = false;
  const realRead = fs.readFileSync;
  const realRename = fs.renameSync;
  // Admission lstat checks (presentIn) are not reconciliation work; only record-file reads are counted.
  mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (isPeerRecord(p)) reads++;
    return realRead(p, ...rest);
  });
  mock.method(fs, 'renameSync', (from, to) => {
    if (failState && String(to) === stateFile) throw Object.assign(new Error('fixture full'), { code: 'ENOSPC' });
    return realRename(from, to);
  });
  const cycle = async (n) => {
    await putMessage(h.kv, ulid(NOW + n), [{ text: 'x' }]);
    reads = 0;
    await intakeCycle(h.input);
    return reads;
  };
  try {
    assert.equal(await cycle(0), 0);
    assert.equal(await cycle(1), 0);
    assert.equal(await cycle(2), 0);
    const planted = ulid(NOW - 30 * 60_000);
    ensureRealDir(path.join(h.dirs.doneRoot, HANDLE), 0o700);
    fs.writeFileSync(path.join(h.dirs.doneRoot, HANDLE, `${planted}.json`), JSON.stringify({ receivedAt: new Date(NOW - 30 * 60_000).toISOString() }));
    failState = true;
    assert.equal(await cycle(3), 0);
    failState = false;
    assert.ok((await cycle(4)) > 0, 'the cycle after a persist failure reconciles');
    assert.equal(await cycle(5), 0);
  } finally {
    mock.restoreAll();
  }
});
