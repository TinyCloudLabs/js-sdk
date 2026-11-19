import { privateScratch } from './private-scratch.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brokerRoot, brokerFile, loadBrokerConfig, saveBrokerConfig, assertPinnedProfile, pinProfile, currentProfileId, TEST_TOKEN } from '../dist/broker-config.js';
import { loadBrokerCredential, sanitizeOutput } from '../dist/broker.js';
import { agentHome, profileId } from '../dist/guard/install.js';
import { prepareAgentProfile } from '../dist/guard/cleanhome.js';

test('N1: test broker override rejects the real owner root, symlinks to it and paths outside scratch', () => {
  assert.throws(() => brokerRoot(os.userInfo().homedir), /scratch/);
  assert.throws(() => brokerRoot('/tmp'), /scratch/);
  assert.throws(() => brokerRoot('.'), /scratch/);
  const dir = privateScratch('tc712-root-');
  try {
    fs.symlinkSync(os.userInfo().homedir, path.join(dir, 'owner-link'));
    assert.throws(() => brokerRoot(path.join(dir, 'owner-link')), /scratch/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('N1: owner-private pinned config stays outside Courier; agent snapshot has no broker pointer', () => {
  const dir = privateScratch('tc712-config-');
  try {
    const owner = path.join(dir, 'owner'); fs.mkdirSync(owner, { mode: 0o700 });
    const home = path.join(dir, 'courier'); fs.mkdirSync(home, { mode: 0o700 });
    const profile = { version: 3, host: 'https://expected.invalid', openkeyHost: 'https://openkey.invalid', courierDid: 'did:key:dummy', ownerDid: 'did:pkh:dummy', spaceId: 'space:agents', status: 'ready', peers: {} };
    fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify(profile), { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'key.json'), '{"dummy":true}', { mode: 0o600 });
    const ghBin = path.join(dir, 'stub-gh'); fs.writeFileSync(ghBin, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const st = fs.statSync(ghBin);
    const config = { v: 2, courierHome: home, profile: pinProfile(profile), ghBin, ghIdentity: { dev: st.dev, ino: st.ino }, testToken: TEST_TOKEN };
    const file = saveBrokerConfig(config, owner);
    assert.ok(file.startsWith(owner + '/')); assert.ok(!file.startsWith(home + '/'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(loadBrokerConfig(profileId(home), owner), config);
    assert.throws(() => loadBrokerConfig(profileId(home), os.userInfo().homedir));
    prepareAgentProfile(home);
    const marker = JSON.parse(fs.readFileSync(path.join(agentHome(home), '.courier-agent.json'), 'utf8'));
    assert.deepEqual(marker, { v: 1, profileId: profileId(home) });
    assert.equal(currentProfileId(path.join(agentHome(home), '.courier')), marker.profileId);
    assert.ok(!fs.readFileSync(path.join(agentHome(home), '.courier/profile.json'), 'utf8').includes(owner));
    for (const [key, value] of [['host', 'https://agent.invalid'], ['spaceId', 'evil:agents'], ['ownerDid', 'did:pkh:evil'], ['courierDid', 'did:key:evil']]) {
      assert.throws(() => assertPinnedProfile(config, { ...profile, [key]: value }), { code: 'broker-profile-mismatch' });
    }
    fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ ...profile, host: 'https://agent.invalid' }), { mode: 0o600 });
    assert.throws(() => loadBrokerConfig(profileId(home), owner), { code: 'broker-profile-mismatch' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('N1: production credential lookup uses gh own auth with a fixed hostname and scrubbed environment', async () => {
  const previous = process.env.GH_TOKEN; process.env.GH_TOKEN = 'untrusted-agent-value';
  try {
    const credential = await loadBrokerCredential({ ghBin: '/stub/gh' }, async (bin, args, options) => {
      assert.equal(bin, '/stub/gh'); assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.com']);
      assert.equal(options.env.HOME, os.userInfo().homedir);
      assert.equal(options.env.GH_TOKEN, undefined); assert.equal(options.env.COURIER_HOME, undefined);
      assert.equal(options.env.GH_CONFIG_DIR, path.join(os.userInfo().homedir, '.config/gh'));
      return { code: 0, stdout: TEST_TOKEN, stderr: '' };
    });
    assert.equal(credential.token, TEST_TOKEN);
    const split = TEST_TOKEN.slice(0, 15) + '\x01' + TEST_TOKEN.slice(15);
    assert.equal(sanitizeOutput(split, [TEST_TOKEN]), '[redacted]');
  } finally { if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous; }
});
