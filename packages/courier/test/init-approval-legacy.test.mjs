import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PREFIX } from '../dist/keys.js';
import { loadProfile } from '../dist/profile.js';
import { homeFile, readHome, readySpace, scenario, signedGrant, stubSpaceProbe } from './support/approval-fixture.mjs';

// A legacy import (`init --grant-file`, `--paste`) and a short-link request can both be open at once. A successful import
// must not leave the request behind (a later `init --wait` would collect it on top of the new grant); a refused import must
// leave it alone (the owner may still approve the link).

const importGrant = async (courier, options = {}) => {
  const grant = await signedGrant(readHome('key.json'), options);
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
  return courier('--grant-file', homeFile('legacy-grant.json'));
};

scenario('a successful legacy import clears the open short-link request; --wait then says nothing is pending', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  await request();
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), true);
  const imported = await importGrant(courier);
  assert.equal(imported.code, 0, imported.stderr);
  assert.equal(loadProfile().status, 'ready');
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false, 'the stale request is gone');
  const waited = await courier('--wait');
  assert.equal(waited.code, 2);
  assert.match(waited.stderr, /no approval request is pending/);
  assert.match(waited.stderr, /`courier init --request`/);
  assert.equal(fx.created.length, 1, 'nothing new was requested');
});

scenario('a legacy import that leaves the agents space pending still clears the open request (the grant is installed)', async ({ t, request, courier }) => {
  stubSpaceProbe(t, async () => ({ ok: false, error: { status: 404, message: 'Space not found' } }));
  await request();
  const imported = await importGrant(courier);
  assert.equal(imported.code, 1);
  assert.match(imported.stderr, /\[no-space\]/);
  assert.equal(loadProfile().status, 'awaiting-space');
  assert.equal(fs.existsSync(homeFile('approval-pending.json')), false);
});

scenario('a REFUSED legacy import leaves the open short-link request untouched, and the owner can still approve it', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  const before = fs.readFileSync(homeFile('approval-pending.json'));
  const refused = await importGrant(courier, { hooksPath: `kv/${PREFIX}/me/state/` });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /\[grant-too-broad\]/);
  assert.deepEqual(fs.readFileSync(homeFile('approval-pending.json')), before);
  await fx.approve(printed.openkeyUrl);
  const run = await courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(loadProfile().status, 'ready');
  assert.equal(fx.created.length, 1);
});

scenario('with an open request and no flags, --request reprints the same link (resume); only an explicit different --expiry makes another', async ({ fx, request }) => {
  const first = await request();
  assert.equal((await request()).openkeyUrl, first.openkeyUrl);
  assert.equal(fx.created.length, 1);
  assert.notEqual((await request('--expiry', '7d')).openkeyUrl, first.openkeyUrl);
  assert.equal(fx.created.length, 2);
});
