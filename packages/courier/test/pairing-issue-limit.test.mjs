import { issuedFixture } from './support/issued-fixture.mjs';
// TC-3173: a first-time manual pairing signs 7-day peer delegations (a Courier 0.5.x peer refuses longer) while Courier still
// accepts a peer delegation of up to 30 days (an unpatched 0.6 peer signs 30). Real CLI, real signed sessions, loopback activation host.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NodeWasmBindings, PrivateKeySigner } from '@tinycloud/node-sdk';
import { AGENT_GRANT, COURIER_SPACE, peerReadPermissions } from '../dist/keys.js';
import { CLOCK_SKEW_MS } from '../dist/authority.js';
import { artifactWithDelegation } from '../dist/pairing.js';
import { courierNode } from '../dist/node.js';
import { loadProfile } from '../dist/profile.js';
import { courierRegistryFixtureEnv, installCourierRegistryFixture } from './support/registry-fixture.mjs';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const wasm = new NodeWasmBindings();
// Never execFileSync: the child answers through the in-process stub below, which needs this process's event loop free.
const execFileAsync = promisify(execFile);

const DAY = 24 * 3_600_000;
const owners = { sam: randomBytes(32).toString('hex'), mira: randomBytes(32).toString('hex') };

const fixtureApi = issuedFixture();
const stub = http.createServer((req, res) => { void fixtureApi.handle(req, res); });
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const HOST = `http://127.0.0.1:${stub.address().port}`;
test.after(() => stub.close());
await installCourierRegistryFixture(HOST);

const root = process.env.COURIER_TEST_HOME;
assert.ok(root, 'COURIER_TEST_HOME (setup-home.mjs) must pin this test home');
fs.mkdirSync(path.join(root, 'issue-limit'), { recursive: true });

async function run(home, args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env: courierRegistryFixtureEnv(home, HOST), encoding: 'utf8' });
  return JSON.parse(stdout);
}

async function runFail(home, args) {
  try {
    await execFileAsync(process.execPath, [CLI, ...args], { env: courierRegistryFixtureEnv(home, HOST), encoding: 'utf8' });
  } catch (error) {
    return String(error.stderr);
  }
  throw new Error(`expected \`courier ${args.join(' ')}\` to fail`);
}

const courierDid = (key) => key.did.split('#', 1)[0];
const profileAt = (home) => JSON.parse(fs.readFileSync(path.join(home, 'profile.json'), 'utf8'));

function agentKey() {
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('courier');
  return { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: new Date().toISOString() };
}

