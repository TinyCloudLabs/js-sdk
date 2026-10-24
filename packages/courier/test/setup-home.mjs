// Preloaded into every test file's process (`node --import ./test/setup-home.mjs --test test/*.test.mjs`).
// Points HOME, COURIER_HOME and TMPDIR at a fresh /var/tmp/tc1920.* directory and arms the profileDir() fence
// (COURIER_TEST=1, COURIER_TEST_HOME), so no test can read or write ~/.courier. Not a test file.
//
// - The `--test` runner parent runs no tests and is skipped (its execArgv still carries `--test`).
// - A child forked by an armed test process (inherits --import) reuses its parent's home instead of creating a
//   second one, so a child killed on purpose cannot leave a directory behind; only the owner removes the home.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_PATTERN = /^\/var\/tmp\/tc1920\.[A-Za-z0-9]{6}$/;

if (!process.execArgv.includes('--test')) {
  let testHome = process.env.COURIER_TEST_HOME;
  const inherited = process.env.COURIER_TEST_OWNER === String(process.ppid)
    && process.env.COURIER_TEST === '1' && testHome !== undefined && HOME_PATTERN.test(testHome) && fs.existsSync(testHome);
  if (!inherited) {
    testHome = fs.mkdtempSync('/var/tmp/tc1920.');
    fs.chmodSync(testHome, 0o700);
    const tmp = path.join(testHome, 'tmp');
    fs.mkdirSync(tmp, { mode: 0o700 });
    process.env.HOME = testHome;
    process.env.COURIER_HOME = path.join(testHome, 'courier');
    process.env.COURIER_TEST = '1';
    process.env.COURIER_TEST_HOME = testHome;
    process.env.TMPDIR = tmp;
    process.on('exit', () => fs.rmSync(testHome, { recursive: true, force: true }));
  }
  process.env.COURIER_TEST_OWNER = String(process.pid);

  assert.match(testHome, HOME_PATTERN, 'test home must be a /var/tmp/tc1920.* dir');
  assert.equal(process.env.COURIER_TEST, '1');
  assert.equal(process.env.COURIER_TEST_HOME, testHome);
  if (!inherited) {
    assert.equal(process.env.HOME, testHome);
    assert.equal(process.env.COURIER_HOME, path.join(testHome, 'courier'));
    assert.equal(os.tmpdir(), path.join(testHome, 'tmp'), 'os.tmpdir() must resolve inside the test home');
  }
}
