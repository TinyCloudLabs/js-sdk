import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPeers, resolvePeersOwner, tierOf } from '../dist/intake/peers.js';
import { cmdIntake, reloadPeers } from '../dist/intake/intake.js';
import { cmdOutbox } from '../dist/outbox.js';
import { parseArgs } from '../dist/args.js';

const UID = process.getuid();
const GID = process.getgid();
const NAME = 'tc712-owner';

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc712-owner-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function passwdWith(lines) {
  const s = scratch();
  const file = path.join(s.dir, 'passwd');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return { file, cleanup: s.cleanup };
}

function ownPasswd(extra = []) {
  return passwdWith([`${NAME}:x:${UID}:${GID}:::`, ...extra]);
}

function peersFile(body = { alice: { tier: 'trusted' } }, mode = 0o600) {
  const s = scratch();
  const file = path.join(s.dir, 'peers.json');
  fs.writeFileSync(file, JSON.stringify(body), { mode });
  fs.chmodSync(file, mode);
  return { file, dir: s.dir, cleanup: s.cleanup };
}

const usage = (error) => error.code === 'usage';
const insecure = (error) => error.code === 'insecure-peers';

test('no flag and no env resolves to the running user', () => {
  assert.equal(resolvePeersOwner(undefined, undefined), UID);
});

test('a numeric value is the uid, including 0 and the running user', () => {
  assert.equal(resolvePeersOwner('0', undefined), 0);
  assert.equal(resolvePeersOwner(String(UID), undefined), UID);
});

test('a user name resolves through the passwd file', () => {
  const p = ownPasswd(['root:x:0:0:root:/root:/bin/sh']);
  try {
    assert.equal(resolvePeersOwner('root', undefined, p.file), 0);
    assert.equal(resolvePeersOwner(NAME, undefined, p.file), UID);
  } finally {
    p.cleanup();
  }
});

test('the flag beats the env, and the env is used when the flag is absent', () => {
  const p = ownPasswd();
  try {
    assert.equal(resolvePeersOwner(NAME, '0', p.file), UID);
    assert.equal(resolvePeersOwner(undefined, NAME, p.file), UID);
  } finally {
    p.cleanup();
  }
});

test('an unknown name, a non-integer or out-of-range uid, and an empty or bare value refuse with usage', () => {
  const p = ownPasswd();
  try {
    for (const value of ['no-such-user', '-1', '1.5', '007', '4294967295', 'a b', '', 'true']) {
      assert.throws(() => resolvePeersOwner(value, undefined, p.file), usage, JSON.stringify(value));
    }
    assert.throws(() => resolvePeersOwner(undefined, '', p.file), usage);
    assert.throws(() => resolvePeersOwner(undefined, 'true', p.file), usage);
  } finally {
    p.cleanup();
  }
});

test('a name with two different uids in passwd is ambiguous and refuses', () => {
  const p = passwdWith(['dup:x:1:1:::', 'dup:x:2:2:::']);
  try {
    assert.throws(() => resolvePeersOwner('dup', undefined, p.file), usage);
  } finally {
    p.cleanup();
  }
});

test('a malformed passwd line refuses instead of being skipped', () => {
  const p = passwdWith([`${NAME}:x:${UID}:${GID}:::`, 'broken-line-without-fields']);
  try {
    assert.throws(() => resolvePeersOwner(NAME, undefined, p.file), usage);
  } finally {
    p.cleanup();
  }
});

test('a passwd line with six or eight fields refuses instead of being skipped', () => {
  for (const line of ['six:x:1:1::', 'eight:x:1:1:::/bin/sh:extra']) {
    const p = passwdWith([line]);
    try {
      assert.throws(() => resolvePeersOwner(line.split(':')[0], undefined, p.file), usage, line);
    } finally {
      p.cleanup();
    }
  }
});

