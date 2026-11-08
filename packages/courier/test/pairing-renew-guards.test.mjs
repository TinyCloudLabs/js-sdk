// TC-2338: guards of `courier pair renew <peer> --renew-artifact` and of the receiver that installs the
// resulting C artifact. Each assertion here fails when the guard it names is removed:
//   - a renewal cannot outlive the exporter's own Courier grant, and an expired grant exports nothing;
//   - the 20 h throttle refuses a second export without --force, and a refusal stamps and prints nothing;
//   - the receiver refuses an unknown peer, a handle that does not match the peer, a pairing that is not
//     complete, and a delegation signed by someone other than the advertised courier.
// Real CLI + real signed sessions, isolated COURIER_HOME dirs, and a loopback stub standing in for the host's
// POST /delegate and KV invoke; every signed check still runs in-process. No production service is contacted.
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
const stub = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/delegate') {
    hits.delegate += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ activated: ['agents'], skipped: [] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/invoke') {
    hits.invoke += 1;
    res.writeHead(200, { 'content-type': 'application/json', etag: '"stub-etag"' });
    res.end('{}');
    return;
  }
  res.writeHead(404).end('no such route');
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const HOST = `http://127.0.0.1:${stub.address().port}`;
test.after(() => stub.close());

const root = process.env.COURIER_TEST_HOME;
assert.ok(root, 'COURIER_TEST_HOME (setup-home.mjs) must pin this test home');
fs.mkdirSync(path.join(root, 'renew-guards'), { recursive: true });

async function run(home, args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env: courierRegistryFixtureEnv(home, HOST), encoding: 'utf8' });
  return JSON.parse(stdout);
}

