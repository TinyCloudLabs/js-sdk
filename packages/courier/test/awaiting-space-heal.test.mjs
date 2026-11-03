import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from '@tinycloud/node-sdk';
import { loadProfile, saveGrant, saveKey, saveProfile } from '../dist/profile.js';
import { AGENT_GRANT, COURIER_SPACE } from '../dist/keys.js';
import { siweTimes } from '../dist/authority.js';
import { courierNode } from '../dist/node.js';
import { noSpaceError } from '../dist/grant.js';
import { setProgramName } from '../dist/program.js';

// TC-2380: `awaiting-space` is a cached negative answer that courierNode asks again on every use.

const HOST = 'https://tee.node.tinycloud.xyz';
const DAY = 86_400_000;
const wasm = new NodeWasmBindings();

function agentKey() {
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('test');
  return { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: new Date().toISOString() };
}

async function signedGrant(agent) {
  const signer = new PrivateKeySigner(randomBytes(32).toString('hex'));
  const address = await signer.getAddress();
  const chainId = 1;
  const spaceId = wasm.makeSpaceId(address, chainId, COURIER_SPACE);
  const abilities = {};
  for (const permission of AGENT_GRANT) {
    const service = permission.service.replace(/^tinycloud\./, '');
    ((abilities[service] ??= {})[permission.path] ??= []).push(...permission.actions);
  }
  const issuedAt = new Date();
  const prepared = wasm.prepareSession({
    abilities, address, chainId, domain: 'courier.offline-test', issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + 30 * DAY).toISOString(), spaceId, jwk: agent.jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, address, chainId,
    siwe: prepared.siwe, signature, verificationMethod: agent.did, jwk: agent.jwk,
  };
}

