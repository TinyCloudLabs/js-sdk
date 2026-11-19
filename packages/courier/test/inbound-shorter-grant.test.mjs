import { issuedFixture } from './support/issued-fixture.mjs';
// TC-2746: real signed pairings against an owned loopback activation host.
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
import { AGENT_GRANT, COURIER_SPACE } from '../dist/keys.js';
import { courierRegistryFixtureEnv } from './support/registry-fixture.mjs';

import { peerKv, courierNode } from '../dist/node.js';
import { loadProfile } from '../dist/profile.js';
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const wasm = new NodeWasmBindings();
// Never execFileSync: the child answers through the in-process stub below, which needs this process's event loop free.
const execFileAsync = promisify(execFile);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Synthetic owner wallets. No credentials are read.
const owners = {
  sam: randomBytes(32).toString('hex'),
  mira: randomBytes(32).toString('hex'),
};

const hits = { delegate: 0, invoke: 0 };
const fixtureApi = issuedFixture(typeof hits === 'undefined' ? {} : hits);
const stub = http.createServer((req, res) => { void fixtureApi.handle(req, res); });
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const HOST = `http://127.0.0.1:${stub.address().port}`;
test.after(() => stub.close());

const root = process.env.COURIER_TEST_HOME;
assert.ok(root, 'COURIER_TEST_HOME (setup-home.mjs) must pin this test home');
fs.mkdirSync(path.join(root, 'shorter-grant'), { recursive: true });

async function run(home, args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env: courierRegistryFixtureEnv(home, HOST), encoding: 'utf8' });
  return JSON.parse(stdout);
}

const courierDid = (key) => key.did.split('#', 1)[0];

function agentKey() {
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('courier');
  const jwk = JSON.parse(manager.jwk(id));
  return { v: 1, jwk, did: manager.getDID(id), createdAt: new Date().toISOString() };
}

