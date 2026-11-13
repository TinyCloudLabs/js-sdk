import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../dist/main.js';
import { captureStdout } from './support/approval-fixture.mjs';

test('integrated revoke help describes real revocation and separate shared-file expiry with the invoked CLI name', async () => {
  const { result, stdout } = await captureStdout(() => main(['--help'], { prog: 'tinycloud courier' }));
  assert.equal(result, 0);
  const line = stdout.split('\n').find(value => value.includes('revoke <peer>'));
  assert.match(line, /Revoke the peer's access and remove the pairing/);
  assert.match(line, /Files you already shared stay available/);
  assert.match(line, /tinycloud share revoke <id>/);
  assert.doesNotMatch(line, /Stop renewing|lapses at delegation expiry/);
});
