// TC-2917: the watcher's real run loop, hook supervisors and timers under mocked time. Healthy hooks deliver at once and
// the full catch-up listing falls back to every 5 minutes; a failed stream catches up at once and polls every minute
// until healthy; only dirty peers are listed in between; authority is still checked every cycle and before an import.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { Watcher } from '../dist/watch.js';
import { buildMessage } from '../dist/a2a.js';
import { k, PREFIX } from '../dist/keys.js';

const START = Date.parse('2026-11-13T12:00:00.000Z');
const POLL_MS = 60_000;

function category(name, op, key) {
  if (op === 'list') {
    if (key === k.pausedPrefix) return 'paused';
    if (key === k.approvalsPrefix) return 'approvals';
    if (key === k.wakeClaimsPrefix) return 'claims';
    return name === 'self' ? 'known' : 'threads';
  }
  if (key.endsWith('/receipts.json')) return 'receipts';
  if (key === k.watchState) return 'state';
  return 'item';
}

function memoryKv(name, count) {
  const rows = new Map();
  let sequence = 0;
  const kv = {
    rows,
    /** HTTP status every call answers with, e.g. 403 once a delegation is revoked. */
    refuse: undefined,
    /** Lists that fail (non-transient 400) before they succeed again. */
    failLists: 0,
    /** A put whose key matches fails once (non-transient 400). */
    failPut: undefined,
    async list({ prefix }) {
      count(`${name} list ${category(name, 'list', prefix)}`);
      if (kv.refuse) return { ok: false, error: { status: kv.refuse, message: 'refused' } };
      if (kv.failLists > 0) { kv.failLists--; return { ok: false, error: { status: 400, message: 'bad request' } }; }
      return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } };
    },
    async get(key) {
      count(`${name} get ${category(name, 'get', key)}`);
      if (kv.refuse) return { ok: false, error: { status: kv.refuse, message: 'refused' } };
      const row = rows.get(key);
      return row ? { ok: true, data: { data: row.value, headers: { etag: row.etag } } } : { ok: false, error: { status: 404, message: 'not found' } };
    },
    async batchGet(keys, options) {
      const results = [];
      for (const key of keys) results.push({ key, result: await this.get(key, options) });
      return { ok: true, data: { results, count: results.length } };
    },
    async put(key, value, options = {}) {
      count(`${name} put`);
      if (kv.failPut?.(key)) { kv.failPut = undefined; return { ok: false, error: { status: 400, message: 'bad request' } }; }
      const prior = rows.get(key);
      if (options.ifNoneMatch === '*' && prior) return { ok: false, error: { status: 412, message: 'precondition failed' } };
      if (options.ifMatch && options.ifMatch !== prior?.etag) return { ok: false, error: { status: 412, message: 'precondition failed' } };
      const etag = `e${++sequence}`;
      rows.set(key, { value: structuredClone(value), etag });
      return { ok: true, data: { data: undefined, headers: { etag } } };
    },
    async delete(key) {
      count(`${name} delete`);
      rows.delete(key);
      return { ok: true, data: undefined };
    },
  };
  return kv;
}

/** Hook services that stream pushed events until aborted, fail on demand, or refuse to open while `failing` is set. */
function hookHub() {
  const hub = { open: {}, failing: {}, opens: {} };
  hub.service = (name) => ({
    subscribe: (_subs, { signal }) => ({
      async *[Symbol.asyncIterator]() {
        hub.opens[name] = (hub.opens[name] ?? 0) + 1;
        if (hub.failing[name]) throw hub.failing[name];
        const queue = [];
        let wake = () => {};
        let failure;
        const stream = { push(event) { queue.push(event); wake(); }, fail(error) { failure = error; wake(); } };
        hub.open[name] = stream;
        const onAbort = () => wake();
        signal.addEventListener('abort', onAbort);
        try {
          while (!signal.aborted) {
            if (failure) throw failure;
            if (queue.length) { yield queue.shift(); continue; }
            await new Promise((resolve) => { wake = resolve; });
          }
        } finally {
          signal.removeEventListener('abort', onAbort);
          if (hub.open[name] === stream) delete hub.open[name];
        }
      },
    }),
  });
  return hub;
}