test('a passwd uid above the uid range refuses, and the highest in-range uid resolves', () => {
  const big = passwdWith(['big:x:4294967295:1:::']);
  const top = passwdWith(['top:x:4294967294:1:::']);
  try {
    assert.throws(() => resolvePeersOwner('big', undefined, big.file), usage);
    assert.equal(resolvePeersOwner('top', undefined, top.file), 4294967294);
  } finally {
    big.cleanup();
    top.cleanup();
  }
});

test('NIS include markers in passwd are ignored', () => {
  const p = passwdWith(['+::::::', `${NAME}:x:${UID}:${GID}:::`]);
  try {
    assert.equal(resolvePeersOwner(NAME, undefined, p.file), UID);
  } finally {
    p.cleanup();
  }
});

test('a missing passwd database refuses a name with usage', () => {
  assert.throws(() => resolvePeersOwner('root', undefined, '/nonexistent/passwd/file'), usage);
});

test('without a POSIX uid and no flag, the owner is unsupported rather than unchecked', () => {
  const getuid = mock.method(process, 'getuid', () => undefined);
  try {
    assert.throws(() => resolvePeersOwner(undefined, undefined), (error) => error.code === 'unsupported');
  } finally {
    getuid.mock.restore();
  }
});

test('the default owner is the running user: a file owned by another uid is refused', () => {
  const p = peersFile();
  try {
    assert.equal(tierOf(loadPeers(p.file, resolvePeersOwner(undefined, undefined)), 'alice'), 'trusted');
    assert.throws(() => loadPeers(p.file, UID + 1), insecure);
  } finally {
    p.cleanup();
  }
});

test('a uid of 0 is enforced when the file belongs to another uid', () => {
  const p = peersFile();
  try {
    assert.equal(tierOf(loadPeers(p.file, UID), 'alice'), 'trusted');
    assert.throws(() => loadPeers(p.file, UID === 0 ? 1 : 0), insecure);
  } finally {
    p.cleanup();
  }
});

test('the flag names the owner: a file owned by the named uid is accepted', () => {
  const p = peersFile();
  const passwd = ownPasswd();
  try {
    const owner = resolvePeersOwner(NAME, undefined, passwd.file);
    assert.equal(tierOf(loadPeers(p.file, owner), 'alice'), 'trusted');
  } finally {
    p.cleanup();
    passwd.cleanup();
  }
});

test('the flag refuses a file whose owner is a different uid', () => {
  const p = peersFile();
  try {
    assert.throws(() => loadPeers(p.file, resolvePeersOwner(String(UID + 1))), insecure);
  } finally {
    p.cleanup();
  }
});

test('a flag naming root trusts nothing else: a file owned by the running user is refused when that user is not root', { skip: UID === 0 }, () => {
  const p = peersFile();
  const passwd = passwdWith(['root:x:0:0:::']);
  try {
    assert.throws(() => loadPeers(p.file, resolvePeersOwner('root', undefined, passwd.file)), insecure);
  } finally {
    p.cleanup();
    passwd.cleanup();
  }
});

test('a group- or other-writable file is still refused with the flag set', () => {
  for (const mode of [0o620, 0o602]) {
    const p = peersFile({ alice: { tier: 'trusted' } }, mode);
    try {
      assert.throws(() => loadPeers(p.file, resolvePeersOwner(String(UID))), insecure, mode.toString(8));
    } finally {
      p.cleanup();
    }
  }
});

test('a symlink is still refused with the flag set', () => {
  const p = peersFile();
  try {
    const link = path.join(p.dir, 'link.json');
    fs.symlinkSync(p.file, link);
    assert.throws(() => loadPeers(link, resolvePeersOwner(String(UID))), insecure);
  } finally {
    p.cleanup();
  }
});

test('intake refuses a peers file that the startup owner check rejects, before any profile is loaded', async () => {
  const s = scratch();
  const peers = peersFile();
  const home = process.env.COURIER_HOME;
  process.env.COURIER_HOME = s.dir;
  try {
    await assert.rejects(
      cmdIntake(parseArgs([
        '--queue-dir', path.join(s.dir, 'queue'),
        '--done-dir', path.join(s.dir, 'done'),
        '--overflow-dir', path.join(s.dir, 'overflow'),
        '--state-dir', path.join(s.dir, 'state'),
        '--peers-file', peers.file,
        '--peers-owner', String(UID + 1),
        '--once',
      ])),
      insecure,
    );
  } finally {
    if (home === undefined) delete process.env.COURIER_HOME;
    else process.env.COURIER_HOME = home;
    peers.cleanup();
    s.cleanup();
  }
});

