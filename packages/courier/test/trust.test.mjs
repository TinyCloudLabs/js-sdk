import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from '@tinycloud/node-sdk';
import { openKeyDelegateUrl, parseGrantPayload, installGrant, resumeGrant } from '../dist/grant.js';
import { loadKey, loadProfile, saveGrant, saveKey, saveProfile } from '../dist/profile.js';
import { AGENT_GRANT, COURIER_SPACE, PREFIX } from '../dist/keys.js';
import { assertAgentGrant, siweTimes } from '../dist/authority.js';
import { nodeOpts, courierNode } from '../dist/node.js';
import { getJson } from '../dist/store.js';
import { validateArtifactIdentity } from '../dist/pairing.js';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';

const key = {
  v: 1,
  did: 'did:key:z6Mkagent#z6Mkagent',
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'public-x', d: 'private-d', k: 'private-k' },
  createdAt: new Date(0).toISOString(),
};

function payload(overrides = {}) {
  return {
    delegationHeader: { Authorization: 'Bearer session' },
    delegationCid: 'cid',
    spaceId: 'tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:agents',
    address: '0x0000000000000000000000000000000000000001',
    chainId: 1,
    siwe: 'SIWE',
    signature: 'signature',
    verificationMethod: key.did,
    jwk: { x: 'public-x' },
    ...overrides,
  };
}

test('delegate URL contains only public key and restricted permissions', () => {
  const query = new URL(openKeyDelegateUrl({
    openkeyHost: 'https://openkey.so/',
    did: key.did,
    publicJwk: key.jwk,
    host: 'https://tee.node.tinycloud.xyz',
    permissions: AGENT_GRANT,
    reason: 'Courier restricted grant',
    expiry: '30d',
    callback: 'http://127.0.0.1:1234/callback',
  }));
  assert.equal(query.pathname, '/delegate');
  assert.equal(query.searchParams.get('protocolVersion'), '1');
  assert.equal(query.searchParams.get('callback'), 'http://127.0.0.1:1234/callback');
  assert.equal(query.searchParams.get('did'), key.did);
  const jwk = JSON.parse(Buffer.from(query.searchParams.get('jwk'), 'base64url').toString());
  assert.equal(jwk.x, 'public-x');
  assert.equal('d' in jwk, false);
  assert.equal('k' in jwk, false);
  const permissions = JSON.parse(Buffer.from(query.searchParams.get('permissions'), 'base64url').toString());
  assert.deepEqual(permissions.permissions, AGENT_GRANT);
  assert.equal(query.searchParams.get('expiry'), '30d');
});

test('grant payload must target this agent key', () => {
  assert.equal(parseGrantPayload(payload(), key).delegationCid, 'cid');
  assert.equal(parseGrantPayload(Buffer.from(JSON.stringify(payload())).toString('base64url'), key).delegationCid, 'cid');
  assert.throws(() => parseGrantPayload(payload({ verificationMethod: 'did:key:someone-else#key' }), key), { code: 'bad-grant' });
  assert.throws(() => parseGrantPayload(payload({ jwk: { x: 'wrong' } }), key), { code: 'bad-grant' });
  assert.throws(() => parseGrantPayload({ ...payload(), delegationHeader: {} }, key), { code: 'bad-grant' });
});