function world({ handles = ['bob', 'carol'], authority = () => {}, renew = () => {}, poll = POLL_MS } = {}) {
  const counts = {};
  const count = (key) => { counts[key] = (counts[key] ?? 0) + 1; };
  const selfKv = memoryKv('self', count);
  const peerKvs = new Map(handles.map((handle) => [handle, memoryKv(handle, count)]));
  const peers = handles.map((handle, i) => ({
    handle, ownerDid: `did:pkh:eip155:1:0x0${i + 2}`, courierDid: `did:key:z${handle}`,
    spaceId: `tinycloud:pkh:eip155:1:0x0${i + 2}:agents`, theirHandleForMe: 'alice',
    inbound: { delegation: 'wire', cid: `cid-${handle}`, expiresAt: new Date(START + 30 * 86_400_000).toISOString() },
    outbound: [], status: 'paired', pairedAt: new Date(START).toISOString(),
  }));
  const eligible = new Set(handles);
  const hub = hookHub();
  const events = [];
  const refusals = [];
  const watcher = new Watcher({
    selfKv,
    spaceId: 'tinycloud:pkh:eip155:1:0x01:agents',
    selfHooks: hub.service('approvals'),
    peerHooks: async (peer) => hub.service(peer.handle),
    loadPeers: () => peers.filter((peer) => eligible.has(peer.handle)),
    // The real peerKv reads the renewal marker unless told not to.
    kvFor: async (peer, again) => {
      if (again !== false) { count('marker get'); renew(peer, peerKvs.get(peer.handle)); }
      return peerKvs.get(peer.handle);
    },
    beforePoll: async () => count('owner preflight'),
    checkAuthority: async (handle) => { count(handle ? 'authority one' : 'authority all'); authority(handle, eligible); },
    onAuthorityRefusal: async (source) => { refusals.push(source); eligible.delete(source.split(':')[1]); },
    wake: async () => {},
    log: (event, fields) => events.push({ event, at: Date.now(), ...fields }),
    now: () => Date.now(), // the mocked clock, whenever the test enables it
  }, { debounceMs: 30_000, pollMs: poll, ticketSeconds: 25, wakeBudget: 12 });
  const write = (handle, threadId = ulid()) => {
    const message = buildMessage({ threadId, text: 'hi', role: 'ROLE_USER', intent: 'inform', from: { owner: 'did:pkh:x', agent: `did:key:z${handle}`, label: handle } });
    message.messageId = ulid();
    const key = `${PREFIX}/to/alice/threads/${threadId}/msg/${message.messageId}.json`;
    peerKvs.get(handle).rows.set(key, { value: message, etag: 'r' });
    return { id: message.messageId, key, at: Date.now() };
  };
  const delivered = (id) => events.find((e) => e.event === 'delivered' && e.messageId === id);
  const take = () => { const taken = { ...counts }; for (const key of Object.keys(counts)) delete counts[key]; return taken; };
  return { watcher, hub, peerKvs, peers, eligible, counts, take, events, refusals, write, delivered, selfKv };
}

async function flush() {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function advance(ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    mock.timers.tick(1000);
    await flush();
  }
}

/** Runs the watcher for real; returns once its startup catch-up has run (3 s in). */
async function start(w) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
  const stop = new AbortController();
  const running = w.watcher.run(stop.signal);
  await flush();
  await advance(3000);
  return async () => {
    stop.abort();
    await flush();
    await running;
    mock.timers.reset();
  };
}

