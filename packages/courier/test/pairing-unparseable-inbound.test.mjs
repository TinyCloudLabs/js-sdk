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
fs.mkdirSync(path.join(root, 'unparseable-inbound'), { recursive: true });

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
  const home = path.join(root, 'unparseable-inbound', name);
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
    return { stdout: String(error.stdout), stderr: String(error.stderr) };
  }
  throw new Error(`expected \`courier ${args.join(' ')}\` to fail`);
}

test('unparseable inbound: the export is refused with a clear message rather than handing a 0.6 peer a shorter C it would refuse (TC-3159)', async () => {
  const issuer = await makeHome('issuer', 'issuer', owners.sam);
  const recipient = await makeHome('recipient', 'recipient', owners.mira);
  await pairAll(issuer, 'to-recipient', recipient, 'to-issuer');
  const corrupt = profileAt(issuer.home);
  corrupt.peers['to-recipient'].inbound.delegation = 'not-a-valid-delegation';
  writeProfile(issuer.home, corrupt);
  await approveLater(issuer);
  const before = profileBytes(issuer.home);
  const calls = { ...hits };
  const refused = await runFail(issuer.home, ['pair', 'renew', 'to-recipient', '--renew-artifact', '--force']);
  assert.equal(refused.stdout, '', 'no artifact is exported');
  assert.match(refused.stderr, /\[renew-throttled\].*already runs longer than the peer accepts \(peer limit 7d\).*published automatically on the next renewal tick.*Nothing was exported/);
  assert.doesNotMatch(refused.stderr, /as long as the peer accepts/);
  assert.equal(profileBytes(issuer.home), before, 'nothing was signed or recorded');
  assert.deepEqual(hits, calls);
});
