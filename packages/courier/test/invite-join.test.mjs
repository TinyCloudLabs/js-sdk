// State machine of `join` only. The KV store and acceptC are injected; delegation and
// signature checks run in the live two-account smoke, not here.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendHello, driveJoin } from '../dist/invite-commands.js';
import { secureSubdir } from '../dist/profile.js';
import { memoryKv } from './memory-kv.mjs';

const INVITE_ID = 'a'.repeat(25) + 'b';
const OTHER_ID = 'a'.repeat(25) + 'c';
const HELLO_KEY = 'in/hello.json';
const WELCOME_KEY = 'out/welcome.json';
const SENT_AT = '2026-10-07T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const OWNER_ADDRESS = '0x' + '1'.repeat(40);

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-join-'));
  process.env.COURIER_HOME = home;
});

afterEach(() => {
  delete process.env.COURIER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

/** Captures console.log only while fn runs. stdout is left alone: the node test reporter writes through it. */
async function capture(fn) {
  const out = [];
  const log = console.log;
  console.log = (...parts) => out.push(parts.join(' ') + '\n');
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return out.join('');
}

const blob = () => ({ inviteId: INVITE_ID, helloKey: HELLO_KEY, outPrefix: 'out/', expiresAt: FUTURE, oneTimeKey: { x: 'unused' }, permissions: {} });
const hello = () => ({ v: 1, inviteId: INVITE_ID, artifactB: {}, claimedLabel: 'Peer', sentAt: SENT_AT });
const state = (stage = 'hello-ready') => ({ v: 1, inviteId: INVITE_ID, blob: '{}', helloText: JSON.stringify(hello()), stage });

const artifactC = () => ({
  type: 'courier-pair', v: 0, step: 'C',
  from: { owner: `did:pkh:eip155:1:${OWNER_ADDRESS}`, courier: 'did:key:zCourier' },
  spaceId: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:agents`, peer: 'e2e-peer', callMe: 'e2e-owner', issuedAt: SENT_AT,
  delegation: 'delegation-bytes', delegationExpiresAt: FUTURE,
});
const welcome = (overrides = {}) => ({ v: 1, inviteId: INVITE_ID, tier: 'trusted-requested', artifactC: artifactC(), sentAt: SENT_AT, ...overrides });

function makeIO(kv, extra = {}) {
  const acceptC = [];
  return {
    acceptC,
    io: {
      kv: () => kv,
      acceptC: async (_profile, _node, artifact) => {
        acceptC.push(artifact);
        return { ok: true, peer: 'e2e-owner' };
      },
      pollMs: 1,
      waitMs: 60_000,
      ...extra,
    },
  };
}

const joinFile = () => path.join(secureSubdir('joins'), `${INVITE_ID}.json`);
const writeJoinFile = (s) => fs.writeFileSync(joinFile(), JSON.stringify(s), { mode: 0o600 });
const readJoinFile = () => JSON.parse(fs.readFileSync(joinFile(), 'utf8'));

test('sendHello writes the hello create-only and persists hello-sent', async () => {
  const kv = memoryKv();
  const s = state();
  writeJoinFile(s);
  await sendHello(blob(), s, makeIO(kv).io);
  assert.deepEqual(kv.rows.get(HELLO_KEY).value, hello());
  assert.equal(s.stage, 'hello-sent');
  assert.equal(readJoinFile().stage, 'hello-sent');
});

test('sendHello accepts a conflict only when the stored object is exactly this hello, and keeps it', async () => {
  const kv = memoryKv();
  await kv.put(HELLO_KEY, hello());
  const s = state();
  writeJoinFile(s);
  await sendHello(blob(), s, makeIO(kv).io);
  assert.equal(s.stage, 'hello-sent');
  assert.equal(readJoinFile().stage, 'hello-sent');
  assert.deepEqual(kv.rows.get(HELLO_KEY).value, hello());
});

test('sendHello on a conflict with a different stored hello waits for a welcome: hello-unconfirmed, nothing written over it', async () => {
  const kv = memoryKv();
  await kv.put(HELLO_KEY, { ...hello(), claimedLabel: 'Someone else' });
  const s = state();
  writeJoinFile(s);
  await capture(() => sendHello(blob(), s, makeIO(kv).io));
  assert.equal(s.stage, 'hello-unconfirmed');
  assert.equal(readJoinFile().stage, 'hello-unconfirmed');
  assert.equal(kv.rows.get(HELLO_KEY).value.claimedLabel, 'Someone else');
});

test('sendHello on a conflict it cannot read back (the one-time key cannot read in/) waits for a welcome: hello-unconfirmed', async () => {
  const kv = memoryKv();
  await kv.put(HELLO_KEY, hello());
  const unreadable = { ...kv, put: kv.put, get: async () => ({ ok: false, error: { code: 'KV_UNAUTHORIZED', message: 'unauthorized', service: 'kv', meta: { status: 401 } } }) };
  const s = state();
  await capture(() => sendHello(blob(), s, makeIO(unreadable).io));
  assert.equal(s.stage, 'hello-unconfirmed');
});

test('sendHello does not write again once hello-sent', async () => {
  const kv = memoryKv();
  let puts = 0;
  const put = kv.put;
  kv.put = async (...args) => {
    puts += 1;
    return put(...args);
  };
  await sendHello(blob(), state('hello-sent'), makeIO(kv).io);
  assert.equal(puts, 0);
});

test('sendHello rethrows a store failure other than conflict and stays hello-ready', async () => {
  const kv = memoryKv();
  kv.put = async () => ({ ok: false, error: { code: 'KV_SERVER_ERROR', message: 'boom', service: 'kv' } });
  const s = state();
  await assert.rejects(sendHello(blob(), s, makeIO(kv).io));
  assert.equal(s.stage, 'hello-ready');
  assert.equal(kv.rows.has(HELLO_KEY), false);
});

test('driveJoin: a rejected welcome ends the join without accepting', async () => {
  const kv = memoryKv();
  await kv.put(WELCOME_KEY, { v: 1, inviteId: INVITE_ID, tier: 'rejected', sentAt: SENT_AT });
  const s = state('hello-sent');
  writeJoinFile(s);
  const { io, acceptC } = makeIO(kv);
  const out = await capture(() => driveJoin({}, {}, blob(), s, io));
  assert.equal(acceptC.length, 0);
  assert.ok(out.includes('declined'));
  assert.equal(fs.existsSync(joinFile()), false);
});

test('driveJoin: an accepted welcome goes to acceptC and clears the join', async () => {
  const kv = memoryKv();
  await kv.put(WELCOME_KEY, welcome());
  const s = state('hello-sent');
  writeJoinFile(s);
  const { io, acceptC } = makeIO(kv);
  await capture(() => driveJoin({}, {}, blob(), s, io));
  assert.equal(acceptC.length, 1);
  assert.deepEqual(acceptC[0], artifactC());
  assert.equal(fs.existsSync(joinFile()), false);
});

test('driveJoin: a welcome for another invite is refused and the join stays pending', async () => {
  const kv = memoryKv();
  await kv.put(WELCOME_KEY, welcome({ inviteId: OTHER_ID }));
  const s = state('hello-sent');
  writeJoinFile(s);
  const { io, acceptC } = makeIO(kv);
  await assert.rejects(capture(() => driveJoin({}, {}, blob(), s, io)), { code: 'bad-welcome' });
  assert.equal(acceptC.length, 0);
  assert.equal(fs.existsSync(joinFile()), true);
});

test('driveJoin: no welcome before the wait cap reports pending and keeps the join', async () => {
  const kv = memoryKv();
  const s = state('hello-sent');
  writeJoinFile(s);
  const { io, acceptC } = makeIO(kv, { waitMs: 0 });
  const out = await capture(() => driveJoin({}, {}, blob(), s, io));
  assert.equal(acceptC.length, 0);
  assert.ok(out.includes('No reply yet'));
  assert.equal(fs.existsSync(joinFile()), true);
});

test('driveJoin: keeps polling until the welcome lands', async () => {
  const kv = memoryKv();
  const get = kv.get;
  let gets = 0;
  kv.get = async (key, options) => {
    gets += 1;
    if (gets === 3) await kv.put(WELCOME_KEY, welcome());
    return get(key, options);
  };
  const s = state('hello-sent');
  writeJoinFile(s);
  const { io, acceptC } = makeIO(kv);
  await capture(() => driveJoin({}, {}, blob(), s, io));
  assert.equal(gets, 3);
  assert.equal(acceptC.length, 1);
  assert.equal(fs.existsSync(joinFile()), false);
});