/** A home holding an agent key, an installed grant and an `awaiting-space` profile that matches it. */
async function awaitingHome(run, { grant = true, spacePending = false } = {}) {
  const previous = process.env.COURIER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-heal-'));
  process.env.COURIER_HOME = home;
  try {
    const agent = agentKey();
    saveKey(agent);
    const signed = await signedGrant(agent);
    const expiresAt = siweTimes(signed.siwe).expiresAt.toISOString();
    const ownerDid = `did:pkh:eip155:${signed.chainId}:${signed.address}`;
    if (grant) saveGrant({ v: 1, ...signed, ownerDid, expiresAt, receivedAt: new Date().toISOString() });
    saveProfile({
      version: 3, host: HOST, openkeyHost: 'https://openkey.so', label: 'offline-test', courierDid: agent.did.split('#')[0],
      ownerDid, spaceId: signed.spaceId, grantExpiresAt: expiresAt, status: 'awaiting-space', ...(spacePending ? { spacePending: true } : {}), peers: {},
    });
    await run(home);
  } finally {
    if (previous === undefined) delete process.env.COURIER_HOME;
    else process.env.COURIER_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Answer the space read (`node.kv.list`) from `probe`; the existing tests stub it the same way. */
function stubProbe(t, probe) {
  const calls = { n: 0 };
  const descriptor = Object.getOwnPropertyDescriptor(TinyCloudNode.prototype, 'kv');
  Object.defineProperty(TinyCloudNode.prototype, 'kv', { configurable: true, get: () => ({ list: async (...args) => { calls.n++; return probe(...args); } }) });
  t.after(() => Object.defineProperty(TinyCloudNode.prototype, 'kv', descriptor));
  return calls;
}

const ready = async () => ({ ok: true, data: { keys: [] } });
const missing = async () => ({ ok: false, error: { status: 404, message: 'Space not found' } });
const noSpaceText = /space is missing; after hosting it, run `courier init --resume`/;
const pendingText = /still being set up by OpenKey; run `courier init --resume`/;

for (const spacePending of [false, true]) {
  test(`an awaiting-space profile whose space is now hosted becomes ready and the command runs (spacePending ${spacePending})`, async (t) => awaitingHome(async () => {
    const calls = stubProbe(t, ready);
    const profile = loadProfile();

    const node = await courierNode(profile);

    assert.ok(node instanceof TinyCloudNode);
    assert.equal(calls.n, 1, 'one probe');
    assert.equal(profile.status, 'ready');
    assert.equal('spacePending' in profile, false);
    const saved = loadProfile();
    assert.equal(saved.status, 'ready');
    assert.equal('spacePending' in saved, false);
    // The next command needs no probe at all.
    await courierNode(saved);
    assert.equal(calls.n, 1);
  }, { spacePending }));
}

test('an awaiting-space profile whose space is still missing keeps today\'s no-space error and is not changed', async (t) => awaitingHome(async (home) => {
  const calls = stubProbe(t, missing);
  const before = fs.readFileSync(path.join(home, 'profile.json'), 'utf8');

  await assert.rejects(courierNode(loadProfile()), { code: 'no-space', message: noSpaceText });
  assert.equal(calls.n, 1);
  assert.equal(fs.readFileSync(path.join(home, 'profile.json'), 'utf8'), before);
}));

test('a pending profile whose space is still missing keeps the pending text and its spacePending flag', async (t) => awaitingHome(async (home) => {
  stubProbe(t, missing);
  const before = fs.readFileSync(path.join(home, 'profile.json'), 'utf8');
  const profile = loadProfile();

  await assert.rejects(courierNode(profile), { code: 'no-space', message: pendingText });
  assert.equal(profile.status, 'awaiting-space');
  assert.equal(profile.spacePending, true);
  assert.equal(fs.readFileSync(path.join(home, 'profile.json'), 'utf8'), before);
}, { spacePending: true }));

test('a probe that cannot decide propagates its error and writes nothing', async (t) => awaitingHome(async (home) => {
  stubProbe(t, async () => { throw new Error('connect ECONNREFUSED'); });
  const before = fs.readFileSync(path.join(home, 'profile.json'), 'utf8');
  const profile = loadProfile();

  await assert.rejects(courierNode(profile), /ECONNREFUSED/);
  assert.equal(profile.status, 'awaiting-space');
  assert.equal(fs.readFileSync(path.join(home, 'profile.json'), 'utf8'), before);
}));

test('a refused save of the heal is propagated, never reported as success', async (t) => awaitingHome(async (home) => {
  stubProbe(t, async () => {
    // The profile file is replaced by something the save cannot write over, while the probe is in flight.
    fs.rmSync(path.join(home, 'profile.json'));
    fs.mkdirSync(path.join(home, 'profile.json'));
    return ready();
  });

  await assert.rejects(courierNode(loadProfile()), (error) => error.code !== 'no-space');
  assert.equal(fs.statSync(path.join(home, 'profile.json')).isDirectory(), true);
}));

test('an awaiting-space profile without a grant is still no-space and probes nothing', async (t) => awaitingHome(async () => {
  const calls = stubProbe(t, ready);

  await assert.rejects(courierNode(loadProfile()), { code: 'no-space', message: noSpaceText });
  assert.equal(calls.n, 0);
}, { grant: false }));

test('the no-space message gives both ways out and does not send the owner to Share (TC-2398)', () => {
  for (const [prog, cli] of [['courier', 'tc'], ['tc courier', 'tc'], ['tinycloud courier', 'tinycloud']]) {
    setProgramName(prog);
    try {
      const { code, message } = noSpaceError({ host: 'https://node.example' });
      assert.equal(code, 'no-space');
      assert.match(message, /Turn on Auto-Sign in OpenKey and approve the Courier request again/);
      assert.ok(message.includes(`\`${cli} space host agents\``));
      assert.ok(message.includes(`\`${prog} init --resume\``));
      assert.doesNotMatch(message, /share/i);
    } finally {
      setProgramName('courier');
    }
  }
});