test('an idle hour with healthy hooks: one listing per peer every 5 minutes, one shared pause listing, authority every 5 minutes', async (t) => {
  const w = world();
  const stop = await start(w);
  try {
    w.take();
    await advance(3600_000);
    const counts = w.take();
    t.diagnostic(`idle hour, 2 peers: ${JSON.stringify(counts)}`);
    for (const handle of ['bob', 'carol']) assert.equal(counts[`${handle} list threads`], 12, `${handle} is listed by the 5-minute fallback only`);
    assert.equal(counts['self list paused'], 12, 'one pause listing per catch-up, shared by both peers');
    assert.equal(counts['self list approvals'], 12);
    assert.equal(counts['self list known'], undefined, 'known threads are listed only for a peer pause notice');
    assert.equal(counts['self get receipts'], undefined, 'receipts are read only for a message they are not known to cover');
    assert.equal(counts['marker get'], 24, 'renewal markers are read once per renewal check, not every minute');
    assert.equal(counts['authority all'], 12, 'the renewal and authority check runs every 5 minutes');
    assert.equal(counts['authority one'], undefined);
    assert.equal(counts['owner preflight'], 60, 'the local owner preflight still runs every minute');
    assert.equal(counts['self put'], undefined, 'an idle hour writes nothing');
  } finally { await stop(); }
});

test('a hook event delivers at once, lists only that peer, and reads the renewal marker only for a marker event', async () => {
  const w = world();
  const stop = await start(w);
  try {
    w.take();
    const sent = w.write('bob');
    w.hub.open.bob.push({ path: sent.key });
    await flush();
    const got = w.delivered(sent.id);
    assert.equal(got?.via, 'hook');
    assert.equal(got.at, sent.at, 'delivered without waiting for any timer');
    let counts = w.take();
    assert.equal(counts['bob list threads'], 1);
    assert.equal(counts['carol list threads'], undefined, 'carol is not listed');
    assert.equal(counts['self list paused'], 1, 'a hook sync reads the pause markers itself');
    assert.equal(counts['marker get'], undefined, 'the startup catch-up already read the marker');
    w.hub.open.bob.push({ path: `${PREFIX}/to/alice/pairing/delegation.json` });
    await flush();
    counts = w.take();
    assert.equal(counts['marker get'], 1, 'a renewal marker event reads the marker');
    await advance(300_000); // the full catch-up at 302 s lists bob's delivered message again
    assert.equal(w.take()['self get receipts'], undefined, 'receipts already known to cover it are not read again');
  } finally { await stop(); }
});

test('a write whose hook event was missed is caught by the next full catch-up, within 5 minutes', async () => {
  const w = world();
  const stop = await start(w);
  try {
    await advance(300_000); // the full catch-up at 302 s has just run
    const sent = w.write('carol');
    let waited = 0;
    while (!w.delivered(sent.id) && waited < 400_000) { await advance(1000); waited += 1000; }
    const got = w.delivered(sent.id);
    assert.equal(got?.via, 'poll');
    assert.ok(got.at - sent.at <= 300_000, `delivered after ${got.at - sent.at} ms`);
    assert.ok(got.at - sent.at > POLL_MS, 'with healthy hooks the minute cycle does not list everything');
  } finally { await stop(); }
});

test('a failed hook stream catches up at once and lists everything every minute until a new stream is healthy', async () => {
  const w = world();
  const stop = await start(w);
  try {
    await advance(97_000); // 100 s
    const sent = w.write('bob'); // no event: the stream is about to fail
    w.hub.failing.bob = new Error('stream reset');
    w.hub.open.bob.fail(new Error('stream reset'));
    await flush();
    assert.equal(w.delivered(sent.id)?.at, sent.at, 'the failure itself triggers the catch-up');
    w.take();
    await advance(180_000); // 280 s: re-subscribing keeps failing (backoff 15, 30, 60 s)
    let counts = w.take();
    assert.equal(counts['carol list threads'], 3, `unhealthy: everything listed at 122, 182 and 242 s (${JSON.stringify(counts)})`);
    delete w.hub.failing.bob; // the reopen at 325 s succeeds and proves itself after one 25 s ticket
    await advance(30_000); // 310 s, through the 302 s cycle (still unhealthy: full)
    assert.equal(w.take()['carol list threads'], 1);
    await advance(290_000); // 600 s: healthy again, so the cycles at 362-542 s list nothing
    counts = w.take();
    assert.equal(counts['carol list threads'], undefined, `healthy again: no full listing (${JSON.stringify(counts)})`);
    assert.equal(w.hub.opens.bob, 5, 'startup, three failed reopens, one healthy reopen');
    await advance(5000); // 605 s
    assert.equal(w.take()['carol list threads'], 1, 'the 5-minute fallback resumes at 602 s');
  } finally { await stop(); }
});

