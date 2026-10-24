import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProfile, profileDir, saveProfile } from '../dist/profile.js';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const TEST_HOME = process.env.COURIER_TEST_HOME;
const REAL_HOME = os.userInfo().homedir;
const REAL_PROFILE = path.join(REAL_HOME, '.courier', 'profile.json');
const statOf = (file) => { try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return 'absent'; } };

const PROFILE = { version: 3, host: 'https://tee.node.tinycloud.xyz', openkeyHost: 'https://openkey.so', label: 'fence', courierDid: 'did:key:z6Mkfence', status: 'awaiting-grant', peers: {} };

function withEnv(overrides, fn) {
  const saved = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(overrides)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  try { return fn(); } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}

/** Read-only probe, run before any step aimed at the real home: if the fence is not armed, fail here, before a write. */
function assertFenceArmed() {
  withEnv({ HOME: REAL_HOME, COURIER_HOME: undefined }, () => {
    assert.throws(() => profileDir(), { code: 'test-home-escape' }, 'the test-home fence is not armed; refusing to touch the real home');
  });
}

test('the suite runs under the temp home preload', () => {
  assert.match(TEST_HOME, /^\/var\/tmp\/tc1920\.[A-Za-z0-9]{6}$/);
  assert.equal(process.env.COURIER_TEST, '1');
  assert.equal(process.env.HOME, TEST_HOME);
  assert.equal(profileDir(), path.join(TEST_HOME, 'courier'));
  assert.equal(os.tmpdir(), path.join(TEST_HOME, 'tmp'));
  assert.notEqual(REAL_HOME, TEST_HOME);
});

test('a test that writes under the default HOME is refused before any write', () => {
  assertFenceArmed();
  const before = statOf(REAL_PROFILE);
  withEnv({ HOME: REAL_HOME, COURIER_HOME: undefined }, () => {
    assert.throws(() => saveProfile(PROFILE), { code: 'test-home-escape' });
    assert.throws(() => loadProfile(), { code: 'test-home-escape' });
  });
  assert.equal(statOf(REAL_PROFILE), before);
  assert.equal(fs.existsSync(path.join(TEST_HOME, '.courier', 'profile.json')), false, 'nothing was written under the test HOME either');
});

test('an explicit COURIER_HOME outside the test home is refused, including siblings and parents', () => {
  assertFenceArmed();
  for (const outside of [path.join(REAL_HOME, '.courier'), '/var/lib/courier', '/var/tmp/tc1920.other/courier', `${TEST_HOME}-sibling`, path.dirname(TEST_HOME)]) {
    withEnv({ COURIER_HOME: outside }, () => {
      assert.throws(() => profileDir(), { code: 'test-home-escape' }, outside);
      assert.throws(() => saveProfile(PROFILE), { code: 'test-home-escape' }, outside);
    });
  }
  withEnv({ COURIER_HOME: path.join(TEST_HOME, 'nested', 'deep') }, () => assert.equal(profileDir(), path.join(TEST_HOME, 'nested', 'deep')));
  withEnv({ COURIER_HOME: TEST_HOME }, () => assert.equal(profileDir(), TEST_HOME));
});

test('the courier CLI inherits the fence: aimed at the real home it exits test-home-escape and writes nothing', () => {
  assertFenceArmed();
  const before = statOf(REAL_PROFILE);
  const run = spawnSync(process.execPath, [CLI, 'init', '--request', '--handle', 'fence'], {
    env: { ...process.env, HOME: REAL_HOME, COURIER_HOME: '' }, encoding: 'utf8', timeout: 30_000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /test-home-escape/);
  assert.equal(statOf(REAL_PROFILE), before);
});

test('without COURIER_TEST=1 the fence is inert', () => {
  withEnv({ COURIER_TEST: undefined, COURIER_HOME: '/var/tmp/tc1920.elsewhere/courier' }, () => {
    assert.equal(profileDir(), '/var/tmp/tc1920.elsewhere/courier');
  });
});

test('COURIER_TEST=1 without COURIER_TEST_HOME refuses every home', () => {
  withEnv({ COURIER_TEST_HOME: undefined }, () => assert.throws(() => profileDir(), { code: 'test-home-escape' }));
});
