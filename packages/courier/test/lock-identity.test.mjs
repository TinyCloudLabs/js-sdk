// The machine and boot a lock record was written on. A holder is judged locally only on the same machine; a different boot of the SAME
// machine proves the holder is gone (no process survives a reboot); a different or unknown machine is never judged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireLock, lockRefusal, machineIdentity } from '../dist/file-lock.js';
import { removalCommand } from './support/lock-identity.mjs';

const HOME = process.env.COURIER_HOME;
fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
const lock = (name) => path.join(HOME, `${name}.lock`);
const files = (map) => (file) => map[file];
const io = (platform, extra = {}) => ({ platform, readFile: () => undefined, exec: () => undefined, now: () => 1_700_000_000_000, uptime: () => 5000, ...extra });
const calls = [];
const spy = (fn) => (cmd, args) => { calls.push([cmd, ...args].join(' ')); return fn(cmd, args); };

test('linux: machine-id and the kernel boot id come from /etc/machine-id and /proc', () => {
  const read = files({ '/etc/machine-id': 'abc123\n', '/proc/sys/kernel/random/boot_id': 'boot-1\n' });
  assert.deepEqual(machineIdentity(io('linux', { readFile: read })), { machine: 'abc123', boot: 'linux:boot-1' });
});

test('linux: the dbus machine-id is used when /etc/machine-id is missing', () => {
  const read = files({ '/var/lib/dbus/machine-id': 'dbus-id\n', '/proc/sys/kernel/random/boot_id': 'b' });
  assert.equal(machineIdentity(io('linux', { readFile: read })).machine, 'dbus-id');
});

test('linux: an unreadable boot id leaves the boot unknown: no clock-derived value stands in for it', () => {
  assert.deepEqual(machineIdentity(io('linux', { readFile: files({ '/etc/machine-id': 'abc123' }) })), { machine: 'abc123' });
});

test('macOS: IOPlatformUUID and kern.bootsessionuuid, by absolute path; the wall-clock kern.boottime is never read', () => {
  calls.length = 0;
  const exec = spy((cmd, args) => {
    if (cmd === '/usr/sbin/ioreg') return `+-o Root\n    {\n      "IOPlatformUUID" = "11111111-2222-3333-4444-555555555555"\n    }\n`;
    if (cmd === '/usr/sbin/sysctl' && args.join(' ') === '-n kern.bootsessionuuid') return 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE\n';
    return undefined;
  });
  assert.deepEqual(machineIdentity(io('darwin', { exec })), { machine: '11111111-2222-3333-4444-555555555555', boot: 'macos:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE' });
  assert.ok(calls.every((c) => c.startsWith('/usr/sbin/')), calls.join(' | '));
  assert.ok(!calls.some((c) => c.includes('boottime')));
});

test('macOS: a failing bootsessionuuid leaves the boot unknown', () => {
  const exec = (cmd) => (cmd === '/usr/sbin/ioreg' ? '"IOPlatformUUID" = "U-1"' : undefined);
  assert.deepEqual(machineIdentity(io('darwin', { exec })), { machine: 'U-1' });
});

test('windows: MachineGuid from the registry through the system reg.exe; no per-boot identity is claimed', () => {
  calls.length = 0;
  const exec = spy((cmd) => (cmd.toLowerCase().endsWith('reg.exe') ? '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    aaaa-bbbb-cccc\r\n\r\n' : undefined));
  assert.deepEqual(machineIdentity(io('win32', { exec, systemRoot: 'C:\\Windows' })), { machine: 'aaaa-bbbb-cccc' });
  assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['C:\\Windows\\System32\\reg.exe'], 'only the absolute reg.exe; no powershell');
});

test('any other platform: no identity at all', () => {
  assert.deepEqual(machineIdentity(io('freebsd')), {});
});

// ---- what a lock does with them ----

const HOST = os.hostname();
const here = (machine, boot) => () => ({ machine, ...(boot === undefined ? {} : { boot }) });
const PIDNS = (() => { try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return undefined; } })();
const record = (over) => JSON.stringify({ pid: 2147483000, nonce: 'n', host: HOST, pidns: PIDNS, ...over });
const gone = async () => { const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); const { pid } = child; await new Promise((r) => child.once('exit', r)); return pid; };
async function take(name, content, identity) {
  const file = lock(name);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    acquireLock(file, { identity })();
    return { taken: true, file };
  } catch (error) {
    assert.equal(error.code, 'locked');
    return { taken: false, file, message: error.message, kept: fs.readFileSync(file, 'utf8') };
  }
}