test('a sync that did not finish leaves its peer dirty: the next minute lists only that peer again', async () => {
  const w = world();
  const stop = await start(w);
  try {
    await advance(298_000); // 301 s
    w.peerKvs.get('carol').failLists = 1; // fails in the 302 s full catch-up
    await advance(1000);
    w.take();
    await advance(60_000); // the 362 s cycle
    const counts = w.take();
    assert.equal(counts['carol list threads'], 1, `only carol is listed again (${JSON.stringify(counts)})`);
    assert.equal(counts['bob list threads'], undefined);
    assert.equal(counts['self list paused'], 1);
    await advance(60_000);
    assert.equal(w.take()['carol list threads'], undefined, 'clean again: nothing until the next fallback');
    w.selfKv.failPut = (key) => key.includes('/mirror/'); // this message's mirror write fails, so it is not receipted
    const sent = w.write('bob');
    w.hub.open.bob.push({ path: sent.key });
    await flush();
    assert.equal(w.delivered(sent.id), undefined);
    await advance(60_000);
    assert.equal(w.delivered(sent.id)?.via, 'poll', 'retried by the next minute cycle, not the 5-minute fallback');
  } finally { await stop(); }
});

test('a refusal re-reads the renewal marker and checks authority at once; it retries only under a different grant', async () => {
  const revoked = world({ handles: ['bob'] });
  revoked.peerKvs.get('bob').refuse = 403;
  revoked.write('bob');
  await revoked.watcher.sync(revoked.peers[0], 'hook');
  assert.deepEqual(revoked.refusals, ['peer:bob']);
  assert.equal(revoked.counts['marker get'], 1, 'the marker is read before the refusal is recorded');
  assert.equal(revoked.counts['authority one'], 1, 'and the peer is checked at once');
  assert.equal(revoked.counts['bob list threads'], 1, 'the same grant is never tried again');
  assert.equal(revoked.counts['self put'], undefined, 'nothing from a refused peer is imported');

  // peerKv adopts a newer delegation from the marker; the retry runs under it.
  const renewed = world({ handles: ['bob'], renew: (peer, kv) => { kv.refuse = undefined; peer.inbound = { ...peer.inbound, cid: 'cid-bob-2' }; } });
  renewed.peerKvs.get('bob').refuse = 403;
  const sent = renewed.write('bob');
  await renewed.watcher.sync(renewed.peers[0], 'hook');
  assert.deepEqual(renewed.refusals, []);
  assert.ok(renewed.delivered(sent.id));
  assert.equal(renewed.counts['bob list threads'], 2);
});

test('a delegation marker hook event checks that peer\'s authority at once, before its listing', async () => {
  const w = world();
  const stop = await start(w);
  try {
    w.take();
    w.hub.open.bob.push({ path: `${PREFIX}/to/alice/pairing/delegation.json` });
    await flush();
    const counts = w.take();
    assert.equal(counts['authority one'], 1);
    assert.equal(counts['marker get'], 1);
    w.hub.open.bob.push({ path: `${PREFIX}/to/alice/threads/T/msg/M.json` });
    await flush();
    assert.equal(w.take()['authority one'], undefined, 'a message event does not');
  } finally { await stop(); }
});