/** Signed Courier grant for `key` issued by `ownerPrivateKey`, same shape OpenKey returns. */
async function makeGrant(ownerPrivateKey, key) {
  const signer = new PrivateKeySigner(ownerPrivateKey);
  const address = await signer.getAddress();
  const chainId = 1;
  const spaceId = wasm.makeSpaceId(address, chainId, COURIER_SPACE);
  const abilities = {};
  for (const permission of AGENT_GRANT) {
    const service = permission.service.replace(/^tinycloud\./, '');
    (abilities[service] ??= {})[permission.path] = permission.actions;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * DAY);
  const prepared = wasm.prepareSession({
    abilities, address, chainId, domain: 'courier.test', issuedAt: now.toISOString(), expirationTime: expiresAt.toISOString(), spaceId, jwk: key.jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const ownerDid = `did:pkh:eip155:${chainId}:${address}`;
  return {
    grant: {
      v: 1, delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, ownerDid, address, chainId,
      verificationMethod: key.did, siwe: prepared.siwe, signature, expiresAt: expiresAt.toISOString(), receivedAt: now.toISOString(),
    },
    ownerDid,
    spaceId,
  };
}

/** A Courier home ready for pairing without `courier init` (no OpenKey round trip). */
async function makeHome(name, handle, ownerPrivateKey) {
  const home = path.join(root, 'issue-limit', name);
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const key = agentKey();
  const { grant, ownerDid, spaceId } = await makeGrant(ownerPrivateKey, key);
  const profile = {
    version: 3, host: HOST, openkeyHost: 'https://openkey.so', label: `courier · ${name}`, selfHandle: handle,
    courierDid: courierDid(key), ownerDid, spaceId, grantExpiresAt: grant.expiresAt, status: 'ready', peers: {},
  };
  for (const [file, body] of [['profile.json', profile], ['key.json', key], ['grant.json', grant]]) {
    fs.writeFileSync(path.join(home, file), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  }
  return { home, profile };
}

/** The `exp` the compact UCAN inside an artifact's delegation was signed with, in ms. */
function signedExpiryMs(artifact) {
  const jwt = JSON.parse(artifact.delegation).delegationHeader.Authorization;
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).exp * 1000;
}

test('a first-time manual pairing signs 7-day peer delegations in both directions (B and C)', async () => {
  const a = await makeHome('manual-a', 'manual-a', owners.sam);
  const b = await makeHome('manual-b', 'manual-b', owners.mira);
  const artA = await run(a.home, ['pair', 'start', 'to-b', '--call-me', 'to-a']);
  const before = Date.now();
  const artB = await run(b.home, ['pair', 'accept', JSON.stringify(artA)]);
  const artC = await run(a.home, ['pair', 'accept', JSON.stringify(artB)]);
  const after = Date.now();
  assert.equal(artB.step, 'B');
  assert.equal(artC.step, 'C');
  assert.equal((await run(b.home, ['pair', 'accept', JSON.stringify(artC)])).ok, true);

  for (const artifact of [artB, artC]) {
    const exp = signedExpiryMs(artifact);
    assert.ok(exp <= after + 7 * DAY + CLOCK_SKEW_MS, `signed ${(exp - after) / DAY} days, more than 7 days plus skew`);
    assert.ok(exp >= before + 7 * DAY - CLOCK_SKEW_MS, `signed ${(exp - before) / DAY} days, far less than 7`);
  }
});

test('an inbound B of 30 days (an unpatched 0.6 peer) is still accepted, installed, and answered with a 7-day C', async () => {
  const a = await makeHome('long-a', 'long-a', owners.sam);
  const b = await makeHome('long-b', 'long-b', owners.mira);
  const artA = await run(a.home, ['pair', 'start', 'to-b', '--call-me', 'to-a']);

  // The peer side, signing the 30 days an unpatched 0.6 build signs.
  process.env.COURIER_HOME = b.home;
  const bProfile = loadProfile();
  const node = await courierNode(bProfile);
  const outbound = await node.delegateTo(artA.from.courier, peerReadPermissions(artA.callMe, bProfile.spaceId), { expiry: '30d' });
  const artB = artifactWithDelegation('B', bProfile, outbound.delegation, artA.callMe, artA.peer);
  const inboundExp = signedExpiryMs(artB);
  assert.ok(inboundExp > Date.now() + 29 * DAY, 'fixture: the peer signed about 30 days');

  const before = Date.now();
  const artC = await run(a.home, ['pair', 'accept', JSON.stringify(artB)]);
  const after = Date.now();
  const peer = profileAt(a.home).peers['to-b'];
  assert.equal(peer.status, 'paired');
  assert.equal(Date.parse(peer.inbound.expiresAt), inboundExp, 'the 30-day inbound is the one installed');
  assert.ok(signedExpiryMs(artC) <= after + 7 * DAY + CLOCK_SKEW_MS, 'our answer is still 7 days');
  assert.ok(signedExpiryMs(artC) >= before + 7 * DAY - CLOCK_SKEW_MS);
});

test('trade-off: a fresh 7-day manual pairing cannot be renewed past 7 days; the export is throttled with a clear message and changes nothing', async () => {
  const a = await makeHome('renew-a', 'renew-a', owners.sam);
  const b = await makeHome('renew-b', 'renew-b', owners.mira);
  const artA = await run(a.home, ['pair', 'start', 'to-b', '--call-me', 'to-a']);
  const artB = await run(b.home, ['pair', 'accept', JSON.stringify(artA)]);
  const artC = await run(a.home, ['pair', 'accept', JSON.stringify(artB)]);
  await run(b.home, ['pair', 'accept', JSON.stringify(artC)]);

  // Pairing just stamped a renewal, so a plain export is held back by the 24 h throttle. Forcing past that reaches the real
  // limit: the peer's own grant to us is 7 days, the longest our grant to it can run, so nothing longer exists to hand over.
  const bytes = fs.readFileSync(path.join(a.home, 'profile.json'), 'utf8');
  assert.match(await runFail(a.home, ['pair', 'renew', 'to-b', '--renew-artifact']), /\[renew-throttled\] Access for to-b was renewed in the last 24 hours\. Use --force/);
  const forced = await runFail(a.home, ['pair', 'renew', 'to-b', '--renew-artifact', '--force']);
  assert.match(forced, /\[renew-throttled\] Access for to-b already runs as long as the peer accepts \(peer limit 7d\), so there is no longer renewal to hand over\. Nothing was exported\./);
  assert.equal(fs.readFileSync(path.join(a.home, 'profile.json'), 'utf8'), bytes, 'a refused export stamps and changes nothing');
  assert.equal(profileAt(a.home).peers['to-b'].outbound.length, 1);
});