async function runFail(home, args) {
  try {
    await execFileAsync(process.execPath, [CLI, ...args], { env: courierRegistryFixtureEnv(home, HOST), encoding: 'utf8' });
  } catch (e) {
    return { code: e.code, stdout: String(e.stdout), stderr: String(e.stderr) };
  }
  throw new Error(`expected \`courier ${args.join(' ')}\` to fail`);
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
  const home = path.join(root, 'renew-guards', name);
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
  return { home, profile, grant };
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

/** Make the last outbound issuance older than the 20 h throttle so the next export needs no --force. */
function backdateOutbound(home, peerHandle) {
  const profile = profileAt(home);
  profile.peers[peerHandle].outbound.at(-1).issuedAt = new Date(Date.now() - 21 * HOUR).toISOString();
  writeProfile(home, profile);
}

const signedExpiry = (artifact) => new Date(JSON.parse(artifact.delegation).expiry).getTime();

test('a renewal cannot outlive the exporter grant: a 2 h grant exports an artifact expiring within the grant, not in 7 days', async () => {
  const issuer = await makeHome('cap-issuer', 'cap-issuer', owners.sam, 2 * HOUR);
  const recipient = await makeHome('cap-recipient', 'cap-recipient', owners.mira);
  await pairAll(issuer, 'issuer-cap', recipient, 'recipient-cap');
  backdateOutbound(issuer.home, 'issuer-cap');

  const grantExpiry = Date.parse(issuer.grant.expiresAt);
  const before = Date.now();
  const art = await run(issuer.home, ['pair', 'renew', 'issuer-cap', '--renew-artifact']);

  assert.equal(art.step, 'C');
  const advertised = Date.parse(art.delegationExpiresAt);
  assert.ok(advertised <= grantExpiry, `renewal expires ${art.delegationExpiresAt}, after the grant ${issuer.grant.expiresAt}`);
  assert.ok(advertised < before + 3 * HOUR, 'the 7 day lifetime must not be issued from a 2 h grant');
  assert.ok(advertised > before + HOUR, 'a usable renewal, not an already-lapsed one');
  assert.equal(signedExpiry(art), advertised, 'the signed delegation carries the same expiry as the artifact advertises');
  assert.ok(signedExpiry(art) <= grantExpiry, 'the signed expiry is within the grant');
});

test('an exporter whose grant expired gets [grant-expired], exit 1, empty stdout, and nothing stamped', async () => {
  const issuer = await makeHome('expired-issuer', 'expired-issuer', owners.sam);
  const recipient = await makeHome('expired-recipient', 'expired-recipient', owners.mira);
  await pairAll(issuer, 'issuer-exp', recipient, 'recipient-exp');
  backdateOutbound(issuer.home, 'issuer-exp');

  const grant = JSON.parse(fs.readFileSync(path.join(issuer.home, 'grant.json'), 'utf8'));
  grant.expiresAt = new Date(Date.now() - HOUR).toISOString();
  fs.writeFileSync(path.join(issuer.home, 'grant.json'), `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 });

  const bytes = profileBytes(issuer.home);
  const calls = { ...hits };
  const refused = await runFail(issuer.home, ['pair', 'renew', 'issuer-exp', '--renew-artifact', '--force']);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /\[grant-expired\]/);
  assert.equal(profileBytes(issuer.home), bytes, 'nothing stamped');
  assert.deepEqual(hits, calls, 'nothing signed or published');
});

test('a second export inside 20 h is [renew-throttled] and stamps nothing; an aged stamp or --force exports and stamps', async () => {
  const issuer = await makeHome('throttle-issuer', 'throttle-issuer', owners.sam);
  const recipient = await makeHome('throttle-recipient', 'throttle-recipient', owners.mira);
  await pairAll(issuer, 'issuer-thr', recipient, 'recipient-thr');
  // Pairing itself issued the delegation just now: that issuance is the stamp.
  const stamped = () => profileAt(issuer.home).peers['issuer-thr'].outbound;
  assert.equal(stamped().length, 1);

  const bytes = profileBytes(issuer.home);
  const calls = { ...hits };
  const throttled = await runFail(issuer.home, ['pair', 'renew', 'issuer-thr', '--renew-artifact']);
  assert.equal(throttled.code, 1);
  assert.equal(throttled.stdout, '');
  assert.match(throttled.stderr, /\[renew-throttled\]/);
  assert.equal(profileBytes(issuer.home), bytes, 'a throttled export changes nothing in the profile');
  assert.deepEqual(hits, calls, 'a throttled export signs and publishes nothing');

  backdateOutbound(issuer.home, 'issuer-thr');
  const aged = await run(issuer.home, ['pair', 'renew', 'issuer-thr', '--renew-artifact']);
  assert.equal(aged.step, 'C');
  assert.equal(stamped().length, 2, 'an export past the window stamps');
  assert.ok(Date.now() - Date.parse(stamped().at(-1).issuedAt) < 60_000);

  const again = await runFail(issuer.home, ['pair', 'renew', 'issuer-thr', '--renew-artifact']);
  assert.match(again.stderr, /\[renew-throttled\]/, 'the fresh stamp throttles the next export');
  assert.equal(again.stdout, '');
  assert.equal(stamped().length, 2);

  await new Promise((resolve) => setTimeout(resolve, 1100)); // a later signed expiry than the previous artifact
  const forced = await run(issuer.home, ['pair', 'renew', 'issuer-thr', '--renew-artifact', '--force']);
  assert.equal(forced.step, 'C');
  assert.equal(stamped().length, 3, '--force exports inside the window and stamps');
  assert.ok(Date.parse(forced.delegationExpiresAt) > Date.parse(aged.delegationExpiresAt));
});

test('exporter refuses a peer whose pairing is not complete: [not-paired], empty stdout, nothing stamped', async () => {
  const issuer = await makeHome('unpaired-issuer', 'unpaired-issuer', owners.sam);
  const recipient = await makeHome('unpaired-recipient', 'unpaired-recipient', owners.mira);

  // pending-A: `pair start` ran, nothing came back.
  await run(issuer.home, ['pair', 'start', 'issuer-pending', '--call-me', 'recipient-pending']);
  assert.equal(profileAt(issuer.home).peers['issuer-pending'].status, 'pending-A');
  // awaiting-C: the recipient accepted A and has a mailbox handle for the peer, but the pairing is not finished.
  const artA = await run(issuer.home, ['pair', 'start', 'issuer-waiting', '--call-me', 'recipient-waiting']);
  await run(recipient.home, ['pair', 'accept', JSON.stringify(artA)]);
  const waiting = profileAt(recipient.home).peers['recipient-waiting'];
  assert.equal(waiting.status, 'awaiting-C');
  assert.ok(waiting.theirHandleForMe, 'fixture: an awaiting-C peer already names its mailbox handle');

  for (const [home, peer, state] of [
    [issuer.home, 'issuer-pending', 'pending-A'],
    [recipient.home, 'recipient-waiting', 'awaiting-C'],
  ]) {
    const bytes = profileBytes(home);
    const calls = { ...hits };
    const refused = await runFail(home, ['pair', 'renew', peer, '--renew-artifact', '--force']);
    assert.equal(refused.code, 1, state);
    assert.equal(refused.stdout, '', state);
    assert.match(refused.stderr, /\[not-paired\]/, state);
    assert.equal(profileBytes(home), bytes, `${state}: nothing stamped`);
    assert.deepEqual(hits, calls, `${state}: nothing signed or published`);
  }

  // A paired record that lost its mailbox handle cannot be exported either.
  await pairAll(issuer, 'issuer-lost', recipient, 'recipient-lost');
  const lost = profileAt(issuer.home);
  delete lost.peers['issuer-lost'].theirHandleForMe;
  writeProfile(issuer.home, lost);
  const bytes = profileBytes(issuer.home);
  const noMailbox = await runFail(issuer.home, ['pair', 'renew', 'issuer-lost', '--renew-artifact', '--force']);
  assert.equal(noMailbox.stdout, '');
  assert.match(noMailbox.stderr, /\[not-paired\]/);
  assert.equal(profileBytes(issuer.home), bytes);
});

// One recipient paired with two agents of one owner (the issuer and a forger, so both delegations cover the same space),
// built once for the receiver tests below. Each test restores whatever it changes.
let receiverFixture;
function receiver() {
  receiverFixture ??= (async () => {
    const issuer = await makeHome('recv-issuer', 'recv-issuer', owners.sam);
    const forger = await makeHome('recv-forger', 'recv-forger', owners.sam);
    const recipient = await makeHome('recv-recipient', 'recv-recipient', owners.mira);
    const stranger = await makeHome('recv-stranger', 'recv-stranger', owners.mira);
    await pairAll(issuer, 'issuer-recv', recipient, 'recipient-recv');
    // The forger pairs with the same recipient under the same issuer-side handle, so its delegation covers the
    // identical mailbox tuples as the issuer's.
    await pairAll(forger, 'issuer-recv', recipient, 'recipient-forger');
    backdateOutbound(issuer.home, 'issuer-recv');
    backdateOutbound(forger.home, 'issuer-recv');
    await new Promise((resolve) => setTimeout(resolve, 1100)); // renewals expire after the installed delegations
    const renewal = await run(issuer.home, ['pair', 'renew', 'issuer-recv', '--renew-artifact']);
    const forged = await run(forger.home, ['pair', 'renew', 'issuer-recv', '--renew-artifact']);
    assert.equal(renewal.callMe, 'recipient-recv');
    assert.equal(forged.callMe, 'recipient-forger');
    assert.equal(renewal.peer, forged.peer, 'fixture: both renewals cover the same mailbox handle');
    return { recipient, stranger, renewal, forged };
  })();
  return receiverFixture;
}

async function refuse(home, art, code) {
  const bytes = profileBytes(home);
  const refused = await runFail(home, ['pair', 'accept', JSON.stringify(art)]);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, new RegExp(`\\[${code}\\]`));
  assert.equal(profileBytes(home), bytes, 'profile unchanged');
}

test('receiver: a renewal for a peer it never paired is [unknown-peer] and changes nothing', async () => {
  const { stranger, renewal } = await receiver();
  await refuse(stranger.home, renewal, 'unknown-peer');
});

test('receiver: a renewal naming another handle than the matched peer is [bad-artifact] and changes nothing', async () => {
  // The issuer courier DID matches a stored peer, but the artifact names a handle that peer does not have.
  const { recipient, renewal } = await receiver();
  await refuse(recipient.home, { ...renewal, callMe: 'recipient-elsewhere' }, 'bad-artifact');
});

test('receiver: a renewal for a peer whose pairing is not complete is [not-paired] and changes nothing', async () => {
  const { recipient, renewal } = await receiver();
  const profile = profileAt(recipient.home);
  profile.peers['recipient-recv'].status = 'pending-A';
  writeProfile(recipient.home, profile);
  await refuse(recipient.home, renewal, 'not-paired');

  // Control: the same artifact installs once the pairing is complete again, so the refusal was the status gate.
  profile.peers['recipient-recv'].status = 'paired';
  writeProfile(recipient.home, profile);
  const installed = await run(recipient.home, ['pair', 'accept', JSON.stringify(renewal)]);
  assert.equal(installed.ok, true);
});

test('receiver: another agent delegation advertised as the issuer is [bad-delegation] (signed issuer) and changes nothing', async () => {
  // Every unsigned field matches the issuer pairing and the mailbox tuples are identical; only the signed delegator differs.
  const { recipient, renewal, forged } = await receiver();
  await refuse(recipient.home, { ...forged, callMe: renewal.callMe, from: renewal.from }, 'bad-delegation');
});