test('a peer whose authority is revoked is checked before an import and nothing from it is imported', async () => {
  const w = world({ handles: ['bob'], authority: (handle, eligible) => { if (handle) eligible.delete(handle); } });
  const sent = w.write('bob');
  await w.watcher.sync(w.peers[0], 'hook');
  assert.equal(w.counts['authority one'], 1);
  assert.equal(w.delivered(sent.id), undefined);
  assert.equal(w.counts['self put'], undefined, 'no mirror, receipt or state write');
});

test('every sync that imports takes a fresh authority verdict, however recent the last one; a sync with nothing new takes none', async () => {
  const w = world({ handles: ['bob'] });
  const first = w.write('bob');
  await w.watcher.sync(w.peers[0], 'hook');
  assert.ok(w.delivered(first.id));
  assert.equal(w.counts['authority one'], 1);
  w.write('bob');
  w.write('bob');
  await w.watcher.sync(w.peers[0], 'hook');
  assert.equal(w.counts['authority one'], 2, 'checked again at once: no cached verdict, one check for both messages');
  await w.watcher.sync(w.peers[0], 'hook');
  assert.equal(w.counts['authority one'], 2, 'nothing new to import: no check');
});

test('a queued wake re-checks authority right before the adapter; a removed or refused peer\'s wake is dropped', async () => {
  const wakes = [];
  let revoked = false;
  const w = world({ handles: ['bob'], authority: (handle, eligible) => { if (handle && revoked) eligible.delete(handle); } });
  w.watcher.deps.wake = async (request) => { wakes.push(request); };
  const sent = buildMessage({ threadId: 'T1', text: 'hi', role: 'ROLE_USER', intent: 'request', from: { owner: 'o', agent: 'a' } });
  sent.messageId = '01J0000000000000000000000A';
  w.peerKvs.get('bob').rows.set(`${PREFIX}/to/alice/threads/T1/msg/${sent.messageId}.json`, { value: sent, etag: 'r' });
  await w.watcher.sync(w.peers[0], 'hook');
  assert.equal(Object.keys(w.watcher.snapshot().pending).length, 1, 'queued while the peer was authorized');
  revoked = true; // revoked after the message was queued, before the wake
  await w.watcher.tick(true);
  assert.equal(wakes.length, 0, 'the adapter never ran');
  assert.deepEqual(w.watcher.snapshot().pending, {}, 'the request is dropped, not retried');
  assert.ok(w.events.some((e) => e.event === 'wake-dropped' && e.peer === 'bob' && e.reason === 'peer-not-authorized'));
  assert.equal([...w.selfKv.rows.keys()].some((key) => key.includes('/wake-claims/')), false, 'its claim is released');

  const ok = world({ handles: ['bob'] });
  const okWakes = [];
  ok.watcher.deps.wake = async (request) => { okWakes.push(request); };
  ok.peerKvs.get('bob').rows.set(`${PREFIX}/to/alice/threads/T1/msg/${sent.messageId}.json`, { value: sent, etag: 'r' });
  await ok.watcher.sync(ok.peers[0], 'hook');
  const before = ok.counts['authority one'];
  await ok.watcher.tick(true);
  assert.equal(okWakes.length, 1);
  assert.equal(ok.counts['authority one'], before + 1, 'a fresh check right before the adapter, not the import\'s verdict');
});

test('with --poll above 5 minutes, authority housekeeping and dirty-peer retries still run every 5 minutes', async () => {
  const w = world({ poll: 900_000 });
  const stop = await start(w);
  try {
    w.take();
    w.peerKvs.get('carol').failLists = 1;
    await advance(3600_000);
    const counts = w.take();
    assert.equal(counts['authority all'], 12, `every 5 minutes, not every 15 (${JSON.stringify(counts)})`);
    assert.equal(counts['bob list threads'], 4, 'the healthy fallback follows the longer --poll: every 15 minutes');
    assert.equal(counts['carol list threads'], 5, 'the failed listing is retried at the next 5-minute cycle');
  } finally { await stop(); }
});
