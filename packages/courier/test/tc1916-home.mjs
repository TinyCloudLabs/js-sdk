// Imported FIRST by every tc1916 test file. At module load it points HOME and COURIER_HOME at a fresh
// /var/tmp/tc1916.* directory and arms the profileDir() fence (COURIER_TEST=1 + COURIER_TEST_HOME), so a test can
// never read or write ~/.courier. Call assertIsolated() before any write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { profileDir } from '../dist/profile.js';

export const testHome = fs.mkdtempSync('/var/tmp/tc1916.');
fs.chmodSync(testHome, 0o700);
process.env.HOME = testHome;
process.env.COURIER_HOME = path.join(testHome, 'courier');
process.env.COURIER_TEST = '1';
process.env.COURIER_TEST_HOME = testHome;
process.on('exit', () => fs.rmSync(testHome, { recursive: true, force: true }));

const inside = (dir) => {
  const resolved = path.resolve(dir);
  return resolved.startsWith(`${testHome}${path.sep}`) || resolved === testHome;
};

/** Throws unless HOME and the Courier profile directory both resolve inside this process's tc1916 test home. */
export function assertIsolated() {
  assert.ok(/^\/var\/tmp\/tc1916\.[A-Za-z0-9]{6}$/.test(testHome), `test home ${testHome} is not a /var/tmp/tc1916.* dir`);
  assert.equal(process.env.HOME, testHome, 'HOME must be the tc1916 test home');
  assert.equal(process.env.COURIER_TEST, '1');
  assert.equal(process.env.COURIER_TEST_HOME, testHome);
  const dir = profileDir();
  assert.ok(inside(dir), `Courier profile dir ${dir} is outside the tc1916 test home ${testHome}`);
}