test('a lock written in an earlier boot of this machine (true boot ids differ) is recovered, even if its pid is alive now', async () => {
  assert.equal((await take('reboot', record({ pid: process.pid, machine: 'M', boot: 'linux:old' }), here('M', 'linux:new'))).taken, true);
  assert.equal((await take('reboot-mac', record({ pid: process.pid, machine: 'M', boot: 'macos:old' }), here('M', 'macos:new'))).taken, true);
});

test('the host is compared before the boot: a renamed host after a reboot keeps the lock and shows the recovery line', async () => {
  const content = record({ pid: await gone(), machine: 'M', boot: 'linux:old', host: 'old-name' });
  const run = await take('renamed', content, here('M', 'linux:new'));
  assert.equal(run.taken, false);
  assert.equal(run.kept, content);
  assert.match(run.message, /only after confirming no Courier command is running/);
  assert.ok(run.message.endsWith(removalCommand(run.file)), run.message);
});

test('a machine-id shared by two hosts (a cloned image) never lets one judge the other\'s lock', async () => {
  const content = record({ pid: await gone(), machine: 'M', boot: 'linux:old', host: 'clone-b' });
  assert.equal((await take('clone', content, here('M', 'linux:old'))).taken, false);
  assert.equal((await take('clone2', content, here('M', 'linux:new'))).taken, false);
});

test('a record without a host is not judged, however well its machine matches', async () => {
  assert.equal((await take('nohost', JSON.stringify({ pid: await gone(), nonce: 'n', machine: 'M', boot: 'linux:b' }), here('M', 'linux:b'))).taken, false);
});

test('a live holder in this boot is never taken, even with an old file', () => {
  const content = record({ pid: process.pid, machine: 'M', boot: 'linux:b', start: undefined });
  const old = new Date(Date.now() - 86_400_000);
  const file = lock('liveholder');
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, old, old);
  assert.throws(() => acquireLock(file, { identity: here('M', 'linux:b') }), (e) => e.code === 'locked');
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  fs.rmSync(file);
});

// test-ruling: TC-2384 (replaces the earlier `fb-diff` assertion, which took a clock difference as a reboot even with a live pid)
test('clock-derived boot values never decide: a live pid is kept, a gone pid is recovered by the pid evidence alone', async () => {
  for (const [kind, boot] of [['kern.boottime', 'boot:1699990000'], ['windows last boot', 'boot:2023-11-07T10:33:20.0000000Z'], ['uptime', 'up:1000000']]) {
    const live = await take(`clock-live-${kind}`, record({ pid: process.pid, machine: 'M', boot }), here('M', 'linux:b'));
    assert.equal(live.taken, false, `${kind}: a live pid is not stolen on a clock difference`);
    const dead = await take(`clock-dead-${kind}`, record({ pid: await gone(), machine: 'M', boot }), here('M', 'linux:b'));
    assert.equal(dead.taken, true, `${kind}: a gone pid is positive evidence`);
  }
});

test('clock jitter between two reads of the same boot is not a reboot: a live holder is kept', async () => {
  const live = await take('jitter', record({ pid: process.pid, machine: 'M', boot: 'boot:1699990000' }), () => ({ machine: 'M', boot: 'boot:1699990001' }));
  assert.equal(live.taken, false);
  assert.equal((await take('jitter-up', record({ pid: process.pid, machine: 'M', boot: 'up:1000000' }), () => ({ machine: 'M', boot: 'up:1000007' }))).taken, false);
});

test('different kinds of boot identity are not compared', async () => {
  assert.equal((await take('kinds', record({ pid: process.pid, machine: 'M', boot: 'macos:X' }), here('M', 'linux:Y'))).taken, false);
});

test('a platform with no per-boot identity (windows): a live pid is kept, a gone pid is recovered', async () => {
  assert.equal((await take('win-live', record({ pid: process.pid, machine: 'M' }), here('M'))).taken, false);
  assert.equal((await take('win-dead', record({ pid: await gone(), machine: 'M' }), here('M'))).taken, true);
});

test('a different machine is never judged, whatever its boot', async () => {
  const content = record({ machine: 'OTHER', boot: 'linux:b' });
  const run = await take('othermachine', content, here('M', 'linux:b'));
  assert.equal(run.taken, false);
  assert.equal(run.kept, content);
  assert.equal((await take('othermachine2', record({ machine: 'OTHER', boot: 'linux:a' }), here('M', 'linux:b'))).taken, false);
});

test('when this machine\'s identity cannot be read, no record is judged', async () => {
  const content = record({ machine: 'M', boot: 'linux:b' });
  assert.equal((await take('noidentity', content, () => ({}))).taken, false);
});

