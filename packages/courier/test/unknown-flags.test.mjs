import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const FAKE_LINKS = new URL('./support/fake-links-fetch.mjs', import.meta.url).href;

// The spawned CLI's `init --request` creates an approval link. Without these two variables it would POST to the production
// links API (nine requests per run): the unresolvable origin plus the local stub answer that call in-process instead.
// `NODE_OPTIONS` keeps what the test environment already carries (the production-origin guard).
function run(home, argv, input) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    env: {
      ...process.env,
      COURIER_HOME: home,
      TC_LINKS_API_ORIGIN: 'https://links.fixture.invalid',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${FAKE_LINKS}`].filter(Boolean).join(' '),
    },
    encoding: 'utf8', timeout: 20_000, input,
  });
}

function snapshot(home) {
  const out = {};
  for (const name of fs.readdirSync(home).sort()) out[name] = fs.readFileSync(path.join(home, name)).toString('base64');
  return out;
}

for (const argv of [
  ['init', '--wait', '--bogus', '1'],
  ['init', '--request', '--bogus'],
  ['init', '--rotate-key', '--bogus=1'],
  ['init', '--grant-file', '-', '--bogus'],
  ['inbox', '--bogus'],
  ['send', 'bob', '--new', 's', '--text', 't', '--bogus', 'x'],
  ['pair', 'renew', 'bob', '--renew-artefact'],
  ['watch', '--onc'],
  ['approval', 'abc', '--peeek'],
]) {
  test(`unknown flag exits 2 with no side effect: ${argv.join(' ')}`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-unknown-flag-'));
    const made = run(home, ['init', '--request', '--handle', 'alice']);
    // The init request needs a link API: the local stub answers it, so the profile and a saved request exist before the unknown flag.
    const before = snapshot(home);
    const stray = path.join(home, 'profile.json.tmp-999999');
    const r = run(home, argv, 'not a grant');
    assert.equal(r.status, 2, `${made.stderr}\n${r.stderr}`);
    assert.match(r.stderr, /Unknown flag --[a-z-]+/);
    assert.equal(fs.existsSync(stray), false);
    assert.deepEqual(snapshot(home), before);
  });
}

test('a stray temp file is not recovered when init gets an unknown flag', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-unknown-flag-'));
  const stray = path.join(home, 'key.json.tmp-1');
  fs.writeFileSync(stray, 'secret', { mode: 0o600 });
  const r = run(home, ['init', '--wait', '--bogus', '1']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown flag --bogus for init/);
  assert.equal(fs.existsSync(stray), true);
});

test('known flags are still accepted', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-unknown-flag-'));
  const r = run(home, ['orders', 'bob', '--json']);
  assert.doesNotMatch(r.stderr, /Unknown flag/);
});

// A flag that can carry a secret is refused like any other unknown flag, and its value never reaches the output.
const SECRET = 's3cretValue1';
for (const args of [
  ['--token', SECRET], [`--code=${SECRET}`], ['--secret-file', SECRET], ['--Passphrase', SECRET], ['--pass', SECRET], ['--pwd', SECRET],
  ['--otp', SECRET], ['--jwt', SECRET], ['--cookie', SECRET], ['--link', `https://short.example/${SECRET}`], ['--url', `https://x.example/a?code=${SECRET}`],
]) {
  test(`init --wait ${args[0]} is refused without echoing its value`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-unknown-flag-'));
    const r = run(home, ['init', '--wait', '--timeout', '5s', ...args]);
    assert.equal(r.status, 2);
    assert.ok(!r.stderr.includes(SECRET) && !r.stdout.includes(SECRET), r.stderr);
  });
}
