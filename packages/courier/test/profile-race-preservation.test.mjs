import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveProfile, loadProfile } from '../dist/profile.js';

function seed() {
  saveProfile({ version: 4, host: 'http://127.0.0.1:1', openkeyHost: 'http://127.0.0.1:1', courierDid: 'did:key:self', label: 'fixture', status: 'ready', peers: {
    bob: { handle: 'bob', courierDid: 'did:key:bob', ownerDid: 'did:pkh:fixture', spaceId: 's', status: 'paired', pairedAt: '2026-01-01', interim: { cleanup: {} }, outbound: [{ cid: 'old', issuedAt: '2026-01-01', expiresAt: '2099-01-01' }] },
  } });
}

test('an unlocked renewal save cannot lose a concurrent outbound revocation receipt', () => {
  seed();
  const renewal = loadProfile();
  const revoke = loadProfile();
  revoke.peers.bob.outbound[0].revokedAt = '2026-11-19T12:00:00Z';
  saveProfile(revoke);
  renewal.peers.bob.outbound.push({ cid: 'new', issuedAt: '2026-11-19', expiresAt: '2099-02-01' });
  saveProfile(renewal);
  const entries = loadProfile().peers.bob.outbound;
  assert.equal(entries.find(entry => entry.cid === 'old').revokedAt, '2026-11-19T12:00:00Z');
  assert.ok(entries.some(entry => entry.cid === 'new'));
});

test('conflicting peer authority state is refused rather than overwriting another command', () => {
  seed();
  const renewal = loadProfile();
  const refused = loadProfile();
  refused.peers.bob.interim.latchedAt = '2026-11-19T12:00:00Z';
  saveProfile(refused);
  renewal.peers.bob.interim.lastAttemptAt = '2026-11-19T12:01:00Z';
  assert.throws(() => saveProfile(renewal), error => error.code === 'profile-changed' && /again/.test(error.message));
  assert.equal(loadProfile().peers.bob.interim.latchedAt, '2026-11-19T12:00:00Z');
});

test('an old peer operation cannot overwrite a newly paired identity under the same handle', () => {
  seed();
  const old = loadProfile();
  const current = loadProfile();
  current.peers.bob = { ...current.peers.bob, courierDid: 'did:key:replacement', outbound: [] };
  saveProfile(current);
  old.peers.bob.outbound[0].revokedAt = '2026-11-19T12:00:00Z';
  assert.throws(() => saveProfile(old), error => error.code === 'profile-changed');
  assert.equal(loadProfile().peers.bob.courierDid, 'did:key:replacement');
  assert.deepEqual(loadProfile().peers.bob.outbound, []);
});