test('outbox serve refuses an unknown --peers-owner with usage before opening any socket', { timeout: 10000 }, async () => {
  const s = scratch();
  try {
    await assert.rejects(
      cmdOutbox(parseArgs([
        'serve',
        '--outbox-dir', path.join(s.dir, 'outbox'),
        '--pipe', path.join(s.dir, 'outbox.sock'),
        '--peers-owner', 'no-such-user-tc712',
        '--once',
      ])),
      { code: 'usage' },
    );
    assert.equal(fs.existsSync(path.join(s.dir, 'outbox.sock')), false);
  } finally {
    s.cleanup();
  }
});

test('reloadPeers returns the loaded map when the owner matches', () => {
  const s = peersFile();
  try {
    const events = [];
    const peers = reloadPeers(s.file, UID, {}, (event, fields) => events.push({ event, ...fields }));
    assert.equal(tierOf(peers, 'alice'), 'trusted');
    assert.deepEqual(events, []);
  } finally {
    s.cleanup();
  }
});

test('reloadPeers keeps the last good map and logs insecure-peers when the owner is refused', () => {
  const s = peersFile();
  try {
    const last = { carol: { tier: 'trusted' } };
    const events = [];
    const out = reloadPeers(s.file, UID + 1, last, (event, fields) => events.push({ event, ...fields }));
    assert.equal(out, last);
    assert.deepEqual(events, [{ event: 'intake-error', code: 'insecure-peers' }]);
  } finally {
    s.cleanup();
  }
});

test('intake refresh passes the peers owner to the reload and keeps the last good map on refusal', { timeout: 10000 }, async () => {
  const s = scratch();
  const peersPath = path.join(s.dir, 'peers.json');
  const home = process.env.COURIER_HOME;
  process.env.COURIER_HOME = s.dir;
  const seen = {};
  try {
    await cmdIntake(parseArgs([
      '--queue-dir', path.join(s.dir, 'queue'),
      '--done-dir', path.join(s.dir, 'done'),
      '--overflow-dir', path.join(s.dir, 'overflow'),
      '--state-dir', path.join(s.dir, 'state'),
      '--peers-file', peersPath,
      '--peers-owner', String(UID + 1),
      '--once',
    ]), {
      // The file is absent at startup. It appears before the first refresh, owned by the running user, so only an owner of UID + 1 can refuse it.
      loadProfile: () => {
        fs.writeFileSync(peersPath, JSON.stringify({ alice: { tier: 'trusted' } }), { mode: 0o600 });
        fs.chmodSync(peersPath, 0o600);
        return { peers: {} };
      },
      courierNode: async () => ({ kv: {} }),
      reloadPeers: (file, owner, last) => {
        seen.owner = owner;
        seen.last = last;
        seen.events = [];
        seen.out = reloadPeers(file, owner, last, (event, fields) => seen.events.push({ event, ...fields }));
        return seen.out;
      },
      intakeCycle: async () => 0,
    });
    assert.equal(seen.owner, UID + 1);
    assert.equal(seen.out, seen.last);
    assert.deepEqual(seen.events, [{ event: 'intake-error', code: 'insecure-peers' }]);
  } finally {
    if (home === undefined) delete process.env.COURIER_HOME;
    else process.env.COURIER_HOME = home;
    s.cleanup();
  }
});