test('a record without a machine (an old pid-only lock) is never judged', async () => {
  assert.equal((await take('legacy-id', JSON.stringify({ pid: await gone(), nonce: 'n' }), here('M', 'linux:b'))).taken, false);
});

// ---- the refusal line ----

test('the recovery command matches the platform: POSIX rm, or PowerShell Remove-Item with the path quoted literally', () => {
  const info = { file: '/home/u/.courier/profile.json.lock', reason: 'unknown', pid: 7, host: 'h' };
  assert.ok(lockRefusal(info, 'linux').endsWith("rm -f -- '/home/u/.courier/profile.json.lock'"));
  assert.ok(lockRefusal({ ...info, file: "/tmp/it's.lock" }, 'darwin').endsWith("rm -f -- '/tmp/it'\\''s.lock'"));
  const win = lockRefusal({ ...info, file: "C:\\Users\\o'brien\\.courier\\profile.json.lock" }, 'win32');
  assert.ok(win.endsWith("Remove-Item -LiteralPath 'C:\\Users\\o''brien\\.courier\\profile.json.lock' -Force"), win);
  assert.ok(!win.includes('rm -f'));
  assert.match(win, /only after confirming no Courier command is running/);
});

test('a hostile host name in a lock record cannot break the one-line refusal', () => {
  const host = 'evil\nrm -rf ~\u001b[31m';
  const message = lockRefusal({ file: '/x/p.lock', reason: 'unknown', pid: 7, host, record: JSON.stringify({ pid: 7, host }) }, 'linux');
  assert.equal(/[\u0000-\u001f\u007f]/.test(message), false, 'no control characters');
  assert.ok(message.includes('evil'));
});

// ---- pid namespace: on Linux a pid means something only inside one pid namespace ----

const linux = { skip: process.platform !== 'linux' && 'Linux pid namespaces' };

test('linux: a record without a pid namespace is not judged by its pid, even if the pid is gone here', linux, async () => {
  const content = record({ pid: await gone(), machine: 'M', boot: 'linux:b', pidns: undefined });
  const run = await take('nopidns', content, here('M', 'linux:b'));
  assert.equal(run.taken, false);
  assert.equal(run.kept, content);
  assert.match(run.message, /cannot tell/);
});

test('linux: when this process cannot read its own pid namespace nothing is judged by pid', linux, async (t) => {
  const content = record({ pid: await gone(), machine: 'M', boot: 'linux:b' });
  const file = lock('nocurrentns');
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  const readlink = fs.readlinkSync;
  t.mock.method(fs, 'readlinkSync', (f, ...rest) => { if (String(f) === '/proc/self/ns/pid') throw Object.assign(new Error('no'), { code: 'ENOENT' }); return readlink(f, ...rest); });
  assert.throws(() => acquireLock(file, { identity: here('M', 'linux:b') }), (e) => e.code === 'locked');
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, 'utf8'), content, 'the lock is untouched');
  fs.rmSync(file);
});

test('linux: a reboot is still proven without a pid namespace (the true boot id changed on the same host)', linux, async () => {
  const run = await take('nopidns-reboot', record({ pid: process.pid, machine: 'M', boot: 'linux:old', pidns: undefined }), here('M', 'linux:new'));
  assert.equal(run.taken, true);
});

// ---- PowerShell quoting ----

/** Reads the single-quoted PowerShell literal after `-LiteralPath`, as PowerShell does: any of its single-quote characters (' and U+2018 to U+201B) ends the string unless doubled. */
function powershellLiteral(command) {
  const quotes = /['\u2018-\u201B]/;
  const start = command.indexOf("-LiteralPath '") + "-LiteralPath ".length;
  let out = '';
  for (let i = start + 1; i < command.length; i += 1) {
    const c = command[i];
    if (quotes.test(c)) {
      if (command[i + 1] === c) { out += c; i += 1; continue; }
      assert.equal(command.slice(i + 1), ' -Force', `the literal ended early at index ${i}: ${command}`);
      return out;
    }
    out += c;
  }
  throw new Error(`unterminated literal: ${command}`);
}

test('windows recovery: every PowerShell single-quote character in the path is doubled, so the path stays one literal', () => {
  for (const file of ["C:\\Users\\o'brien\\p.lock", 'C:\\Users\\o\u2019brien\\p.lock', 'C:\\a\u2018b\u201Ac\u201Bd\u201Ce\\p.lock'.replace('\u201C', "'")]) {
    const line = lockRefusal({ file, reason: 'unknown', pid: 7, host: 'h' }, 'win32');
    const command = line.slice(line.indexOf('Remove-Item'));
    assert.equal(powershellLiteral(command), file);
  }
});
