import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { homeFile, scenario } from './support/approval-fixture.mjs';
import { recoverInterrupted } from '../dist/state.js';
import { saveKey } from '../dist/profile.js';
import { LOCAL, removalCommand, writeTempIdentity } from './support/lock-identity.mjs';

const NONCE = '0a1b2c3d4e5f';
const BODY = '{"v":1,"jwk":{"d":"identity-temp-secret"}}\n';
const HAS_LOCAL_IDENTITY = !!LOCAL.machine && (process.platform !== 'linux' || !!LOCAL.pidns);

function plantTemp(pid, identity = {}) {
  const name = `key.json.${pid}.${NONCE}.tmp`;
  fs.writeFileSync(homeFile(name), BODY, { mode: 0o600 });
  writeTempIdentity(homeFile(name), pid, NONCE, identity);
  return { name, identityFile: `${name}.identity` };
}

function mockPidProbe(t, pid, result = 'esrch') {
  const realKill = process.kill;
  let calls = 0;
  t.mock.method(process, 'kill', (target, signal) => {
    if (target !== pid || signal !== 0) return realKill.call(process, target, signal);
    calls += 1;
    if (result === 'alive') return true;
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  });
  return () => calls;
}

for (const [label, pid, identity] of [
  ['another host', 4_999_997, () => ({ host: `${LOCAL.host}-other` })],
  ...(process.platform === 'linux' && LOCAL.pidns !== undefined
    ? [['another Linux pid namespace', 4_999_998, () => ({ pidns: `${LOCAL.pidns}-other` })]]
    : []),
]) {
  scenario(`a temp record from ${label} is kept despite local ESRCH, with recovery guidance`, { skip: !HAS_LOCAL_IDENTITY }, async (ctx) => {
    await ctx.request();
    const keyBefore = fs.readFileSync(homeFile('key.json'));
    const { name, identityFile } = plantTemp(pid, identity());
    const identityBefore = fs.readFileSync(homeFile(identityFile));
    const probes = mockPidProbe(ctx.t, pid);
    ctx.errors.length = 0;

    recoverInterrupted();

    assert.equal(fs.existsSync(homeFile(name)), true, 'a foreign writer identity is not scrubbed');
    assert.deepEqual(fs.readFileSync(homeFile(name)), Buffer.from(BODY));
    assert.deepEqual(fs.readFileSync(homeFile('key.json')), keyBefore);
    assert.deepEqual(fs.readFileSync(homeFile(identityFile)), identityBefore);
    assert.equal(probes(), 0, 'identity mismatch is rejected before the local pid probe');
    assert.ok(ctx.errors.some((line) => line.includes(name) && /only after confirming/i.test(line)), ctx.errors.join('\n'));
  });
}

for (const [label, makeUnidentifiable] of [
  ['missing', (file) => fs.rmSync(file)],
  ['malformed', (file) => fs.writeFileSync(file, '{broken', { mode: 0o600 })],
  ['incomplete', (file, pid) => fs.writeFileSync(file, JSON.stringify({ pid, nonce: NONCE, host: LOCAL.host }), { mode: 0o600 })],
  ['nonce-mismatched', (file, pid) => fs.writeFileSync(file, JSON.stringify({ pid, nonce: 'ffffffffffff', ...LOCAL }), { mode: 0o600 })],
]) {
  scenario(`temp with ${label} identity sidecar is preserved with recovery guidance`, async (ctx) => {
    await ctx.request();
    const keyBefore = fs.readFileSync(homeFile('key.json'));
    const pid = 5_000_003;
    const { name, identityFile } = plantTemp(pid);
    const file = homeFile(identityFile);
    makeUnidentifiable(file, pid);
    const identityBefore = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
    const probes = mockPidProbe(ctx.t, pid);
    ctx.errors.length = 0;

    recoverInterrupted();

    assert.equal(fs.existsSync(homeFile(name)), true, 'uncertain identity must not scrub the temp');
    assert.deepEqual(fs.readFileSync(homeFile(name)), Buffer.from(BODY));
    assert.deepEqual(fs.readFileSync(homeFile('key.json')), keyBefore);
    assert.equal(probes(), 0, 'missing or mismatched identity never reaches a PID-only probe');
    if (identityBefore) assert.deepEqual(fs.readFileSync(file), identityBefore);
    else assert.equal(fs.existsSync(file), false, 'a missing sidecar remains missing');
    const warning = ctx.errors.find((line) => line.includes(name) && /only after confirming no Courier writer anywhere is active/i.test(line));
    assert.ok(warning, ctx.errors.join('\n'));
    assert.ok(warning.includes(removalCommand(homeFile(name))), warning);
  });
}

