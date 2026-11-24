import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { acquireLock, lockRefusal, processIdentityRecord, recordLiveness } from '../dist/file-lock.js';

const HOME = process.env.COURIER_HOME;
fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
const here = { machine: 'lock-live-advice-machine' };
const identity = () => here;
const noRemoval = (message) => assert.doesNotMatch(message, /\brm\b|Remove-Item|clear it with|remove (?:the |this )?lock/i);

function lockFile(t) {
  const dir = fs.mkdtempSync(path.join(HOME, 'lock-live-advice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'profile.json.lock');
}

test('a successful local pid probe identifies a real live holder as alive', () => {
  const record = processIdentityRecord(process.pid, 'live', here);
  assert.equal(recordLiveness(record, here), 'alive');
});

test('a real live lock names its exact pid, gives no removal advice, and preserves the file', (t) => {
  const file = lockFile(t);
  const release = acquireLock(file, { identity });
  t.after(release);
  const content = fs.readFileSync(file, 'utf8');
  assert.throws(() => acquireLock(file, { identity }), (error) => {
    assert.equal(error.code, 'locked');
    assert.match(error.message, new RegExp(`running Courier command \\(pid ${process.pid}\\b`));
    noRemoval(error.message);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});

test('an unknown holder names its pid, host and lock age, explains inspection, and preserves the file', (t) => {
  const file = lockFile(t);
  const host = 'another-courier-host';
  const content = `${JSON.stringify({ pid: process.pid, nonce: 'unknown', host })}\n`;
  fs.writeFileSync(file, content, { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  assert.throws(() => acquireLock(file, { identity }), (error) => {
    assert.equal(error.code, 'locked');
    assert.match(error.message, new RegExp(`\\bpid ${process.pid}\\b`));
    assert.ok(error.message.includes(JSON.stringify(host)), error.message);
    assert.match(error.message, /lock file age \d+s/);
    assert.match(error.message, /(?:inspect|check).*(?:host|namespace)/i);
    assert.ok(error.message.includes(process.platform === 'win32' ? `Get-Process -Id ${process.pid}` : `ps -p ${process.pid}`), error.message);
    noRemoval(error.message);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});

test('unproven machine identity and EPERM remain unknown', (t) => {
  const record = processIdentityRecord(process.pid, 'unknown', here);
  assert.equal(recordLiveness({ ...record, machine: undefined }, here), 'unknown');
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); });
  assert.equal(recordLiveness(record, here), 'unknown');
});

test('refusals never offer removal commands on either platform or call a contended holder dead', () => {
  for (const platform of ['linux', 'win32']) {
    for (const reason of ['alive', 'unknown', 'corrupt', 'contended']) {
      const message = lockRefusal({ file: 'profile.json.lock', reason, pid: 12345, host: 'courier-host' }, platform);
      noRemoval(message);
      if (reason === 'unknown') {
        assert.match(message, /(?:inspect|check)/i);
        assert.ok(message.includes(platform === 'win32' ? 'Get-Process -Id 12345' : 'ps -p 12345'), message);
      }
      if (reason === 'contended') assert.doesNotMatch(message, /\bdead\b/i);
    }
  }
});
