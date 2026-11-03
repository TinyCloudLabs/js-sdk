import assert from 'node:assert/strict';
import { main } from '../dist/main.js';
import { captureStdout, fakeTime, readySpace, scenario, stubSpaceProbe } from './support/approval-fixture.mjs';

// TC-2360: an agent acts only on what Courier prints. `init --request` and a pending `init --wait` end their stderr
// with one `Next: ` line written for the agent. The wording may follow the guides, so these tests pin only what must
// stay true: the line is there, once, last, after the link, and it names the follow-up command that was run or is due.
// stdout (JSON) and exit codes are untouched.

const lines = (text) => text.split('\n');
const nextLines = (text) => lines(text).filter((line) => line.startsWith('Next: '));
const lastLine = (text) => lines(text).filter((line) => line !== '').at(-1);

/** One Next line, printed last, after the link line. */
function assertNextLast(stderr, link) {
  const next = nextLines(stderr);
  assert.equal(next.length, 1, `exactly one Next line, got ${next.length}`);
  const all = lines(stderr);
  assert.ok(all.indexOf(link) >= 0, 'the link is on stderr');
  assert.ok(all.indexOf(next[0]) > all.indexOf(link), 'the Next line follows the link');
  assert.equal(lastLine(stderr), next[0], 'and is the last line');
  return next[0];
}

scenario('init --request ends stderr with one Next line naming init --wait --timeout 60s; stdout JSON and exit code are as before', async ({ courier, errors }) => {
  const run = await courier('--request');
  assert.equal(run.code, 0);
  const printed = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(printed), ['did', 'courierDid', 'publicJwk', 'host', 'space', 'permissions', 'expiry', 'openkeyUrl']);
  assert.ok(!run.stdout.includes('Next:'));
  const next = assertNextLast(errors.join('\n'), printed.openkeyUrl);
  assert.ok(next.includes('`courier init --wait --timeout 60s`'), next);
});

scenario('a second init --request (the request is resumed) prints one Next line, too', async ({ request, courier, errors }) => {
  const printed = await request();
  errors.length = 0;
  const run = await courier('--request');
  assert.equal(run.code, 0);
  assertNextLast(errors.join('\n'), printed.openkeyUrl);
});

scenario('under tinycloud courier the init --request line names the command the user ran', async ({ errors }) => {
  const { result, stdout } = await captureStdout(() => main(['init', '--request'], { prog: 'tinycloud courier' }));
  assert.equal(result, 0);
  assert.ok(!stdout.includes('Next:'));
  const next = assertNextLast(errors.join('\n'), JSON.parse(stdout).openkeyUrl);
  assert.ok(next.includes('`tinycloud courier init --wait --timeout 60s`'), next);
});

scenario('init --wait that ends pending (exit 8) on a resumed request ends stderr with one Next line naming that command', async ({ t, request, courier, errors }) => {
  fakeTime(t);
  const printed = await request();
  errors.length = 0;
  const run = await courier('--wait', '--timeout', '5s');
  assert.equal(run.code, 8);
  assert.deepEqual(Object.keys(JSON.parse(run.stdout)), ['pending']);
  assert.equal(JSON.parse(run.stdout).pending.approvalUrl, printed.openkeyUrl);
  assert.ok(!run.stdout.includes('Next:'));
  const next = assertNextLast(run.stderr, printed.openkeyUrl);
  assert.ok(next.includes('`courier init --wait --timeout 5s`'), next);
});

scenario('init --wait that created its request in this run and ends pending prints the Next line too', async ({ t, courier }) => {
  fakeTime(t);
  const run = await courier('--wait', '--timeout', '5s');
  assert.equal(run.code, 8);
  const next = assertNextLast(run.stderr, JSON.parse(run.stdout).pending.approvalUrl);
  assert.ok(next.includes('`courier init --wait --timeout 5s`'), next);
});

scenario('the pending Next line quotes an argument that has a space, and names tinycloud courier when that is how it was run', async ({ t, errors }) => {
  fakeTime(t);
  const { result, stdout } = await captureStdout(() => main(['init', '--wait', '--timeout', '5s', '--label', 'my agent'], { prog: 'tinycloud courier' }));
  assert.equal(result, 8);
  const next = assertNextLast(errors.join('\n'), JSON.parse(stdout).pending.approvalUrl);
  assert.ok(next.includes("`tinycloud courier init --wait --timeout 5s --label 'my agent'`"), next);
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
