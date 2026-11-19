import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deriveState } from '../dist/state.js';
import { homeFile, scenario } from './support/approval-fixture.mjs';
import { readyProfile, snapshot } from './support/review-fixture.mjs';

// TC-2383: grant.json is inspected before any mode advice. A loose-mode file that is not a grant (cut short, not JSON, wrong shape) gets the
// corrupt-file warning, once, and no `chmod` advice: fixing its mode would not make it a grant. Only a loose file that IS a grant stops init.

const CONTENT = {
  'cut short': '{"v":1,"delegationHeader":{"Authoriz',
  'not JSON': 'this is not json',
  'JSON with no grant fields': JSON.stringify({ v: 1, spaceId: 's' }),
  'an array': '[1,2]',
  'an unknown version': JSON.stringify({ v: 2, delegationHeader: { Authorization: 'a' }, delegationCid: 'c', siwe: 'x' }),
};

for (const [kind, text] of Object.entries(CONTENT)) {
  scenario(`a mode-644 grant.json that is ${kind}: corrupt-file warning, no chmod advice, nothing changed`, async (ctx) => {
    await readyProfile(ctx);
    fs.writeFileSync(homeFile('grant.json'), text, { mode: 0o600 });
    fs.chmodSync(homeFile('grant.json'), 0o644);
    const derived = deriveState();
    assert.equal(derived.inputs.grant, false);
    assert.equal(derived.grantMode, undefined, 'not a saved grant, so no mode to fix');
    assert.equal(derived.notes.length, 1);
    assert.match(derived.notes[0], /grant\.json is not a usable saved grant/);
    const before = snapshot();
    ctx.errors.length = 0;
    const run = await ctx.courier('--request');
    assert.doesNotMatch(run.stderr, /profile-permissions/);
    assert.doesNotMatch(run.stderr, /chmod 600 [^\n]*grant\.json/);
    assert.equal((run.stderr.match(/grant\.json is not a usable saved grant/g) ?? []).length, 1);
    assert.equal(fs.readFileSync(homeFile('grant.json'), 'utf8'), text, 'left as it is');
    assert.equal(fs.statSync(homeFile('grant.json')).mode & 0o777, 0o644, 'mode left as it is');
    assert.notDeepEqual(snapshot(), before, 'the command itself went on (it only made its own request)');
  });
}
