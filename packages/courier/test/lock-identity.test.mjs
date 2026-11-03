// The machine and boot a lock record was written on. A holder is judged locally only on the same machine; a different boot of the SAME
// machine proves the holder is gone (no process survives a reboot); a different or unknown machine is never judged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireLock, machineIdentity } from '../dist/file-lock.js';

const HOME = process.env.COURIER_HOME;
fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
const lock = (name) => path.join(HOME, `${name}.lock`);
const files = (map) => (file) => map[file];
const io = (platform, extra = {}) => ({ platform, readFile: () => undefined, exec: () => undefined, now: () => 1_700_000_000_000, uptime: () => 5000, ...extra });
const FALLBACK_BOOT = 'up:1699995000'; // now - uptime, in whole seconds

test('linux: machine-id and boot id come from /etc/machine-id and /proc', () => {
  const read = files({ '/etc/machine-id': 'abc123\n', '/proc/sys/kernel/random/boot_id': 'boot-1\n' });
  assert.deepEqual(machineIdentity(io('linux', { readFile: read })), { machine: 'abc123', boot: 'boot-1' });
});

test('linux: the dbus machine-id is used when /etc/machine-id is missing', () => {
  const read = files({ '/var/lib/dbus/machine-id': 'dbus-id\n', '/proc/sys/kernel/random/boot_id': 'b' });
  assert.equal(machineIdentity(io('linux', { readFile: read })).machine, 'dbus-id');
});

test('linux: an unreadable boot id falls back to the rounded boot time from uptime', () => {
  const read = files({ '/etc/machine-id': 'abc123' });
  assert.deepEqual(machineIdentity(io('linux', { readFile: read })), { machine: 'abc123', boot: FALLBACK_BOOT });
});

test('macOS: IOPlatformUUID from ioreg and the boot second from sysctl kern.boottime', () => {
  const exec = (cmd, args) => {
    if (cmd === 'ioreg') return `+-o Root\n    {\n      "IOPlatformUUID" = "11111111-2222-3333-4444-555555555555"\n    }\n`;
    if (cmd === 'sysctl' && args.join(' ') === '-n kern.boottime') return '{ sec = 1699990000, usec = 123456 } Tue Nov  7 10:33:20 2023\n';
    return undefined;
  };
  assert.deepEqual(machineIdentity(io('darwin', { exec })), { machine: '11111111-2222-3333-4444-555555555555', boot: 'boot:1699990000' });
});

test('macOS: a failing sysctl falls back to uptime; a failing ioreg leaves the machine unknown', () => {
  const exec = (cmd) => (cmd === 'ioreg' ? undefined : undefined);
  assert.deepEqual(machineIdentity(io('darwin', { exec })), { boot: FALLBACK_BOOT });
});

test('windows: MachineGuid from the registry and the last boot time', () => {
  const exec = (cmd) => {
    if (cmd === 'reg') return '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    aaaa-bbbb-cccc\r\n\r\n';
    if (cmd === 'powershell') return '2023-11-07T10:33:20.0000000Z\r\n';
    return undefined;
  };
  assert.deepEqual(machineIdentity(io('win32', { exec })), { machine: 'aaaa-bbbb-cccc', boot: 'boot:2023-11-07T10:33:20.0000000Z' });
});

test('windows: without the boot time command the uptime fallback is used', () => {
  const exec = (cmd) => (cmd === 'reg' ? '    MachineGuid    REG_SZ    g-1\r\n' : undefined);
  assert.deepEqual(machineIdentity(io('win32', { exec })), { machine: 'g-1', boot: FALLBACK_BOOT });
});

test('any other platform: no machine identity, boot from uptime', () => {
  assert.deepEqual(machineIdentity(io('freebsd')), { boot: FALLBACK_BOOT });
});

// ---- what a lock does with them ----

const here = (machine, boot) => () => ({ machine, boot });
const record = (over) => JSON.stringify({ pid: 2147483000, nonce: 'n', ...over });
async function take(name, content, identity) {
  const file = lock(name);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    const release = acquireLock(file, { identity });
    release();
    return { taken: true, file };
  } catch (error) {
    assert.equal(error.code, 'locked');
    return { taken: false, file, kept: fs.readFileSync(file, 'utf8') };
  }
}

test('a lock written in an earlier boot of this machine is recovered, even if its pid is alive now', async () => {
  const run = await take('reboot', record({ pid: process.pid, machine: 'M', boot: 'boot-old' }), here('M', 'boot-new'));
  assert.equal(run.taken, true);
});

test('a live holder in this boot is never taken, even with an old file', async () => {
  const content = record({ pid: process.pid, machine: 'M', boot: 'boot-1' });
  const old = new Date(Date.now() - 86_400_000);
  const file = lock('liveholder');
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, old, old);
  assert.throws(() => acquireLock(file, { identity: here('M', 'boot-1') }), (e) => e.code === 'locked');
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  fs.rmSync(file);
});

test('a different machine is never judged, whatever its boot', async () => {
  const content = record({ machine: 'OTHER', boot: 'boot-1' });
  const run = await take('othermachine', content, here('M', 'boot-1'));
  assert.equal(run.taken, false);
  assert.equal(run.kept, content);
  const rebooted = await take('othermachine2', record({ machine: 'OTHER', boot: 'boot-0' }), here('M', 'boot-1'));
  assert.equal(rebooted.taken, false, 'a different boot of ANOTHER machine proves nothing');
});

test('when this machine\'s identity cannot be read, no record is judged', async () => {
  const content = record({ machine: 'M', boot: 'boot-1' });
  assert.equal((await take('noidentity', content, () => ({}))).taken, false);
  assert.equal((await take('noboot', content, () => ({ machine: 'M' }))).taken, false);
});

test('fallback boot times match within two minutes and differ beyond; a fallback is never compared with an exact boot id', async () => {
  assert.equal((await take('fb-same', record({ pid: process.pid, machine: 'M', boot: 'up:1000000' }), here('M', 'up:1000090'))).taken, false, 'same boot: clock drift only');
  assert.equal((await take('fb-diff', record({ pid: process.pid, machine: 'M', boot: 'up:1000000' }), here('M', 'up:1003600'))).taken, true, 'an hour apart: rebooted');
  assert.equal((await take('fb-mixed', record({ pid: process.pid, machine: 'M', boot: 'boot-1' }), here('M', 'up:1000000'))).taken, false);
});

test('a record without machine and boot (an old pid-only lock) is still never judged', async () => {
  const run = await take('legacy-id', record({}), here('M', 'boot-1'));
  assert.equal(run.taken, false);
});