scenario('a key temp is not created if its identity sidecar cannot be persisted', async (ctx) => {
  await ctx.request();
  const keyBefore = fs.readFileSync(homeFile('key.json'));
  const realOpen = fs.openSync;
  ctx.t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).endsWith('.tmp.identity')) throw new Error('identity sidecar unavailable');
    return realOpen.call(fs, file, ...args);
  });

  assert.throws(() => saveKey({ v: 1, jwk: { d: 'must-not-reach-temp' }, did: 'did:key:z6Mk', createdAt: 'now' }), /identity sidecar unavailable/);

  const temps = fs.readdirSync(process.env.COURIER_HOME).filter((name) => /^(?:rotation|key|approval-pending)\.json\.\d+\.[0-9a-f]{12}\.tmp(?:\.identity)?$/.test(name));
  assert.deepEqual(temps, [], 'no unidentifiable temp or sidecar was left behind');
  assert.deepEqual(fs.readFileSync(homeFile('key.json')), keyBefore, 'the installed key is unchanged');
});
scenario('a key temp is not created if its identity sidecar cannot be flushed', async (ctx) => {
  await ctx.request();
  const keyBefore = fs.readFileSync(homeFile('key.json'));
  const realOpen = fs.openSync;
  let identityFd;
  ctx.t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = realOpen.call(fs, file, ...args);
    if (String(file).endsWith('.tmp.identity')) identityFd = fd;
    return fd;
  });
  const realFsync = fs.fsyncSync;
  ctx.t.mock.method(fs, 'fsyncSync', (fd) => {
    if (fd === identityFd) throw new Error('identity sidecar fsync failed');
    return realFsync.call(fs, fd);
  });

  assert.throws(() => saveKey({ v: 1, jwk: { d: 'must-not-reach-temp' }, did: 'did:key:z6Mk', createdAt: 'now' }), /identity sidecar fsync failed/);

  const temps = fs.readdirSync(process.env.COURIER_HOME).filter((name) => /^(?:rotation|key|approval-pending)\.json\.\d+\.[0-9a-f]{12}\.tmp(?:\.identity)?$/.test(name));
  assert.deepEqual(temps, [], 'identity fsync failure leaves no secret temp or sidecar');
  assert.deepEqual(fs.readFileSync(homeFile('key.json')), keyBefore, 'the installed key is unchanged');
});


scenario('a dead orphan identity sidecar is removed without touching key.json', async (ctx) => {
  await ctx.request();
  const keyBefore = fs.readFileSync(homeFile('key.json'));
  const pid = 5_000_004;
  const { name, identityFile } = plantTemp(pid);
  fs.unlinkSync(homeFile(name));
  const probes = mockPidProbe(ctx.t, pid);
  ctx.errors.length = 0;

  recoverInterrupted();

  assert.equal(probes(), 1);
  assert.equal(fs.existsSync(homeFile(identityFile)), false);
  assert.deepEqual(fs.readFileSync(homeFile('key.json')), keyBefore);
  assert.deepEqual(ctx.errors, []);
});

scenario('an orphan sidecar with unknown identity is preserved and reported', async (ctx) => {
  await ctx.request();
  const keyBefore = fs.readFileSync(homeFile('key.json'));
  const pid = 5_000_005;
  const { name, identityFile } = plantTemp(pid, { host: `${LOCAL.host}-other` });
  fs.unlinkSync(homeFile(name));
  const identityBefore = fs.readFileSync(homeFile(identityFile));
  const probes = mockPidProbe(ctx.t, pid);
  ctx.errors.length = 0;

  recoverInterrupted();

  assert.equal(probes(), 0);
  assert.deepEqual(fs.readFileSync(homeFile(identityFile)), identityBefore);
  assert.deepEqual(fs.readFileSync(homeFile('key.json')), keyBefore);
  const warning = ctx.errors.find((line) => line.includes(identityFile) && /only after confirming no Courier writer anywhere is active/i.test(line));
  assert.ok(warning, ctx.errors.join('\n'));
  assert.ok(warning.includes(removalCommand(homeFile(identityFile))), warning);
});

scenario('a temp record from this host and pid namespace is scrubbed after ESRCH', { skip: !HAS_LOCAL_IDENTITY }, async (ctx) => {
  await ctx.request();
  const { name, identityFile } = plantTemp(4_999_999);
  const probes = mockPidProbe(ctx.t, 4_999_999);

  recoverInterrupted();

  assert.equal(probes(), 1);
  assert.equal(fs.existsSync(homeFile(name)), false, 'same-identity ESRCH permits scrubbing');
  assert.equal(fs.existsSync(homeFile(identityFile)), false, 'scrubbing removes the temp identity sidecar');
});

