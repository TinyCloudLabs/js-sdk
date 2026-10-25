// Real-node proof that `courier revoke` revokes the outbound grant on the node: the peer's next read is refused.
// Runs only when TC_REPLICATION_E2E_NODE_BIN points at a tinycloud node executable (CI: node-replication-e2e.yml).
import { assertIsolated, testHome } from './tc1916-home.mjs';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from '../dist/args.js';
import { cmdRevoke } from '../dist/commands.js';
import { k } from '../dist/keys.js';
import { courierNode, peerKv } from '../dist/node.js';
import { loadProfile } from '../dist/profile.js';

const nodeBinary = process.env.TC_REPLICATION_E2E_NODE_BIN;
const run = promisify(execFile);
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;

describe('courier revoke against a real node', { skip: !nodeBinary }, () => {
  let dir;
  let host;
  let child;

  before(async () => {
    assertIsolated();
    dir = fs.mkdtempSync(path.join(testHome, 'e2e-'));
    fs.chmodSync(dir, 0o700);
    const server = createServer();
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
    host = `http://127.0.0.1:${port}`;
    process.env.COURIER_FAKE_OPENKEY_HOST = host;
    child = spawn(nodeBinary, [], {
      cwd: dir,
      env: {
        ...process.env,
        TINYCLOUD_STORAGE__DATADIR: path.join(dir, 'data'),
        TINYCLOUD_PORT: String(port),
        TINYCLOUD_ADDRESS: '127.0.0.1',
        ROCKET_PORT: String(port),
        ROCKET_ADDRESS: '127.0.0.1',
        TINYCLOUD_KEYS__TYPE: 'Static',
        TINYCLOUD_KEYS__SECRET: randomBytes(48).toString('base64url'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`node not ready after 60s: ${output.slice(-1500)}`)), 60_000);
      const onData = (chunk) => {
        output += chunk.toString();
        if (output.includes('Rocket has launched')) { clearTimeout(timer); resolve(); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`node exited before readiness (${code}): ${output.slice(-1500)}`)); });
    });
  }, { timeout: 90_000 });

  after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the revoked peer reads before revoke and is refused with delegation-revoked after', async () => {
    const { createOwner, grantFromRequest } = await import('../scripts/fake-openkey.mjs');
    const courier = async (home, args) => JSON.parse((await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, COURIER_HOME: home }, timeout: 180_000,
    })).stdout);
    const write = (name, obj) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify(obj), { mode: 0o600 });
      return file;
    };
    const identity = async (handle) => {
      const home = path.join(dir, handle);
      const owner = await createOwner();
      const request = await courier(home, ['init', '--request', '--handle', handle, '--host', host, '--label', `${handle} courier`]);
      const grant = await grantFromRequest(owner, request);
      await courier(home, ['init', '--grant-file', write(`${handle}-grant.json`, grant)]);
      return home;
    };

    const alice = await identity('alice');
    const bob = await identity('bob');
    const artA = await courier(alice, ['pair', 'start', 'bob']);
    const artB = await courier(bob, ['pair', 'accept', '--file', write('a.json', artA)]);
    const artC = await courier(alice, ['pair', 'accept', '--file', write('b.json', artB)]);
    await courier(bob, ['pair', 'accept', '--file', write('c.json', artC)]);

    const sent = await courier(alice, ['send', 'bob', '--new', 'revoke e2e', '--intent', 'request', '--text', 'hello']);

    // Bob reads alice's mailbox with the delegation alice issued to him.
    process.env.COURIER_HOME = bob;
    const bobProfile = loadProfile(bob);
    const bobNode = await courierNode(bobProfile, bob);
    const aliceAtBob = bobProfile.peers.alice;
    const kv = await peerKv(bobNode, bobProfile, aliceAtBob);
    const key = k.msg(aliceAtBob.theirHandleForMe, sent.threadId, sent.messageId);
    const before = await kv.get(key);
    assert.equal(before.ok, true, JSON.stringify(before.ok ? undefined : before.error));

    const aliceProfile = loadProfile(alice);
    const grants = aliceProfile.peers.bob.outbound;
    assert.ok(grants.length >= 1);

    process.env.COURIER_HOME = alice;
    const lines = [];
    const log = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try {
      await cmdRevoke(parseArgs(['bob']));
    } finally {
      console.log = log;
    }
    assert.match(lines.join('\n'), new RegExp(`${grants.length} outbound grant\\(s\\) revoked`));
    assert.equal(loadProfile(alice).peers.bob, undefined);

    const after = await kv.get(key);
    assert.equal(after.ok, false, 'the revoked peer must be refused');
    const detail = JSON.stringify(after.error);
    assert.match(detail, /delegation-revoked/);
    assert.match(detail, /401/);

    // The node reports a repeated revoke of the same grant as plain success, so a re-run needs no special case.
    const aliceNode = await courierNode(loadProfile(alice), alice);
    const again = await aliceNode.revokeDelegation(grants[0].cid);
    assert.equal(again.ok, true, JSON.stringify(again.ok ? undefined : again.error));
  }, { timeout: 300_000 });
});
