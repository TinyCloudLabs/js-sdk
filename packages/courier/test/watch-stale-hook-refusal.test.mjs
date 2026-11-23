// TC-3522: the old hook can receive a terminal 401 after the successor was installed,
// but before the running watcher has reached its next scheduled reconciliation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { defer } from '../dist/defer.js';
import { recordAuthorityRefusal, watchPeerEligible } from '../dist/interim-runtime.js';
import { loadProfile, saveProfile } from '../dist/profile.js';
import { Watcher } from '../dist/watch.js';

const oldCid = 'old-inbound';
const newCid = 'installed-successor';
const laterCid = 'next-installed-successor';
const refuse = () => Object.assign(new Error('hook ticket refused'), { status: 401 });

test('old hook refusal cannot latch a successor, and installation rebinds hooks and sync immediately', { timeout: 10_000 }, async (t) => {
  const start = Date.parse('2026-11-23T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  fs.mkdirSync(process.env.COURIER_HOME, { mode: 0o700 });
  const inbound = (cid, endsInMs) => ({ cid, delegation: 'provided by fixture hook service', expiresAt: new Date(start + endsInMs).toISOString() });
  const ownerDid = 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111';
  const spaceId = 'tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:agents';
  const bob = { handle: 'bob', courierDid: 'did:key:bob', ownerDid, spaceId, theirHandleForMe: 'alice',
    status: 'paired', pairedAt: new Date(start).toISOString(), inbound: inbound(oldCid, 60_000), outbound: [] };
  saveProfile({ version: 4, status: 'ready', host: 'http://127.0.0.1:1', openkeyHost: 'http://127.0.0.1:1',
    label: 'alice', selfHandle: 'alice', courierDid: 'did:key:alice', ownerDid, spaceId, peers: { bob } });

  const hooks = new Map([oldCid, newCid, laterCid].map(cid => [cid, { open: defer(), reply: defer(), handled: defer() }]));
  const sync = new Map([newCid, laterCid].map(cid => [cid, defer()]));
  const oldSyncReply = defer();
  const verified = [];
  const abort = new AbortController();
  const kv = { get: async () => ({ ok: false, error: { status: 404 } }), list: async () => ({ ok: true, data: { keys: [] } }),
    put: async () => ({ ok: true, data: {} }) };
  const watcher = new Watcher({
    selfKv: kv, spaceId, loadPeers: () => Object.values(loadProfile().peers).filter(peer => watchPeerEligible(peer)),
    checkAuthority: async handle => {
      if (handle) verified.push(loadProfile().peers[handle].inbound.cid);
    },
    kvFor: async peer => {
      const cid = peer.inbound.cid;
      return { ...kv, list: async () => {
        if (sync.has(cid)) {
          assert.equal(verified.at(-1), cid, 'a sync must verify the new binding before listing it');
          sync.get(cid).resolve();
          if (cid === newCid) {
            await oldSyncReply.promise;
            throw refuse();
          }
        }
        return kv.list();
      } };
    },
    wake: async () => {}, log: () => {},
    selfHooks: { async *subscribe(_subscriptions, { signal }) {
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } },
    peerHooks: async peer => ({ async *subscribe(_subscriptions, { signal }) {
      const stream = hooks.get(peer.inbound.cid);
      stream.signal = signal;
      stream.open.resolve();
      await stream.reply.promise;
      throw refuse();
    } }),
    onAuthorityRefusal: async (source, ...rest) => {
      await recordAuthorityRefusal(source, ...rest);
      hooks.get(source.split(':')[2])?.handled.resolve();
    },
  }, { pollMs: 60_000, ticketSeconds: 25, debounceMs: 30_000, wakeBudget: 12 });

  const running = watcher.run(abort.signal);
  t.after(async () => {
    abort.abort();
    oldSyncReply.resolve();
    for (const stream of hooks.values()) stream.reply.resolve();
    await running;
  });
  const install = (cid, expires) => {
    const profile = loadProfile();
    profile.peers.bob.inbound = inbound(cid, expires);
    saveProfile(profile);
    return profile.peers.bob;
  };
  await hooks.get(oldCid).open.promise;
  install(newCid, 120_000); // Another Courier command already installed the successor.
  t.mock.timers.setTime(start + 61_000);
  hooks.get(oldCid).reply.resolve();
  await hooks.get(oldCid).handled.promise;
  assert.equal(loadProfile().peers.bob.interim?.inboundRefusedAt, undefined,
    'a 401 for an expired original must not be applied to the installed successor');
  await hooks.get(newCid).open.promise;
  await sync.get(newCid).promise;
  assert.equal(loadProfile().peers.bob.inbound.cid, newCid);

  // The watcher itself installs another successor. Neither the old stream nor the clock
  // wakes it up; the installation must rebind and verify the new CID before the next poll.
  watcher.inboundRenewed(install(laterCid, 180_000));
  await hooks.get(laterCid).open.promise;
  assert.equal(hooks.get(newCid).signal.aborted, true);
  oldSyncReply.resolve(); // Finish an in-flight old sync with a 401 after the new binding is installed.
  await sync.get(laterCid).promise;
  assert.equal(loadProfile().peers.bob.interim?.inboundRefusedAt, undefined);
  hooks.get(laterCid).reply.resolve();
  await hooks.get(laterCid).handled.promise;
  assert.equal(loadProfile().peers.bob.interim?.inboundRefusedAt, new Date(start + 61_000).toISOString());
});
