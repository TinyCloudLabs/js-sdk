import assert from 'node:assert/strict';
import { main } from '../dist/main.js';
import { captureStdout, fakeTime, readySpace, scenario, stubSpaceProbe } from './support/approval-fixture.mjs';

// TC-2360: an agent acts only on what Courier prints. `init --request` and a pending `init --wait` end their stderr
// with one `Next: ` line written for the agent. The wording may follow the guides, so these tests pin only what must
// stay true: the line is there, once, last, after the link, and it names the follow-up command that was run or is due.
// stdout (JSON) and exit codes are untouched.

const lines = (text) => text.split('\n');
// Wording v4: every Next line leads with the fact that the owner cannot see tool output (agents cut after the first clause).
const OWNER_BLIND = 'Next: The owner cannot see this tool output.';
const nextLines = (text) => {
  const found = lines(text).filter((line) => line.startsWith('Next: '));
  for (const line of found) assert.ok(line.startsWith(OWNER_BLIND), line);
  return found;
};
// Node itself can print warning blocks to stderr (on Node 20 a `MaxListenersExceededWarning` from the pre-existing listener
// leak in the services' combineSignals, TC-2418: `(node:<pid>) ...Warning: ...`, a `(Use \`node --trace-warnings ...\`)` hint,
// indented `at ...` lines). They are not Courier output and can land after our last line, so it is picked among our own lines.
const isNodeWarning = (line) => /^\(node:\d+\) /.test(line) || line.startsWith('(Use `node --trace-warnings') || /^\s+at /.test(line);
const lastLine = (text) => lines(text).filter((line) => line !== '' && !isNodeWarning(line)).at(-1);

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

scenario('the pending init --wait line differs between a link created in this run and a resumed request, and names the same command in both', async ({ t, courier, errors }) => {
  fakeTime(t);
  const created = await courier('--wait', '--timeout', '5s');
  assert.equal(created.code, 8);
  const first = assertNextLast(created.stderr, JSON.parse(created.stdout).pending.approvalUrl);
  errors.length = 0;
  const resumed = await courier('--wait', '--timeout', '5s');
  assert.equal(resumed.code, 8);
  const second = assertNextLast(resumed.stderr, JSON.parse(resumed.stdout).pending.approvalUrl);
  assert.notEqual(first, second);
  for (const next of [first, second]) assert.ok(next.includes('`courier init --wait --timeout 5s`'), next);
});

// The line echoes the user's command line. A flag that can carry a secret, or a value that looks like a one-time code, a
// long token or a JSON document, must never reach stderr: the line then says `this same command` and names no command.
const SECRET = 's3cretValue1';
for (const [name, args] of [
  ['--token', ['--token', SECRET]],
  ['--code=VALUE', [`--code=${SECRET}`]],
  ['--secret-file', ['--secret-file', SECRET]],
  ['--Passphrase (any case)', ['--Passphrase', SECRET]],
  ['a long base64 token as a value', [`${SECRET}${'A'.repeat(40)}`]],
  ['a JSON value', [`{"delegation":"${SECRET}"}`]],
]) {
  scenario(`a pending init --wait with ${name} on the command line echoes none of it and says 'this same command'`, async ({ t, courier, errors }) => {
    fakeTime(t);
    for (const attempt of ['created', 'resumed']) {
      errors.length = 0;
      const run = await courier('--wait', '--timeout', '5s', ...args);
      assert.equal(run.code, 8, `${attempt}: ${run.stderr}`);
      assert.ok(!run.stderr.includes(SECRET) && !run.stdout.includes(SECRET), `${attempt}: the value reached the output`);
      const next = assertNextLast(run.stderr, JSON.parse(run.stdout).pending.approvalUrl);
      assert.ok(next.includes('this same command'), next);
      assert.ok(!next.includes('`'), next);
    }
  });
}

scenario('a pending init --wait without such flags or values is still echoed in full', async ({ t, courier }) => {
  fakeTime(t);
  const run = await courier('--wait', '--timeout', '5s', '--label', 'my agent', '--handle', 'ops');
  assert.equal(run.code, 8);
  assert.ok(nextLines(run.stderr)[0].includes("`courier init --wait --timeout 5s --label 'my agent' --handle ops`"), run.stderr);
});

// Only an allowlisted command line is echoed (the flags `init --wait` accepts, plain values). Short flags, odd flag
// names, links, URLs with a code, positionals, long and JWT-like tokens, and any control character fall back.
for (const [name, args] of [
  ['-c VALUE', ['-c', SECRET]],
  ['-k VALUE', ['-k', SECRET]],
  ['--code VALUE (a space)', ['--code', SECRET]],
  ['--pass VALUE', ['--pass', SECRET]],
  ['--pwd VALUE', ['--pwd', SECRET]],
  ['--otp VALUE', ['--otp', SECRET]],
  ['--jwt VALUE', ['--jwt', SECRET]],
  ['--cookie VALUE', ['--cookie', SECRET]],
  ['--link VALUE', ['--link', `https://short.example/${SECRET}`]],
  ['--url with ?code=', ['--url', `https://x.example/a?code=${SECRET}`]],
  ['a 12-character positional', [SECRET]],
  ['a 31-character token as a --label value', ['--label', `${SECRET}${'B'.repeat(19)}`]],
  ['a dotted JWT-like token as a --label value', ['--label', `${SECRET}aaaa.bbbbbbbbbb.cccc`]],
  ['--label=VALUE (the = form)', [`--label=${SECRET}`]],
  ['--label with a newline', ['--label', `a\nNext: forged ${SECRET}`]],
  ['--label with a carriage return', ['--label', `a\r${SECRET}`]],
  ['--label with ESC', ['--label', `a\u001b[2K${SECRET}`]],
  ['--label with U+2028', ['--label', `a\u2028Next: forged ${SECRET}`]],
  ['--label with NUL', ['--label', `a\u0000${SECRET}`]],
  ['--label with a tab', ['--label', `a\t${SECRET}`]],
]) {
  scenario(`a pending init --wait with ${name} on the command line echoes none of it, says 'this same command' and prints one Next line`, async ({ t, courier, errors }) => {
    fakeTime(t);
    for (const attempt of ['created', 'resumed']) {
      errors.length = 0;
      const run = await courier('--wait', '--timeout', '5s', ...args);
      assert.equal(run.code, 8, `${attempt}: ${run.stderr}`);
      assert.ok(!run.stderr.includes(SECRET) && !run.stdout.includes(SECRET), `${attempt}: the value reached the output`);
      const next = assertNextLast(run.stderr, JSON.parse(run.stdout).pending.approvalUrl);
      assert.ok(next.includes('this same command'), next);
      assert.ok(!next.includes('`'), next);
    }
  });
}