test('the intake loop applies a changed peers file from the next iteration', { timeout: 10000 }, async () => {
  const s = scratch();
  const peersPath = path.join(s.dir, 'peers.json');
  fs.writeFileSync(peersPath, JSON.stringify({ alice: { tier: 'trusted' } }), { mode: 0o600 });
  fs.chmodSync(peersPath, 0o600);
  const home = process.env.COURIER_HOME;
  process.env.COURIER_HOME = s.dir;
  const tiers = [];
  const stop = new Error('stop after two iterations');
  let sleeps = 0;
  try {
    await assert.rejects(
      cmdIntake(parseArgs([
        '--queue-dir', path.join(s.dir, 'queue'),
        '--done-dir', path.join(s.dir, 'done'),
        '--overflow-dir', path.join(s.dir, 'overflow'),
        '--state-dir', path.join(s.dir, 'state'),
        '--peers-file', peersPath,
        '--peers-owner', String(UID),
      ]), {
        loadProfile: () => ({ peers: {} }),
        courierNode: async () => ({ kv: {} }),
        reloadPeers,
        intakeCycle: async (input) => {
          tiers.push(tierOf(input.peers, 'alice'));
          return 0;
        },
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 2) throw stop;
          // Lower alice from trusted to strict between iterations. The second cycle must see strict.
          fs.writeFileSync(peersPath, JSON.stringify({ alice: { tier: 'strict' } }), { mode: 0o600 });
          fs.chmodSync(peersPath, 0o600);
        },
      }),
      (error) => error === stop,
    );
    assert.deepEqual(tiers, ['trusted', 'strict']);
  } finally {
    if (home === undefined) delete process.env.COURIER_HOME;
    else process.env.COURIER_HOME = home;
    s.cleanup();
  }
});

test('COURIER_PEERS_OWNER alone sets the intake owner, and --peers-owner beats it', { timeout: 10000 }, async () => {
  const s = scratch();
  const peers = peersFile();
  const home = process.env.COURIER_HOME;
  const envOwner = process.env.COURIER_PEERS_OWNER;
  process.env.COURIER_HOME = s.dir;
  const stubs = {
    loadProfile: () => ({ peers: {} }),
    courierNode: async () => ({ kv: {} }),
    reloadPeers,
    intakeCycle: async () => 0,
    sleep: async () => {},
  };
  const run = (extra) => cmdIntake(parseArgs([
    '--queue-dir', path.join(s.dir, 'queue'),
    '--done-dir', path.join(s.dir, 'done'),
    '--overflow-dir', path.join(s.dir, 'overflow'),
    '--state-dir', path.join(s.dir, 'state'),
    '--peers-file', peers.file,
    ...extra,
    '--once',
  ]), stubs);
  try {
    process.env.COURIER_PEERS_OWNER = String(UID + 1);
    await assert.rejects(run([]), insecure);
    await run(['--peers-owner', String(UID)]);
  } finally {
    if (home === undefined) delete process.env.COURIER_HOME;
    else process.env.COURIER_HOME = home;
    if (envOwner === undefined) delete process.env.COURIER_PEERS_OWNER;
    else process.env.COURIER_PEERS_OWNER = envOwner;
    peers.cleanup();
    s.cleanup();
  }
});

test('COURIER_PEERS_OWNER alone sets the outbox serve owner, and --peers-owner beats it', { timeout: 20000 }, () => {
  const s = scratch();
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const env = { ...process.env, COURIER_HOME: s.dir, COURIER_PEERS_OWNER: 'no-such-user-tc712' };
  const serve = (extra) => spawnSync(process.execPath, [
    cli, 'outbox', 'serve',
    '--outbox-dir', path.join(s.dir, 'outbox'),
    '--pipe', path.join(s.dir, 'outbox.sock'),
    ...extra,
  ], { env, encoding: 'utf8', timeout: 3000 });
  try {
    // No flag: the env name is refused as usage before any socket opens.
    const refused = serve([]);
    assert.equal(refused.signal, null);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /no account named "no-such-user-tc712"/);
    // With the flag: the env name is ignored, so the owner resolves to the running user and the env name is never refused.
    const flagged = serve(['--peers-owner', String(UID)]);
    assert.doesNotMatch(flagged.stderr, /no account named/);
  } finally {
    s.cleanup();
  }
});
