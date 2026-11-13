import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { grantExpiry, peerExpiryStatus, EXPIRY_WARNING_MS } from '../dist/status.js';

const now = Date.parse('2026-11-11T12:00:00Z');
const at = delta => new Date(now + delta).toISOString();
const peer = (inbound = at(3600000), outbound = at(172800000)) => ({
  handle: 'alice', status: 'paired', pairedAt: at(-86400000),
  inbound: { expiresAt: inbound, delegation: 'PRIVATE_INBOUND', cid: 'PRIVATE_CID' },
  outbound: [{ expiresAt: outbound, issuedAt: at(-3600000), cid: 'PRIVATE_OUTBOUND' }],
});

test('expiry warning boundaries and absent or corrupt dates stay distinct', () => {
  assert.equal(grantExpiry(at(0), now).state, 'expired');
  assert.equal(grantExpiry(at(-1), now).state, 'expired');
  assert.equal(grantExpiry(at(1), now).state, 'expiring');
  assert.equal(grantExpiry(at(EXPIRY_WARNING_MS), now).state, 'expiring');
  assert.equal(grantExpiry(at(EXPIRY_WARNING_MS + 1), now).state, 'current');
  assert.deepEqual(grantExpiry(undefined, now), { state: 'missing', expiresAt: null });
  assert.deepEqual(grantExpiry('not-a-date', now), { state: 'unknown', expiresAt: null });
});

test('sides expire independently; saved expiry never proves readability or automatic renewal', () => {
  const result = peerExpiryStatus(peer(), now);
  assert.equal(result.inbound.state, 'expiring');
  assert.equal(result.outbound.state, 'current');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.remoteReadability, 'not-checked');
  assert.equal(result.renewal.state, 'unknown');
  assert.equal(result.renewal.command, 'courier pair renew alice');
});

test('either lapsed side requires new approval and never suggests renewing the lapse', () => {
  for (const p of [peer(at(0)), peer(at(1000), at(-1000))]) {
    const result = peerExpiryStatus(p, now);
    assert.equal(result.renewal.command, null);
    assert.match(result.warnings.join(' '), result.inbound.state === 'expired' ? /new pairing is required/ : /approve a new grant/);
    assert.doesNotMatch(result.warnings.join(' '), /pair renew/);
  }
});

test('missing, unknown and incomplete pairing cannot be presented as renewal-ready', () => {
  for (const p of [
    { ...peer(), inbound: undefined }, { ...peer(), outbound: [] }, peer('invalid'), { ...peer(), status: 'awaiting-C' },
  ]) assert.equal(peerExpiryStatus(p, now).renewal.command, null);
});

test('CLI status works offline after expiry, excludes authority material and leaves files unchanged', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-status-'));
  try {
    const p = peer('2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z');
    const profile = { version: 3, status: 'ready', courierDid: 'did:key:synthetic',
      host: 'https://must-not-contact.invalid', openkeyHost: 'https://must-not-contact.invalid', peers: { alice: p } };
    const file = path.join(home, 'profile.json');
    fs.writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
    const snapshot = fs.readFileSync(file, 'utf8');
    const entry = new URL('../dist/main.js', import.meta.url).href;
    const script = `globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
      const { main } = await import(${JSON.stringify(entry)});
      process.exitCode = await main(JSON.parse(process.argv[1]));`;
    const run = argv => spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(argv)], {
      env: { ...process.env, COURIER_HOME: home }, encoding: 'utf8', timeout: 20000,
    });
    const json = run(['status', '--peer', 'alice', '--json']);
    assert.equal(json.status, 0, json.stderr);
    const result = JSON.parse(json.stdout);
    assert.equal(result.source, 'saved-profile');
    assert.equal(result.peers[0].inbound.state, 'expired');
    assert.equal(result.peers[0].outbound.state, 'expired');
    assert.equal(result.peers[0].renewal.command, null);
    assert.doesNotMatch(json.stdout, /PRIVATE_|delegation|courierDid|must-not-contact/);
    const text = run(['status']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Inbound: your access to the peer/);
    assert.match(text.stdout, /Warning:.*expired/);
    assert.match(text.stdout, /2000-01-01 00:00 UTC/);
    assert.doesNotMatch(text.stdout, /T00:00:00/);
    assert.doesNotMatch(text.stdout, /pair renew/);
    assert.equal(run(['status', '--peer', 'unknown', '--json']).status, 1);
    assert.equal(run(['status', '--peer=']).status, 2);
    assert.equal(run(['status', '--peer', 'alice', '--peer', 'alice']).status, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), snapshot);
    assert.deepEqual(fs.readdirSync(home), ['profile.json']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
