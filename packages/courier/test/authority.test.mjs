import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_GRANT_MAX_MS, CLOCK_SKEW_MS, PEER_DELEGATION_MAX_MS,
  assertAgentGrant, assertExactAuthority, assertLifetime, assertPeerDelegation, durationMs,
} from '../dist/authority.js';
import { AGENT_GRANT, PREFIX } from '../dist/keys.js';

const NOW = Date.parse('2026-10-07T00:00:00Z');
const DAY = 86_400_000;
const split = AGENT_GRANT.flatMap((permission) => permission.actions.map((action) => ({
  ...permission,
  actions: [action],
  caveats: [],
})));
const SPACE = 'tinycloud:pkh:eip155:1:0xA2dF5051172C5Bc1D7FdB33ACC30f7B3C3A7efdF:agents';
const ISSUER = 'did:key:z6MkIssuer';
const AUD = 'did:key:z6MkAudience';
const expected = { issuer: ISSUER, audience: AUD, spaceId: SPACE.toLowerCase(), mailbox: 'bob' };
const mailboxPermissions = [
  { service: 'tinycloud.hooks', space: SPACE, path: `kv/${PREFIX}/to/bob`, actions: ['tinycloud.hooks/subscribe'] },
  { service: 'tinycloud.kv', space: SPACE, path: `${PREFIX}/to/bob/`, actions: ['tinycloud.kv/get', 'tinycloud.kv/list'] },
];
function signed(over = {}) {
  return {
    audience: AUD,
    expiry: new Date(NOW + 7 * DAY),
    delegation: { delegatorDID: ISSUER },
    effectivePermissions: mailboxPermissions,
    ...over,
  };
}

test('agent grant: exact set accepted in split and grouped shapes', () => {
  const times = { issuedAt: new Date(NOW), expiresAt: new Date(NOW + 30 * DAY) };
  assert.doesNotThrow(() => assertAgentGrant(split, times, NOW));
  assert.doesNotThrow(() => assertAgentGrant(AGENT_GRANT, times, NOW));
});

test('agent grant: any authority outside the manifest is too broad', () => {
  const extras = [
    { service: 'tinycloud.space', space: 'agents', path: '', actions: ['tinycloud.space/host'] },
    { service: 'tinycloud.kv', space: 'agents', path: `${PREFIX}/me/`, actions: ['tinycloud.kv/metadata'] },
    { service: 'tinycloud.kv', space: 'agents', path: `${PREFIX}/me/approvals/`, actions: ['tinycloud.kv/put'] },
    { service: 'tinycloud.kv', space: 'agents', path: `${PREFIX}/me/orders/x`, actions: ['tinycloud.kv/del'] },
    { service: 'tinycloud.kv', space: 'agents', path: `${PREFIX}/`, actions: ['tinycloud.kv/put'] },
    { service: 'tinycloud.kv', space: 'agents', path: `${PREFIX}/to/`, actions: ['tinycloud.kv/*'] },
    { service: 'tinycloud.encryption', space: 'agents', path: '/', actions: ['tinycloud.encryption/decrypt'] },
    { service: 'tinycloud.kv', space: 'other', path: split[0].path, actions: [split[0].actions[0]] },
  ];
  for (const extra of extras) {
    assert.throws(() => assertExactAuthority([...split, extra], AGENT_GRANT, 'OpenKey grant'), { code: 'grant-too-broad' });
  }
});

test('agent grant: missing authority is incomplete', () => {
  const withoutToDelete = split.filter((permission) => !(permission.path === `${PREFIX}/to/` && permission.actions[0] === 'tinycloud.kv/del'));
  assert.throws(() => assertAgentGrant(withoutToDelete, { issuedAt: new Date(NOW), expiresAt: new Date(NOW + DAY) }, NOW), { code: 'grant-incomplete' });
  assert.throws(() => assertExactAuthority([], AGENT_GRANT, 'OpenKey grant'), { code: 'grant-incomplete' });
});

