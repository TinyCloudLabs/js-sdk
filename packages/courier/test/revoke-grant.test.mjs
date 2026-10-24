import { assertIsolated, testHome } from './tc1916-home.mjs';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertAgentGrant, assertExactAuthority, grantCanRevoke } from '../dist/authority.js';
import { courierGrantRequest } from '../dist/grant.js';
import { profileDir } from '../dist/profile.js';
import { AGENT_GRANT, REVOKE_GRANT_ENTRY } from '../dist/keys.js';

before(() => assertIsolated());

const run = promisify(execFile);
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const NOW = Date.parse('2026-10-24T12:00:00Z');
const DAY = 86_400_000;
const times = { issuedAt: new Date(NOW), expiresAt: new Date(NOW + 30 * DAY) };
const OLD_GRANT = AGENT_GRANT.filter((entry) => entry !== REVOKE_GRANT_ENTRY);
const hasRevoke = (permissions) => permissions.some((p) => p.service === 'tinycloud.delegation'
  && p.space === 'agents' && p.path === '' && p.actions.length === 1 && p.actions[0] === 'tinycloud.delegation/revoke');

test('a grant issued before the revoke entry still passes the authority check', () => {
  assert.doesNotThrow(() => assertAgentGrant(OLD_GRANT, times, NOW));
  assert.equal(grantCanRevoke(OLD_GRANT), false);
});

test('a grant with the revoke entry passes the authority check and can revoke', () => {
  assert.doesNotThrow(() => assertAgentGrant(AGENT_GRANT, times, NOW));
  assert.equal(grantCanRevoke(AGENT_GRANT), true);
});

test('every other entry stays required, with or without the revoke entry', () => {
  const withoutHooks = (grant) => grant.filter((entry) => entry.service !== 'tinycloud.hooks');
  assert.throws(() => assertAgentGrant(withoutHooks(OLD_GRANT), times, NOW), { code: 'grant-incomplete' });
  assert.throws(() => assertAgentGrant(withoutHooks(AGENT_GRANT), times, NOW), { code: 'grant-incomplete' });
  assert.throws(() => assertExactAuthority([], AGENT_GRANT, 'OpenKey grant'), { code: 'grant-incomplete' });
});

test('a revoke entry with an extra action, another space or another path is too broad', () => {
  const wrong = [
    { ...REVOKE_GRANT_ENTRY, actions: ['tinycloud.delegation/revoke', 'tinycloud.delegation/status'] },
    { ...REVOKE_GRANT_ENTRY, actions: ['tinycloud.delegation/status'] },
    { ...REVOKE_GRANT_ENTRY, space: 'other' },
    { ...REVOKE_GRANT_ENTRY, path: 'x/' },
  ];
  for (const entry of wrong) {
    assert.throws(() => assertAgentGrant([...OLD_GRANT, entry], times, NOW), { code: 'grant-too-broad' }, JSON.stringify(entry));
    assert.throws(() => assertAgentGrant([...AGENT_GRANT, entry], times, NOW), { code: 'grant-too-broad' }, JSON.stringify(entry));
    // The extra-action entry still holds the revoke tuple; the authority check above is what refuses it.
    if (!entry.actions.includes('tinycloud.delegation/revoke')) assert.equal(grantCanRevoke([...OLD_GRANT, entry]), false, JSON.stringify(entry));
  }
});

test('the grant request a new install sends to OpenKey includes the revoke entry', () => {
  const profile = { openkeyHost: 'https://openkey.so', host: 'https://tee.node.tinycloud.xyz' };
  const request = courierGrantRequest(profile, { did: 'did:key:z6Mkagent', jwk: {} }, '30d');
  assert.equal(hasRevoke(request.permissions), true);
});

test('`courier init --request` prints a grant that includes the revoke entry', async () => {
  assertIsolated();
  const home = fs.mkdtempSync(path.join(testHome, 'init-'));
  try {
    const { stdout } = await run(process.execPath, [CLI, 'init', '--request', '--handle', 'alice'], {
      env: { ...process.env, COURIER_HOME: path.join(home, 'h') },
      timeout: 60_000,
    });
    assert.equal(hasRevoke(JSON.parse(stdout).permissions), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the test fence refuses a Courier home outside the test home and is inert without COURIER_TEST', () => {
  const saved = { home: process.env.COURIER_HOME, flag: process.env.COURIER_TEST };
  try {
    for (const outside of ['/var/tmp/tc1916.elsewhere/courier', path.join(process.env.HOME, '..', 'x'), '/root/.courier', `${testHome}-sibling`]) {
      process.env.COURIER_HOME = outside;
      assert.throws(() => profileDir(), { code: 'test-home-escape' }, outside);
    }
    delete process.env.COURIER_HOME;
    process.env.HOME = '/var/tmp/tc1916.elsewhere';
    assert.throws(() => profileDir(), { code: 'test-home-escape' }, 'default $HOME/.courier outside the test home');
    process.env.HOME = testHome;
    process.env.COURIER_HOME = path.join(testHome, 'inside');
    assert.equal(profileDir(), path.join(testHome, 'inside'));
    delete process.env.COURIER_TEST;
    process.env.COURIER_HOME = '/var/tmp/tc1916.elsewhere/courier';
    assert.equal(profileDir(), '/var/tmp/tc1916.elsewhere/courier', 'no fence unless COURIER_TEST=1');
  } finally {
    process.env.HOME = testHome;
    process.env.COURIER_HOME = saved.home;
    process.env.COURIER_TEST = saved.flag;
    assertIsolated();
  }
});
