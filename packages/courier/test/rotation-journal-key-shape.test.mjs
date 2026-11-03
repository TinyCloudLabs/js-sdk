import assert from 'node:assert/strict';
import fs from 'node:fs';
import { homeFile } from './support/approval-fixture.mjs';
import { scenario } from './support/approval-fixture.mjs';
import { readyProfile, snapshot } from './support/review-fixture.mjs';

// TC-2383: a rotation journal replaces key.json with the journal's key. The key must have the shape of a real agent key (a JWK that is
// an object carrying its public and private parts), not merely a truthy `jwk`; otherwise a parseable but malformed journal would
// install an unusable key over the good one.

const NEW_DID = 'did:key:z6MkNewAgentKeyForTheJournal';
const SECRET = 'journal-private-part-0123456789abcdef';
const journal = (jwk) => ({
  v: 1,
  key: { v: 1, jwk, did: NEW_DID, createdAt: '2026-01-01T00:00:00.000Z' },
  profile: { version: 3, host: 'https://node.test', openkeyHost: 'https://openkey.test', label: 'l', courierDid: NEW_DID, status: 'awaiting-grant', peers: {} },
  discardApproval: false,
  grantedResult: false,
});

const BAD_JWKS = {
  'a string': 'not-a-jwk',
  'a number': 7,
  'an array': [SECRET],
  'an empty object': {},
  'an object without a private part': { kty: 'OKP', crv: 'Ed25519', x: 'public-part' },
  'an object without a public part': { kty: 'OKP', crv: 'Ed25519', d: SECRET },
  'an object whose parts are not text': { kty: 'OKP', crv: 'Ed25519', x: 1, d: 2 },
};

for (const [kind, jwk] of Object.entries(BAD_JWKS)) {
  scenario(`a journal whose jwk is ${kind} is refused and no file changes`, async (ctx) => {
    await readyProfile(ctx);
    await ctx.request();
    fs.writeFileSync(homeFile('rotation.json'), JSON.stringify(journal(jwk)), { mode: 0o600 });
    const before = snapshot();
    ctx.errors.length = 0;
    const run = await ctx.courier('--request');
    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stderr, /not a valid key rotation record/);
    assert.match(run.stderr, /Nothing was changed/);
    assert.deepEqual(snapshot(), before, 'key.json, profile.json, grant.json and the journal are byte-identical');
    assert.equal(run.stderr.includes(SECRET), false);
  });
}