test('profile identities are atomically stored with private modes', () => {
  const previous = process.env.COURIER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-profile-'));
  process.env.COURIER_HOME = home;
  try {
    saveKey(key);
    saveProfile({
      version: 3,
      host: 'https://tee.node.tinycloud.xyz',
      openkeyHost: 'https://openkey.so',
      label: 'test',
      courierDid: 'did:key:z6Mkagent',
      status: 'awaiting-grant',
      peers: {},
    });
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    for (const file of ['key.json', 'profile.json']) assert.equal(fs.statSync(path.join(home, file)).mode & 0o777, 0o600);
    assert.equal(loadKey().did, key.did);
    fs.chmodSync(path.join(home, 'key.json'), 0o644);
    assert.throws(() => loadKey(), { code: 'insecure-profile' });
    fs.chmodSync(path.join(home, 'key.json'), 0o600);
    fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ version: 2 }), { mode: 0o600 });
    assert.throws(() => loadProfile(), { code: 'profile-outdated' });
    fs.chmodSync(home, 0o755);
    assert.throws(() => loadKey(), { code: 'insecure-profile' });
  } finally {
    process.env.COURIER_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('grant permissions and hook all name the canonical agents space', () => {
  assert.equal(COURIER_SPACE, 'agents');
  assert.ok(AGENT_GRANT.every((entry) => entry.space === COURIER_SPACE));
  assert.ok(AGENT_GRANT.some((entry) => entry.path === `${PREFIX}/to/`));
});

test('installGrant rejects the old applications space before networking or persistence', async () => {
  const previous = process.env.COURIER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-wrong-space-'));
  process.env.COURIER_HOME = home;
  const profile = {
    version: 3,
    host: 'https://tee.node.tinycloud.xyz',
    openkeyHost: 'https://openkey.so',
    label: 'test',
    courierDid: 'did:key:z6Mkagent',
    status: 'awaiting-grant',
    peers: {},
  };
  try {
    await assert.rejects(installGrant(profile, key, payload({
      spaceId: 'tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications',
    })), { code: 'bad-grant' });
    assert.equal(fs.existsSync(path.join(home, 'grant.json')), false);
  } finally {
    if (previous === undefined) delete process.env.COURIER_HOME;
    else process.env.COURIER_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pair identity accepts agents and rejects applications across mixed-case addresses', () => {
  const owner = `did:pkh:eip155:1:0x${'a'.repeat(40)}`;
  const artifact = {
    type: 'courier-pair',
    v: 0,
    step: 'A',
    from: { owner, courier: 'did:key:zPeer' },
    spaceId: `tinycloud:pkh:eip155:1:0x${'A'.repeat(40)}:agents`,
    peer: 'alice',
    callMe: 'bob',
    issuedAt: new Date(0).toISOString(),
  };
  assert.doesNotThrow(() => validateArtifactIdentity(artifact));
  assert.throws(() => validateArtifactIdentity({
    ...artifact,
    spaceId: `tinycloud:pkh:eip155:1:0x${'A'.repeat(40)}:applications`,
  }), { code: 'bad-artifact' });
});

test('init --resume is limited to awaiting-space profiles', async () => {
  const previous = process.env.COURIER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-resume-'));
  process.env.COURIER_HOME = home;
  try {
    await assert.rejects(cmdInit(parseArgs(['--resume'])), { code: 'no-grant' });
    await assert.rejects(cmdInit(parseArgs(['--resume', '--request'])), { code: 'usage' });
    saveKey(key);
    saveProfile({
      version: 3,
      host: 'https://tee.node.tinycloud.xyz',
      openkeyHost: 'https://openkey.so',
      label: 'test',
      courierDid: 'did:key:z6Mkagent',
      status: 'awaiting-grant',
      peers: {},
    });
    await assert.rejects(cmdInit(parseArgs(['--resume'])), { code: 'usage' });
    const profile = loadProfile();
    profile.status = 'awaiting-space';
    saveProfile(profile);
    await assert.rejects(cmdInit(parseArgs(['--resume'])), { code: 'no-grant' });
  } finally {
    if (previous === undefined) delete process.env.COURIER_HOME;
    else process.env.COURIER_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('getJson distinguishes missing keys from missing spaces', async () => {
  const missingKey = { async get() { return { ok: false, error: { status: 404, message: 'Not found' } }; } };
  assert.equal(await getJson(missingKey, 'key'), undefined);
  const missingSpace = { async get() { return { ok: false, error: { status: 404, message: 'Space not found' } }; } };
  await assert.rejects(getJson(missingSpace, 'key'), { code: 'no-space' });
});

const HOST = 'https://tee.node.tinycloud.xyz';
const DAY = 86_400_000;
const wasm = new NodeWasmBindings();

function agentKey() {
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('test');
  return {
    v: 1,
    jwk: JSON.parse(manager.jwk(id)),
    did: manager.getDID(id),
    createdAt: new Date().toISOString(),
  };
}

async function signedGrant(agent, { extra = [], lifetimeMs = 30 * DAY, issuedAt = new Date() } = {}) {
  const privateKey = randomBytes(32).toString('hex');
  const signer = new PrivateKeySigner(privateKey);
  const address = await signer.getAddress();
  const chainId = 1;
  const spaceId = wasm.makeSpaceId(address, chainId, COURIER_SPACE);
  const abilities = {};
  for (const permission of [...AGENT_GRANT, ...extra]) {
    const service = permission.service.replace(/^tinycloud\./, '');
    const actions = abilities[service] ??= {};
    (actions[permission.path] ??= []).push(...permission.actions);
  }
  const prepared = wasm.prepareSession({
    abilities,
    address,
    chainId,
    domain: 'courier.offline-test',
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + lifetimeMs).toISOString(),
    spaceId,
    jwk: agent.jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    delegationHeader: session.delegationHeader,
    delegationCid: session.delegationCid,
    spaceId,
    address,
    chainId,
    siwe: prepared.siwe,
    signature,
    verificationMethod: agent.did,
    jwk: agent.jwk,
  };
}

function profileFor(agent, status = 'awaiting-grant') {
  return {
    version: 3,
    host: HOST,
    openkeyHost: 'https://openkey.so',
    label: 'offline-test',
    courierDid: agent.did.split('#')[0],
    status,
    peers: {},
  };
}

function withHome(run) {
  const previous = process.env.COURIER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-authority-'));
  process.env.COURIER_HOME = home;
  return Promise.resolve().then(() => run(home)).finally(() => {
    if (previous === undefined) delete process.env.COURIER_HOME;
    else process.env.COURIER_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

function grantExtraHost() {
  return { service: 'tinycloud.space', space: 'agents', path: '', actions: ['tinycloud.space/host'] };
}

test('restored exact grant passes assertAgentGrant', async () => {
  const agent = agentKey();
  const signed = await signedGrant(agent);
  const times = siweTimes(signed.siwe);
  const node = new TinyCloudNode(nodeOpts(HOST));
  await node.restoreSession({
    delegationHeader: signed.delegationHeader,
    delegationCid: signed.delegationCid,
    spaceId: signed.spaceId,
    jwk: agent.jwk,
    verificationMethod: signed.verificationMethod,
    address: signed.address,
    chainId: signed.chainId,
    siwe: signed.siwe,
    signature: signed.signature,
    expiresAt: times.expiresAt.toISOString(),
    tinycloudHosts: [HOST],
  });
  assert.doesNotThrow(() => assertAgentGrant(node.getVerifiedSessionCapabilities(), times));
});

test('installGrant rejects signed host authority before persistence', async () => withHome(async () => {
  const agent = agentKey();
  await assert.rejects(installGrant(profileFor(agent), agent, await signedGrant(agent, { extra: [grantExtraHost()] })), { code: 'grant-too-broad' });
  assert.equal(fs.existsSync(path.join(process.env.COURIER_HOME, 'grant.json')), false);
}));

test('init --grant-file rejects a signed 365-day grant', async () => withHome(async (home) => {
  const agent = agentKey();
  saveKey(agent);
  saveProfile(profileFor(agent));
  const grantPath = path.join(home, 'long-grant.json');
  fs.writeFileSync(grantPath, JSON.stringify(await signedGrant(agent, { lifetimeMs: 365 * DAY })));
  await assert.rejects(cmdInit(parseArgs(['--grant-file', grantPath])), { code: 'grant-too-long' });
  assert.equal(fs.existsSync(path.join(home, 'grant.json')), false);
}));

test('init --resume revalidates the saved grant', async () => withHome(async (home) => {
  for (const [overrides, code] of [
    [{ extra: [grantExtraHost()] }, 'grant-too-broad'],
    [{ lifetimeMs: 365 * DAY }, 'grant-too-long'],
  ]) {
    const agent = agentKey();
    saveKey(agent);
    const profile = profileFor(agent, 'awaiting-space');
    saveProfile(profile);
    const signed = await signedGrant(agent, overrides);
    const times = siweTimes(signed.siwe);
    saveGrant({
      v: 1,
      ...signed,
      ownerDid: `did:pkh:eip155:${signed.chainId}:${signed.address}`,
      expiresAt: times.expiresAt.toISOString(),
      receivedAt: new Date().toISOString(),
    });
    await assert.rejects(cmdInit(parseArgs(['--resume'])), { code });
    assert.equal(loadProfile().status, 'awaiting-space');
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home, { mode: 0o700 });
  }
}));

test('init rejects --expiry above 30 days before writing a profile', async () => withHome(async (home) => {
  await assert.rejects(cmdInit(parseArgs(['--request', '--expiry', '60d'])), { code: 'usage' });
  assert.equal(fs.existsSync(path.join(home, 'profile.json')), false);
}));


function stubSpaceProbe(t, probe) {
  const descriptor = Object.getOwnPropertyDescriptor(TinyCloudNode.prototype, 'kv');
  Object.defineProperty(TinyCloudNode.prototype, 'kv', {
    configurable: true,
    get: () => ({ list: probe }),
  });
  t.after(() => Object.defineProperty(TinyCloudNode.prototype, 'kv', descriptor));
  const started = Date.now();
  let elapsed = 0;
  const sleeps = [];
  const messages = [];
  t.mock.method(Date, 'now', () => started + elapsed);
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    sleeps.push(ms);
    elapsed += ms;
    queueMicrotask(callback);
    return 0;
  });
  t.mock.method(console, 'error', (message) => messages.push(message));
  return { sleeps, messages, elapsed: () => elapsed };
}

const missingSpace = () => ({ ok: false, error: { status: 404, message: 'Space not found' } });
const readySpace = () => ({ ok: true, data: { keys: [] } });

test('install without literal spacePending true keeps one probe and existing guidance', async (t) => withHome(async () => {
  const agent = agentKey();
  const signed = await signedGrant(agent);
  let probes = 0;
  const fake = stubSpaceProbe(t, async () => { probes++; return missingSpace(); });
  for (const fields of [{}, { spaceReady: null }, { spaceReady: false }, { spaceReady: true }, { spacePending: false }, { spacePending: 'true' }]) {
    const profile = profileFor(agent);
    await assert.rejects(installGrant(profile, agent, { ...signed, ...fields }), {
      code: 'no-space', message: /Courier will not create it/,
    });
    assert.equal(loadProfile().status, 'awaiting-space');
    assert.equal(loadProfile().spacePending, undefined);
  }
  assert.equal(probes, 6);
  assert.deepEqual(fake.sleeps, []);
  assert.deepEqual(fake.messages, []);
}));

test('pending install saves resumable state before waiting and clears it on ready', async (t) => withHome(async () => {
  const agent = agentKey();
  const signed = await signedGrant(agent);
  const profile = profileFor(agent);
  let probes = 0;
  const fake = stubSpaceProbe(t, async () => {
    if (++probes === 1) return missingSpace();
    assert.equal(loadProfile().status, 'awaiting-space');
    assert.equal(loadProfile().spacePending, true);
    assert.equal(fs.existsSync(path.join(process.env.COURIER_HOME, 'grant.json')), true);
    return probes === 4 ? readySpace() : missingSpace();
  });
  await installGrant(profile, agent, { ...signed, spaceReady: null, spacePending: true });
  assert.equal(probes, 4);
  assert.deepEqual(fake.sleeps, [2000, 3000]);
  assert.deepEqual(fake.messages, ['OpenKey is setting up your TinyCloud "agents" space; waiting up to 2.5 minutes…']);
  assert.equal(loadProfile().status, 'ready');
  assert.equal('spacePending' in loadProfile(), false);
}));

test('pending install times out after 150 seconds and resume waits only 60 seconds', async (t) => withHome(async () => {
  const agent = agentKey();
  const signed = await signedGrant(agent);
  const fake = stubSpaceProbe(t, async () => missingSpace());
  await assert.rejects(installGrant(profileFor(agent), agent, { ...signed, spaceReady: null, spacePending: true }), {
    code: 'no-space', message: /OpenKey is still setting up.*no new approval is needed/,
  });
  assert.equal(fake.elapsed(), 150_000);
  assert.equal(loadProfile().spacePending, true);
  await assert.rejects(resumeGrant(loadProfile(), agent), { code: 'no-space', message: /OpenKey is still setting up/ });
  assert.equal(fake.elapsed(), 210_000);
  assert.equal(loadProfile().status, 'awaiting-space');
  assert.equal(loadProfile().spacePending, true);
}));

test('resume without spacePending probes once and retains existing no-space behavior', async (t) => withHome(async () => {
  const agent = agentKey();
  const signed = await signedGrant(agent);
  let ready = true;
  let probes = 0;
  const fake = stubSpaceProbe(t, async () => { probes++; return ready ? readySpace() : missingSpace(); });
  const profile = profileFor(agent);
  await installGrant(profile, agent, signed);
  profile.status = 'awaiting-space';
  saveProfile(profile);
  ready = false;
  probes = 0;
  await assert.rejects(resumeGrant(profile, agent), { code: 'no-space', message: /Courier will not create it/ });
  assert.equal(probes, 1);
  assert.deepEqual(fake.sleeps, []);
  assert.equal(loadProfile().status, 'awaiting-space');
  assert.equal(loadProfile().spacePending, undefined);
}));

test('pending resume clears the marker when the space becomes ready', async (t) => withHome(async () => {
  const agent = agentKey();
  const signed = await signedGrant(agent);
  let probes = 0;
  const fake = stubSpaceProbe(t, async () => ++probes === 2 ? missingSpace() : readySpace());
  const profile = profileFor(agent);
  await installGrant(profile, agent, signed);
  profile.status = 'awaiting-space';
  profile.spacePending = true;
  saveProfile(profile);
  await resumeGrant(profile, agent);
  assert.equal(loadProfile().status, 'ready');
  assert.equal('spacePending' in loadProfile(), false);
  assert.equal(probes, 3);
  assert.deepEqual(fake.sleeps, [2000]);
}));

test('pending wait propagates non-space errors and leaves a resumable profile', async (t) => withHome(async () => {
  const agent = agentKey();
  const signed = await signedGrant(agent);
  const error = new Error('Unauthorized');
  let probes = 0;
  stubSpaceProbe(t, async () => {
    if (++probes === 1) return missingSpace();
    throw error;
  });
  await assert.rejects(installGrant(profileFor(agent), agent, { ...signed, spacePending: true, spaceReady: null }), (actual) => actual === error);
  assert.equal(loadProfile().status, 'awaiting-space');
  assert.equal(loadProfile().spacePending, true);
}));

test('awaiting-space commands distinguish pending OpenKey setup from manual hosting', async () => withHome(async () => {
  saveKey(key);
  const profile = profileFor(key, 'awaiting-space');
  await assert.rejects(courierNode(profile), { code: 'no-space', message: /after hosting it/ });
  await assert.rejects(courierNode({ ...profile, spacePending: true }), {
    code: 'no-space', message: /still being set up by OpenKey.*init --resume/,
  });
}));