/** Signed Courier grant for `key` issued by `ownerPrivateKey` and valid for `lifetimeMs`, same shape OpenKey returns. */
async function makeGrant(ownerPrivateKey, key, lifetimeMs) {
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
  const expiresAt = new Date(now.getTime() + lifetimeMs);
  const prepared = wasm.prepareSession({
    abilities,
    address,
    chainId,
    domain: 'courier.test',
    issuedAt: now.toISOString(),
    expirationTime: expiresAt.toISOString(),
    spaceId,
    jwk: key.jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    grant: {
      v: 1,
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      spaceId,
      ownerDid: `did:pkh:eip155:${chainId}:${address}`,
      address,
      chainId,
      verificationMethod: key.did,
      siwe: prepared.siwe,
      signature,
      expiresAt: expiresAt.toISOString(),
      receivedAt: now.toISOString(),
    },
    ownerDid: `did:pkh:eip155:${chainId}:${address}`,
    spaceId,
  };
}

/** A Courier home ready for pairing without `courier init` (no OpenKey round trip). */
async function makeHome(name, handle, ownerPrivateKey, grantLifetimeMs = 30 * DAY) {
  const home = path.join(root, 'shorter-grant', name);
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const key = agentKey();
  const { grant, ownerDid, spaceId } = await makeGrant(ownerPrivateKey, key, grantLifetimeMs);
  const profile = {
    version: 3,
    host: HOST,
    openkeyHost: 'https://openkey.so',
    label: `courier · ${name}`,
    selfHandle: handle,
    courierDid: courierDid(key),
    ownerDid,
    spaceId,
    grantExpiresAt: grant.expiresAt,
    status: 'ready',
    peers: {},
  };
  for (const [file, body] of [['profile.json', profile], ['key.json', key], ['grant.json', grant]]) {
    fs.writeFileSync(path.join(home, file), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  }
  return { home, profile, grant, ownerPrivateKey };
}

async function approveLater(fixture, lifetime = 30 * DAY) {
  const key = JSON.parse(fs.readFileSync(path.join(fixture.home, 'key.json'), 'utf8'));
  const result = await makeGrant(fixture.ownerPrivateKey, key, lifetime);
  fs.writeFileSync(path.join(fixture.home, 'grant.json'), JSON.stringify(result.grant), { mode: 0o600 });
  const profile = profileAt(fixture.home); profile.grantExpiresAt = result.grant.expiresAt; writeProfile(fixture.home, profile);
  fixture.grant = result.grant;
}

const profilePath = (home) => path.join(home, 'profile.json');
const profileAt = (home) => JSON.parse(fs.readFileSync(profilePath(home), 'utf8'));
const profileBytes = (home) => fs.readFileSync(profilePath(home), 'utf8');
const writeProfile = (home, profile) => fs.writeFileSync(profilePath(home), `${JSON.stringify(profile, null, 2)}\n`);

/** Complete A→B→C; `a` addresses `b` as `aPeerHandle`, `b` addresses `a` as `callMe`. */
async function pairAll(a, aPeerHandle, b, callMe) {
  const artA = await run(a.home, ['pair', 'start', aPeerHandle, '--call-me', callMe]);
  const artB = await run(b.home, ['pair', 'accept', JSON.stringify(artA)]);
  const artC = await run(a.home, ['pair', 'accept', JSON.stringify(artB)]);
  await run(b.home, ['pair', 'accept', JSON.stringify(artC)]);
}


await import('./support/registry-fixture.mjs').then(m => m.installCourierRegistryFixture(HOST));

await import('./support/registry-fixture.mjs').then(m => m.installCourierRegistryFixture(HOST));

async function runFail(home, args) {
  try {
    await execFileAsync(process.execPath, [CLI, ...args], { env: courierRegistryFixtureEnv(home, HOST), encoding: 'utf8' });
  } catch (error) {
    return String(error.stderr);
  }
  throw new Error(`expected \`courier ${args.join(' ')}\` to fail`);
}

test('a 0.6 receiver refuses a shorter grant as stale, keeps its stored inbound and still reads on the longer one (TC-3159)', async () => {
  const issuer = await makeHome('issuer', 'issuer', owners.sam);
  const recipient = await makeHome('recipient', 'recipient', owners.mira);
  const artA = await run(issuer.home, ['pair', 'start', 'to-recipient', '--call-me', 'to-issuer']);
  const artB = await run(recipient.home, ['pair', 'accept', JSON.stringify(artA)]);
  const artC = await run(issuer.home, ['pair', 'accept', JSON.stringify(artB)]);
  await run(recipient.home, ['pair', 'accept', JSON.stringify(artC)]);
  const shorter = JSON.parse(artC.delegation);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await approveLater(issuer);
  const longer = await run(issuer.home, ['pair', 'renew', 'to-recipient', '--renew-artifact', '--force']);
  assert.ok(Date.parse(JSON.parse(longer.delegation).expiry) > Date.parse(shorter.expiry));
  await run(recipient.home, ['pair', 'accept', JSON.stringify(longer)]);

  // pair accept: a shorter artifact C is [stale-artifact] and changes nothing.
  const adopted = profileBytes(recipient.home);
  assert.match(await runFail(recipient.home, ['pair', 'accept', JSON.stringify(artC)]), /\[stale-artifact\]/);
  assert.equal(profileBytes(recipient.home), adopted);

  // Reading: a shorter published delegation.json is ignored; the reader keeps the longer grant and the profile is untouched.
  process.env.COURIER_HOME = recipient.home;
  const profile = loadProfile();
  const peer = structuredClone(profile.peers['to-issuer']);
  assert.equal(peer.inbound.cid, longer.delegation && JSON.parse(longer.delegation).cid);
  const node = await courierNode(profile);
  let published = 0;
  node.kvForSpace = () => ({ get: async () => { published++; return { ok: true, data: { data: { delegation: JSON.stringify(shorter) } } }; } });
  const read = await peerKv(node, profile, peer);
  assert.equal(published, 1, 'the published delegation was read');
  await read.get('probe');
  assert.equal(published, 2, 'the returned reader is the one already held, not a replacement installed from the shorter grant');
  assert.equal(peer.inbound.cid, JSON.parse(longer.delegation).cid);
  assert.equal(profileBytes(recipient.home), adopted);
});
