import assert from 'node:assert/strict';
import { main } from '../dist/main.js';
import { captureStdout, fakeTime, readySpace, scenario, stubSpaceProbe } from './support/approval-fixture.mjs';

// TC-2360: an agent acts only on what Courier prints. `init --request` and a pending `init --wait` end their stderr
// with one line written for the agent: hand the owner the link, then run the follow-up command in the same turn.
// stdout (JSON) and exit codes are untouched.

const lines = (text) => text.split('\n');
const nextLines = (text) => lines(text).filter((line) => line.startsWith('Next:'));
const requestNext = (program) => `Next: after sending the owner this link, run \`${program} init --wait --timeout 60s\` now, in this same turn, without waiting for a reply.`;
const pendingNext = (command) => `Next: if you have not sent the owner this link yet, send it now. Then run \`${command}\` again right away, without waiting for a reply.`;

scenario('init --request ends stderr with the Next line, once, after the link; stdout JSON and exit code are as before', async ({ courier, errors }) => {
  const run = await courier('--request');
  assert.equal(run.code, 0);
  const printed = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(printed), ['did', 'courierDid', 'publicJwk', 'host', 'space', 'permissions', 'expiry', 'openkeyUrl']);
  assert.ok(!run.stdout.includes('Next:'));
  assert.deepEqual(nextLines(errors.join('\n')), [requestNext('courier')]);
  const all = lines(errors.join('\n'));
  assert.ok(all.indexOf(requestNext('courier')) > all.indexOf(printed.openkeyUrl), 'the Next line follows the link');
  assert.equal(all.filter((line) => line !== '').at(-1), requestNext('courier'), 'and is the last line');
});

scenario('a second init --request (the request is resumed) prints the Next line once, too', async ({ request, courier, errors }) => {
  await request();
  errors.length = 0;
  const run = await courier('--request');
  assert.equal(run.code, 0);
  assert.deepEqual(nextLines(errors.join('\n')), [requestNext('courier')]);
});

scenario('under tinycloud courier the init --request line names the command the user ran', async ({ errors }) => {
  const { result, stdout } = await captureStdout(() => main(['init', '--request'], { prog: 'tinycloud courier' }));
  assert.equal(result, 0);
  assert.ok(!stdout.includes('Next:'));
  assert.deepEqual(nextLines(errors.join('\n')), [requestNext('tinycloud courier')]);
});

scenario('init --wait that ends pending (exit 8) on a resumed request ends stderr with the Next line naming that command, once', async ({ t, request, courier, errors }) => {
  fakeTime(t);
  const printed = await request();
  errors.length = 0;
  const run = await courier('--wait', '--timeout', '5s');
  assert.equal(run.code, 8);
  assert.deepEqual(Object.keys(JSON.parse(run.stdout)), ['pending']);
  assert.equal(JSON.parse(run.stdout).pending.approvalUrl, printed.openkeyUrl);
  assert.ok(!run.stdout.includes('Next:'));
  const line = pendingNext('courier init --wait --timeout 5s');
  assert.deepEqual(nextLines(run.stderr), [line]);
  const all = lines(run.stderr);
  assert.ok(all.indexOf(line) > all.indexOf(printed.openkeyUrl), 'the Next line follows the link');
  assert.equal(all.filter((entry) => entry !== '').at(-1), line);
});

scenario('init --wait that created its request in this run and ends pending prints the same Next line', async ({ t, courier }) => {
  fakeTime(t);
  const run = await courier('--wait', '--timeout', '5s');
  assert.equal(run.code, 8);
  assert.deepEqual(nextLines(run.stderr), [pendingNext('courier init --wait --timeout 5s')]);
});

scenario('the pending Next line quotes an argument that has a space, and names tinycloud courier when that is how it was run', async ({ t, errors }) => {
  fakeTime(t);
  const { result } = await captureStdout(() => main(['init', '--wait', '--timeout', '5s', '--label', 'my agent'], { prog: 'tinycloud courier' }));
  assert.equal(result, 8);
  assert.deepEqual(nextLines(errors.join('\n')), [pendingNext("tinycloud courier init --wait --timeout 5s --label 'my agent'")]);
});

scenario('init --wait that succeeds prints no Next line', async ({ t, fx, request, courier, errors }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl, {});
  errors.length = 0;
  const run = await courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(nextLines(errors.join('\n')), []);
  assert.ok(!run.stdout.includes('Next:'));
});

scenario('a usage error prints no Next line', async ({ courier, errors }) => {
  const run = await courier('--request', '--wait');
  assert.equal(run.code, 2);
  assert.deepEqual(nextLines(errors.join('\n')), []);
});