const HAS_BOOT_ID = HAS_LOCAL_IDENTITY && !!LOCAL.boot;
scenario('a true boot-id change scrubs a temp even when its pid appears alive', { skip: !HAS_BOOT_ID }, async (ctx) => {
  await ctx.request();
  const [kind, oldId] = LOCAL.boot.split(':', 2);
  const previousBoot = `${kind}:${oldId[0] === '0' ? '1' : '0'}${oldId.slice(1)}`;
  const { name, identityFile } = plantTemp(5_000_001, { boot: previousBoot });
  const probes = mockPidProbe(ctx.t, 5_000_001, 'alive');

  recoverInterrupted();

  assert.equal(probes(), 0, 'a true boot-id change is sufficient without a pid probe');
  assert.equal(fs.existsSync(homeFile(name)), false, 'the previous-boot temp is scrubbed');
  assert.equal(fs.existsSync(homeFile(identityFile)), false, 'scrubbing removes the temp identity sidecar');
});
scenario('a malformed boot ID does not scrub a live key temp', { skip: !HAS_BOOT_ID }, async (ctx) => {
  await ctx.request();
  const keyBefore = fs.readFileSync(homeFile('key.json'));
  const [kind] = LOCAL.boot.split(':', 1);
  const { name, identityFile } = plantTemp(process.pid, { boot: `${kind}:corrupt` });
  const tempBefore = fs.readFileSync(homeFile(name));
  const identityBefore = fs.readFileSync(homeFile(identityFile));
  ctx.errors.length = 0;

  recoverInterrupted();

  assert.deepEqual(fs.readFileSync(homeFile(name)), tempBefore, 'an invalid boot ID cannot zero or remove a live writer temp');
  assert.deepEqual(fs.readFileSync(homeFile(identityFile)), identityBefore);
  assert.deepEqual(fs.readFileSync(homeFile('key.json')), keyBefore);
  const warning = ctx.errors.find((line) => line.includes(name) && /only after confirming no Courier writer anywhere is active/i.test(line));
  assert.ok(warning, ctx.errors.join('\n'));
  assert.ok(warning.includes(removalCommand(homeFile(name))), warning);
});

scenario('a saved key stays successful and durable when removing its sidecar fails', (ctx) => {
  const home = process.env.COURIER_HOME;
  const directoryFds = new Set();
  let directorySyncs = 0;
  const realOpen = fs.openSync;
  ctx.t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = realOpen.call(fs, file, ...args);
    if (typeof file === 'string' && path.resolve(file) === path.resolve(home)) directoryFds.add(fd);
    return fd;
  });
  const realFsync = fs.fsyncSync;
  ctx.t.mock.method(fs, 'fsyncSync', (fd) => {
    if (directoryFds.has(fd)) directorySyncs += 1;
    return realFsync.call(fs, fd);
  });
  const realUnlink = fs.unlinkSync;
  ctx.t.mock.method(fs, 'unlinkSync', (file) => {
    if (String(file).endsWith('.tmp.identity')) {
      assert.ok(directorySyncs >= 2, 'the installed key rename is directory-fsynced before sidecar cleanup');
      throw Object.assign(new Error('sidecar removal unavailable'), { code: 'EACCES' });
    }
    return realUnlink.call(fs, file);
  });

  assert.doesNotThrow(() => saveKey({ v: 1, jwk: { d: 'durable-key' }, did: 'did:key:z6Mk', createdAt: 'now' }));

  assert.equal(JSON.parse(fs.readFileSync(homeFile('key.json'), 'utf8')).jwk.d, 'durable-key');
  assert.equal(fs.readdirSync(home).filter((name) => name.endsWith('.tmp.identity')).length, 1, 'failed sidecar cleanup leaves a recoverable orphan');
});

scenario('writeSecure tracks key temps for normalized and relative COURIER_HOME paths', (ctx) => {
  const home = process.env.COURIER_HOME;
  const realRename = fs.renameSync;
  let identitySeenBeforeRename = 0;
  ctx.t.mock.method(fs, 'renameSync', (temp, target) => {
    if (path.resolve(target) === path.resolve(homeFile('key.json'))) {
      const identityFile = `${temp}.identity`;
      assert.ok(fs.existsSync(identityFile), 'the identity sidecar exists before the key temp is renamed');
      const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      assert.equal(identity.pid, process.pid);
      identitySeenBeforeRename += 1;
    }
    return realRename.call(fs, temp, target);
  });

  for (const configuredHome of [`${home}${path.sep}`, path.relative(process.cwd(), home)]) {
    process.env.COURIER_HOME = configuredHome;
    saveKey({ v: 1, jwk: { d: `tracked-temp-${identitySeenBeforeRename}` }, did: 'did:key:z6Mk', createdAt: 'now' });
  }

  assert.equal(identitySeenBeforeRename, 2);
});