test('agent grant: lifetime capped at 30 days plus skew', () => {
  const cap = 30 * DAY + CLOCK_SKEW_MS;
  assert.doesNotThrow(() => assertLifetime('OpenKey grant', new Date(NOW + cap), 30 * DAY, NOW, new Date(NOW)));
  assert.throws(() => assertLifetime('OpenKey grant', new Date(NOW + cap + 1000), 30 * DAY, NOW, new Date(NOW)), { code: 'grant-too-long' });
  assert.throws(() => assertLifetime('OpenKey grant', new Date(NOW + 365 * DAY), 30 * DAY, NOW, new Date(NOW)), { code: 'grant-too-long' });
  assert.throws(() => assertLifetime('OpenKey grant', new Date(NOW + DAY), 30 * DAY, NOW, new Date(NOW + 10 * 60_000)), { code: 'bad-grant' });
  assert.throws(() => assertAgentGrant(AGENT_GRANT, { expiresAt: new Date(NOW + DAY) }, NOW), { code: 'bad-grant' });
  assert.throws(() => assertLifetime('OpenKey grant', new Date(NOW), 30 * DAY, NOW, new Date(NOW)), { code: 'grant-expired' });
  assert.equal(AGENT_GRANT_MAX_MS, 30 * DAY);
});

test('peer delegation: exact mailbox accepted', () => {
  assert.doesNotThrow(() => assertPeerDelegation(signed(), expected, NOW));
  assert.doesNotThrow(() => assertPeerDelegation(signed({ delegation: { delegatorDID: `${ISSUER}#frag` } }), expected, NOW));
});

test('peer delegation: issuer and audience must match', () => {
  assert.throws(() => assertPeerDelegation(signed({ delegation: { delegatorDID: 'did:key:z6MkStranger' } }), expected, NOW), { code: 'bad-delegation' });
  assert.throws(() => assertPeerDelegation(signed({ delegation: {} }), expected, NOW), { code: 'bad-delegation' });
  assert.throws(() => assertPeerDelegation(signed({ audience: 'did:key:zOther' }), expected, NOW), { code: 'bad-delegation' });
});

test('peer delegation: authority outside the mailbox is rejected', () => {
  const extras = [
    { service: 'tinycloud.kv', space: SPACE, path: `${PREFIX}/me/`, actions: ['tinycloud.kv/get', 'tinycloud.kv/list'] },
    { service: 'tinycloud.kv', space: SPACE, path: `${PREFIX}/to/bob/`, actions: ['tinycloud.kv/put'] },
    { service: 'tinycloud.hooks', space: SPACE, path: `kv/${PREFIX}/to/bob/`, actions: ['tinycloud.hooks/subscribe'] },
    { service: 'tinycloud.kv', space: SPACE, path: `${PREFIX}/to/`, actions: ['tinycloud.kv/get'] },
    { service: 'tinycloud.kv', space: SPACE, path: `${PREFIX}/to/carol/`, actions: ['tinycloud.kv/get'] },
    { service: 'tinycloud.kv', space: 'tinycloud:pkh:eip155:1:0xother:agents', path: `${PREFIX}/to/bob/`, actions: ['tinycloud.kv/get'] },
  ];
  for (const extra of extras) {
    assert.throws(() => assertPeerDelegation(signed({ effectivePermissions: [...mailboxPermissions, extra] }), expected, NOW), { code: 'grant-too-broad' });
  }
  assert.throws(() => assertPeerDelegation(signed({ effectivePermissions: mailboxPermissions.slice(1) }), expected, NOW), { code: 'grant-incomplete' });

});

test('peer delegation: lifetime capped at 7 days plus skew', () => {
  const cap = 7 * DAY + CLOCK_SKEW_MS;
  assert.doesNotThrow(() => assertPeerDelegation(signed({ expiry: new Date(NOW + cap) }), expected, NOW));
  assert.throws(() => assertPeerDelegation(signed({ expiry: new Date(NOW + cap + 1000) }), expected, NOW), { code: 'grant-too-long' });
  assert.throws(() => assertPeerDelegation(signed({ expiry: new Date(NOW + 30 * DAY) }), expected, NOW), { code: 'grant-too-long' });
  assert.equal(PEER_DELEGATION_MAX_MS, 7 * DAY);
});

test('durationMs recognizes supported units and rejects malformed values', () => {
  assert.equal(durationMs('30d'), 30 * DAY);
  assert.equal(durationMs('7d'), 7 * DAY);
  assert.equal(durationMs('1h'), 3_600_000);
  for (const value of ['30', '1w', '-1d']) assert.equal(durationMs(value), undefined);
});
