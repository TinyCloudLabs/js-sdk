import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { Crash, crashAtWrite, homeFile, readHome, scenario } from './support/approval-fixture.mjs';
import { readyProfile, snapshot } from './support/review-fixture.mjs';

// TC-2383: a rotation journal replaces key.json, so its key is proven before anything is replayed: kty OKP, crv Ed25519, `x` and `d`
// base64url text decoding to exactly 32 bytes, `x` is the public key of `d`, and the `did:key` (and its fragment, when present) is derived from `x`. Any failure refuses with no file changed.

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const SECRET_MARK = 'journal-private-part';

/** A real journal (written by a real rotation killed right after the journal was renamed into place), and the old key for mix-ups. */
async function realJournal(ctx) {
  await readyProfile(ctx);
  const oldKey = readHome('key.json');
  const crash = crashAtWrite(ctx.t, 'rotation.json', { phase: 'after' });
  await assert.rejects(cmdInit(parseArgs(['--rotate-key', '--request'])), (error) => error instanceof Crash);
  crash.disarm();
  return { journal: readHome('rotation.json'), oldKey };
}

const CASES = {
  'kty other than OKP': (j) => { j.key.jwk.kty = 'EC'; },
  'no kty': (j) => { delete j.key.jwk.kty; },
  'crv other than Ed25519': (j) => { j.key.jwk.crv = 'X25519'; },
  'no crv': (j) => { delete j.key.jwk.crv; },
  'x of 31 bytes': (j) => { j.key.jwk.x = b64(Buffer.alloc(31, 7)); },
  'x of 33 bytes': (j) => { j.key.jwk.x = b64(Buffer.alloc(33, 7)); },
  'x that is not base64url': (j) => { j.key.jwk.x = '!!not base64url!!'; },
  'x with padding': (j) => { j.key.jwk.x = `${b64(Buffer.alloc(32, 7))}=`; },
  'd of 31 bytes': (j) => { j.key.jwk.d = b64(Buffer.alloc(31, 7)); },
  'd of 33 bytes': (j) => { j.key.jwk.d = b64(Buffer.alloc(33, 7)); },
  'd that is not base64url': (j) => { j.key.jwk.d = `${SECRET_MARK}!!`; },
  'd that is not text': (j) => { j.key.jwk.d = 7; },
  'a did that is not derived from x (another key\'s public part)': (j, { oldKey }) => { j.key.jwk.x = oldKey.jwk.x; j.key.jwk.d = oldKey.jwk.d; },
  'a private part that does not belong to the public part (two valid keys mixed)': (j, { oldKey }) => { j.key.jwk.d = oldKey.jwk.d; },
  'a did fragment that names another key': (j, { oldKey }) => { j.key.did = `${j.key.did.split('#')[0]}#${oldKey.did.split('#')[0].replace('did:key:', '')}`; },
  'a did whose key part is altered': (j) => { j.key.did = j.key.did.replace(/^did:key:z6Mk(.)/, (_, c) => `did:key:z6Mk${c === 'a' ? 'b' : 'a'}`); },
  'a did:key of another key type': (j) => { j.key.did = 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme'; },
  'a did that is not a did:key': (j) => { j.key.did = 'did:web:example.test'; },
};

for (const [name, change] of Object.entries(CASES)) {
  scenario(`a journal with ${name} is refused and no file changes`, async (ctx) => {
    const real = await realJournal(ctx);
    const journal = structuredClone(real.journal);
    // The profile is made to belong to whatever key the journal now holds, so only the key proof is under test.
    change(journal, real);
    journal.profile.courierDid = journal.key.did.split('#')[0];
    fs.writeFileSync(homeFile('rotation.json'), JSON.stringify(journal), { mode: 0o600 });
    const before = snapshot();
    ctx.errors.length = 0;
    const run = await ctx.courier('--request');
    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stderr, /not a valid key rotation record/);
    assert.match(run.stderr, /Nothing was changed/);
    assert.equal(run.stderr.includes(real.journal.key.jwk.d), false);
    assert.deepEqual(snapshot(), before, 'key.json, profile.json, grant.json and the journal are byte-identical');
  });
}

scenario('a real key whose did carries its own fragment, and one without it, are both replayed (control)', async (ctx) => {
  const { journal } = await realJournal(ctx);
  const bare = journal.key.did.split('#')[0];
  journal.key.did = `${bare}#${bare.replace('did:key:', '')}`;
  fs.writeFileSync(homeFile('rotation.json'), JSON.stringify(journal), { mode: 0o600 });
  const run = await ctx.courier('--request');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(readHome('key.json').did, journal.key.did);
});

scenario('the unmodified real journal is replayed (control)', async (ctx) => {
  const { journal } = await realJournal(ctx);
  const run = await ctx.courier('--request');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(readHome('key.json').did, journal.key.did);
  assert.equal(fs.existsSync(homeFile('rotation.json')), false);
});
