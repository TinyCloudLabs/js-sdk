// TC-2254: the courier stores the ticket (did:key) email credential only. A held (account) result is refused before anything is
// verified or written; the ticket store path is covered by credential-source.test.mjs and credential-record-tamper.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { StoredCredentialSource } from '../dist/credential-source.js';

const home = mkdtempSync(join('/var/tmp', 'courier-held-'));
test.after(() => rmSync(home, { recursive: true, force: true }));

test('storing a held result is refused credential-record-invalid, nothing is verified and no file is written', async () => {
  let verified = 0;
  const source = new StoredCredentialSource(home, async () => { verified += 1; });
  const heldResult = { envelope: { profile: { id: 'tinycloud.email-held/v1', version: 1 } }, verified: {}, descriptor: {} };
  await assert.rejects(
    source.store({ result: heldResult, requirement: {}, requirementDigest: 'Q'.repeat(43), holderDid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH', now: new Date() }),
    (error) => error.code === 'credential-record-invalid',
  );
  assert.equal(verified, 0);
  const dir = join(home, 'credentials');
  assert.deepEqual(existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('credential-')) : [], []);
});
