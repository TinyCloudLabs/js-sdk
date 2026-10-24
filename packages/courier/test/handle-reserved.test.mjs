import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HANDLE } from '../dist/request.js';
import { parseArtifact } from '../dist/pairing.js';

const artifact = (over = {}) => JSON.stringify({
  type: 'courier-pair', v: 0, step: 'A',
  from: { owner: 'did:pkh:eip155:1:0x0000000000000000000000000000000000000001', courier: 'did:key:z6MkTest' },
  spaceId: 'tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:agents',
  peer: 'hunter', callMe: 'sam', issuedAt: '2026-10-21T00:00:00.000Z',
  ...over,
});

test('HANDLE refuses a leading underscore and accepts ordinary handles', () => {
  for (const bad of ['_invites', '_x', '_', '']) assert.equal(HANDLE.test(bad), false, bad);
  for (const good of ['hunter', 'a_b', 'a-b', 'A9', '-x']) assert.equal(HANDLE.test(good), true, good);
});

test('parseArtifact refuses a reserved peer or callMe handle', () => {
  assert.equal(parseArtifact(artifact()).peer, 'hunter');
  for (const field of ['peer', 'callMe']) {
    assert.throws(
      () => parseArtifact(artifact({ [field]: '_invites' })),
      (e) => e.code === 'bad-artifact' && e.message.includes(`"${field}"`),
    );
  }
});
