// TC-2301: OpenKey consumes a short code on the first GET. Whatever Courier does after that redeem, a
// kill must not cost the owner a second approval. Every test talks to a local fake OpenKey code server
// that, like the real one, answers 404 to a code it has already handed out, and counts the requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from '@tinycloud/node-sdk';
import { grantFromInput, installGrant } from '../dist/grant.js';
import { loadGrant, loadProfile, saveKey, saveProfile } from '../dist/profile.js';
import { AGENT_GRANT, COURIER_SPACE } from '../dist/keys.js';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';

const HOST = 'https://tee.node.tinycloud.xyz';
const DAY = 86_400_000;
const CODE = 'ABCD-EFGH';
const OTHER_CODE = 'WXYZ-2345';
const wasm = new NodeWasmBindings();

function agentKey() {
  const manager = wasm.createSessionManager();
  const id = manager.createSessionKey('test');
  return { v: 1, jwk: JSON.parse(manager.jwk(id)), did: manager.getDID(id), createdAt: new Date().toISOString() };
}

async function signedGrant(agent, { lifetimeMs = 30 * DAY, issuedAt = new Date(), extra = [], omitLast = false } = {}) {
  const signer = new PrivateKeySigner(randomBytes(32).toString('hex'));
  const address = await signer.getAddress();
  const chainId = 1;
  const spaceId = wasm.makeSpaceId(address, chainId, COURIER_SPACE);
  const abilities = {};
  for (const permission of [...(omitLast ? AGENT_GRANT.slice(0, -1) : AGENT_GRANT), ...extra]) {
    const service = permission.service.replace(/^tinycloud\./, '');
    (abilities[service] ??= {})[permission.path] = [...((abilities[service] ?? {})[permission.path] ?? []), ...permission.actions];
  }
  const prepared = wasm.prepareSession({
    abilities, address, chainId, domain: 'courier.offline-test', issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + lifetimeMs).toISOString(), spaceId, jwk: agent.jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const { d: _private, ...publicJwk } = agent.jwk;
  return {
    delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, address, chainId,
    siwe: prepared.siwe, signature, verificationMethod: agent.did, jwk: publicJwk,
  };
}

function profileFor(agent, status = 'awaiting-grant') {
  return { version: 3, host: HOST, openkeyHost: 'https://openkey.so', label: 'offline-test', courierDid: agent.did.split('#')[0], status, peers: {} };
}

/** A COURIER_HOME with an agent key and an `awaiting-grant` profile, the state `courier init` leaves before the grant. */
function withHome(run) {
  const previous = process.env.COURIER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-save-first-'));
  process.env.COURIER_HOME = home;
  return Promise.resolve().then(() => run(home)).finally(() => {
    if (previous === undefined) delete process.env.COURIER_HOME;
    else process.env.COURIER_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

/** Fake OpenKey API: a code is handed out once, then it is gone (the real server's atomic consume). */
async function fakeOpenKey(codes) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const code = decodeURIComponent(req.url.split('/').pop());
    const delegation = codes.get(code);
    codes.delete(code);
    res.writeHead(delegation ? 200 : 404, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(delegation ? { delegation } : { error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Make the hosted-space probe answer from `probe`; installs and resumes call `node.kv.list`. */
function stubSpace(t, probe) {
  const descriptor = Object.getOwnPropertyDescriptor(TinyCloudNode.prototype, 'kv');
  Object.defineProperty(TinyCloudNode.prototype, 'kv', { configurable: true, get: () => ({ list: probe }) });
  t.after(() => Object.defineProperty(TinyCloudNode.prototype, 'kv', descriptor));
}
const ready = async () => ({ ok: true, data: { keys: [] } });
const missing = async () => ({ ok: false, error: { status: 404, message: 'Space not found' } });

/** Skip only the 2 s first wait of the space poll; every real network timer is untouched. */
function fastSpaceWait(t) {
  const real = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...rest) => real(callback, ms === 2000 ? 0 : ms, ...rest));
}

/** Run `courier init` in-process and return what it printed on stdout. */
async function init(t, argv) {
  const out = [];
  const write = process.stdout.write;
  // Only the command's own JSON is captured; the test runner's reporting must keep flowing.
  process.stdout.write = function (chunk, ...rest) {
    if (String(chunk).startsWith('{\n  "ok"')) { out.push(String(chunk)); return true; }
    return write.call(this, chunk, ...rest);
  };
  const stderr = t.mock.method(console, 'error', () => {});
  try {
    await cmdInit(parseArgs(argv));
  } finally {
    process.stdout.write = write;
    stderr.mock.restore();
  }
  return out.join('');
}

function codeFile(home, code = CODE) {
  const file = path.join(home, 'code.txt');
  fs.writeFileSync(file, `${code}\n`);
  return file;
}

const pendingFile = (home) => path.join(home, 'pending-grant.json');

/** The kill seams between the redeem and the final profile save, each simulated by throwing there once. */
const SEAMS = {
  'after the redeem, before anything is installed': { status: 'awaiting-grant' },
  'during restoreVerifiedGrant': {
    status: 'awaiting-grant',
    arm(t) {
      const restore = TinyCloudNode.prototype.restoreSession;
      let calls = 0;
      t.mock.method(TinyCloudNode.prototype, 'restoreSession', async function (...args) {
        if (calls++ === 0) throw new Error('killed during restore');
        return restore.apply(this, args);
      });
    },
    expect: /killed during restore/,
  },
  'after restoreVerifiedGrant, before saveGrant': {
    status: 'awaiting-grant',
    arm(t) {
      const capabilities = TinyCloudNode.prototype.getVerifiedSessionCapabilities;
      let calls = 0;
      t.mock.method(TinyCloudNode.prototype, 'getVerifiedSessionCapabilities', function (...args) {
        if (calls++ === 0) throw new Error('killed after restore');
        return capabilities.apply(this, args);
      });
    },
    expect: /killed after restore/,
  },
  'after saveGrant, before saveProfile': {
    status: 'awaiting-grant',
    arm(t, home) {
      const rename = fs.renameSync;
      let killed = false;
      t.mock.method(fs, 'renameSync', (from, to) => {
        if (!killed && path.basename(String(to)) === 'profile.json' && fs.existsSync(path.join(home, 'grant.json'))) {
          killed = true;
          throw new Error('killed before saveProfile');
        }
        return rename(from, to);
      });
    },
    expect: /killed before saveProfile/,
  },
};

async function redeemable(agent, extra = {}) {
  const delegation = { ...(await signedGrant(agent)), ...extra };
  return { delegation, api: await fakeOpenKey(new Map([[CODE.toLowerCase(), delegation]])) };
}

function assertInstalled(home, delegation, api) {
  assert.equal(api.hits.length, 1, `exactly one redeem request, saw ${JSON.stringify(api.hits)}`);
  const profile = loadProfile();
  assert.equal(profile.status, 'ready');
  assert.equal('spacePending' in profile, false);
  assert.equal(profile.spaceId, delegation.spaceId);
  assert.equal(profile.ownerDid, `did:pkh:eip155:1:${delegation.address}`);
  assert.equal(loadGrant().delegationCid, delegation.delegationCid);
  assert.equal(loadGrant().siwe, delegation.siwe);
  assert.equal(fs.existsSync(pendingFile(home)), false, 'the pending record is deleted once grant and profile are saved');
}

for (const [name, seam] of Object.entries(SEAMS)) {
  for (const recovery of ['the same code', '--resume']) {
    test(`a kill ${name} is recovered with ${recovery} and one redeem`, async (t) => withHome(async (home) => {
      const agent = agentKey();
      saveKey(agent);
      saveProfile(profileFor(agent, seam.status));
      stubSpace(t, ready);
      const { delegation, api } = await redeemable(agent);
      try {
        if (name.startsWith('after the redeem')) {
          // The process died right after the redeem: the caller never got to verify or install anything.
          await grantFromInput(CODE, agent, { apiHost: api.url });
        } else {
          seam.arm(t, home);
          await assert.rejects(init(t, ['--grant-file', codeFile(home), '--openkey-api-host', api.url]), seam.expect);
        }
        assert.equal(api.hits.length, 1);
        assert.notEqual(loadProfile().status, 'ready');

        const argv = recovery === '--resume' ? ['--resume'] : ['--grant-file', codeFile(home), '--openkey-api-host', api.url];
        const printed = JSON.parse(await init(t, argv));
        assert.equal(printed.ok, true);
        assert.equal(printed.spaceId, delegation.spaceId);
        assertInstalled(home, delegation, api);
      } finally {
        await api.close();
      }
    }));
  }
}

test('a kill during waitForSpaceReady is recovered with the same code and with --resume, one redeem each', async (t) => {
  for (const recovery of ['the same code', '--resume']) {
    await withHome(async (home) => {
      const agent = agentKey();
      saveKey(agent);
      saveProfile(profileFor(agent));
      fastSpaceWait(t);
      const { delegation, api } = await redeemable(agent, { spaceReady: null, spacePending: true });
      try {
        let probes = 0;
        stubSpace(t, async () => {
          if (++probes === 1) return missing();
          throw new Error('killed while waiting for the space');
        });
        await assert.rejects(init(t, ['--grant-file', codeFile(home), '--openkey-api-host', api.url]), /killed while waiting/);
        assert.equal(loadProfile().status, 'awaiting-space');
        assert.equal(loadProfile().spacePending, true);

        stubSpace(t, ready);
        const argv = recovery === '--resume' ? ['--resume'] : ['--grant-file', codeFile(home), '--openkey-api-host', api.url];
        assert.equal(JSON.parse(await init(t, argv)).ok, true);
        assertInstalled(home, delegation, api);
      } finally {
        await api.close();
      }
    });
  }
});

test('--resume finishes a profile left awaiting-grant beside a grant file on disk', async (t) => withHome(async (home) => {
  // The pending record is gone (older release, or deleted): the grant file alone is enough.
  const agent = agentKey();
  saveKey(agent);
  saveProfile(profileFor(agent));
  stubSpace(t, ready);
  const delegation = await signedGrant(agent);
  await installGrant(profileFor(agent), agent, delegation);
  saveProfile(profileFor(agent));
  assert.equal(loadProfile().status, 'awaiting-grant');
  const printed = JSON.parse(await init(t, ['--resume']));
  assert.equal(printed.ok, true);
  assert.equal(loadProfile().status, 'ready');
  assert.equal(loadProfile().spaceId, delegation.spaceId);
}));

test('--resume still refuses a profile with nothing to resume', async (t) => withHome(async () => {
  const agent = agentKey();
  saveKey(agent);
  saveProfile(profileFor(agent));
  await assert.rejects(init(t, ['--resume']), { code: 'usage', message: /requires a profile in awaiting-space state/ });
  saveProfile(profileFor(agent, 'ready'));
  await assert.rejects(init(t, ['--resume']), { code: 'usage', message: /requires a profile in awaiting-space state/ });
}));

test('the pending record is a 0600 file holding public fields only', async (t) => withHome(async (home) => {
  const agent = agentKey();
  saveKey(agent);
  const { delegation, api } = await redeemable(agent);
  try {
    await grantFromInput(CODE, agent, { apiHost: api.url });
    const stat = fs.statSync(pendingFile(home));
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(fs.statSync(home).mode & 0o077, 0, 'the profile directory stays owner-only');
    const text = fs.readFileSync(pendingFile(home), 'utf8');
    for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) {
      if (typeof agent.jwk[field] === 'string') assert.equal(text.includes(agent.jwk[field]), false, `private field ${field} leaked`);
    }
    assert.equal(/"(d|p|q|dp|dq|qi|oth|k)":/.test(text), false, 'no private JWK member names');
    assert.ok(text.includes(delegation.delegationCid), 'the delegation itself is stored');
    assert.deepEqual(fs.readdirSync(home).filter((name) => name.includes('tmp')), [], 'no temp file is left behind');
  } finally {
    await api.close();
  }
}));

test('a pending record for another key is refused, nothing is installed and the record is removed', async (t) => withHome(async (home) => {
  const agent = agentKey();
  const stranger = agentKey();
  saveKey(stranger);
  saveProfile(profileFor(stranger));
  stubSpace(t, ready);
  const { api } = await redeemable(agent);
  try {
    await grantFromInput(CODE, agent, { apiHost: api.url });
    assert.equal(fs.existsSync(pendingFile(home)), true);
    await assert.rejects(
      init(t, ['--grant-file', codeFile(home), '--openkey-api-host', api.url]),
      { code: 'bad-grant', message: /bound to a different Courier agent key/ },
    );
    assert.equal(api.hits.length, 1, 'a refused local record never triggers a second redeem');
    assert.equal(fs.existsSync(path.join(home, 'grant.json')), false);
    assert.equal(loadProfile().status, 'awaiting-grant');
    assert.equal(fs.existsSync(pendingFile(home)), false, 'a record bound to a key this profile does not hold is removed');
    await assert.rejects(init(t, ['--resume']), { code: 'usage' });
  } finally {
    await api.close();
  }
}));

test('a pending record whose delegation has expired is ignored and removed', async (t) => withHome(async (home) => {
  const agent = agentKey();
  saveKey(agent);
  const delegation = await signedGrant(agent, { lifetimeMs: 3_600_000 });
  const api = await fakeOpenKey(new Map([[CODE.toLowerCase(), delegation]]));
  try {
    await grantFromInput(CODE, agent, { apiHost: api.url });
    assert.equal(fs.existsSync(pendingFile(home)), true);
    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 2 * 3_600_000);
    // Not served from the stale local copy: the code is looked up again and OpenKey no longer has it.
    await assert.rejects(grantFromInput(CODE, agent, { apiHost: api.url }), { code: 'code-not-found' });
    assert.equal(api.hits.length, 2);
    assert.equal(fs.existsSync(pendingFile(home)), false);
  } finally {
    await api.close();
  }
}));

test('another code is not satisfied by a pending record, and does not disturb it', async (t) => withHome(async (home) => {
  const agent = agentKey();
  saveKey(agent);
  const first = await signedGrant(agent);
  const second = await signedGrant(agent);
  const api = await fakeOpenKey(new Map([[CODE.toLowerCase(), first], [OTHER_CODE.toLowerCase(), second]]));
  try {
    assert.equal((await grantFromInput(CODE, agent, { apiHost: api.url })).delegationCid, first.delegationCid);
    // A different code redeems for itself and gets its own delegation, not the pending one.
    assert.equal((await grantFromInput(OTHER_CODE, agent, { apiHost: api.url })).delegationCid, second.delegationCid);
    assert.equal(api.hits.length, 2);
    // Re-running either code is served locally: no further request.
    assert.equal((await grantFromInput(CODE, agent, { apiHost: api.url })).delegationCid, first.delegationCid);
    assert.equal((await grantFromInput(` ${OTHER_CODE.toLowerCase()}\n`, agent, { apiHost: api.url })).delegationCid, second.delegationCid);
    assert.equal(api.hits.length, 2);
    // A code that was never redeemed is still unknown, whatever is pending.
    await assert.rejects(grantFromInput('QQQQ-QQQQ', agent, { apiHost: api.url }), { code: 'code-not-found', message: /Delegation code not found or expired/ });
    assert.equal(api.hits.length, 3);
  } finally {
    await api.close();
  }
}));

test('a pending record in another Courier home is never used', async (t) => {
  const agent = agentKey();
  const delegation = await signedGrant(agent);
  const api = await fakeOpenKey(new Map([[CODE.toLowerCase(), delegation]]));
  try {
    await withHome(async () => { await grantFromInput(CODE, agent, { apiHost: api.url }); });
    await withHome(async () => {
      await assert.rejects(grantFromInput(CODE, agent, { apiHost: api.url }), { code: 'code-not-found' });
    });
    assert.equal(api.hits.length, 2);
  } finally {
    await api.close();
  }
});

test('an unknown code with nothing pending still says code-not-found', async () => withHome(async (home) => {
  const agent = agentKey();
  const api = await fakeOpenKey(new Map());
  try {
    await assert.rejects(grantFromInput(CODE, agent, { apiHost: api.url }), { code: 'code-not-found', message: /Delegation code not found or expired\. Paste the full grant code/ });
    assert.equal(fs.existsSync(pendingFile(home)), false);
  } finally {
    await api.close();
  }
}));

test('a delegation for another key is refused at redeem and nothing is stored', async () => withHome(async (home) => {
  const agent = agentKey();
  const stranger = agentKey();
  const api = await fakeOpenKey(new Map([[CODE.toLowerCase(), await signedGrant(stranger)]]));
  try {
    await assert.rejects(grantFromInput(CODE, agent, { apiHost: api.url }), { code: 'bad-grant' });
    assert.equal(fs.existsSync(pendingFile(home)), false);
  } finally {
    await api.close();
  }
}));

test('a saved delegation that can never install is dropped: the same code and --resume do not replay it, a fresh code works', async (t) => withHome(async (home) => {
  const agent = agentKey();
  saveKey(agent);
  saveProfile(profileFor(agent));
  stubSpace(t, ready);
  const good = await signedGrant(agent);
  // OpenKey approved a grant for a space that is not the agents space: installGrant refuses it for good.
  const poisoned = { ...(await signedGrant(agent)), spaceId: good.spaceId.replace(/:agents$/, ':applications') };
  const api = await fakeOpenKey(new Map([[CODE.toLowerCase(), poisoned], [OTHER_CODE.toLowerCase(), good]]));
  try {
    await assert.rejects(init(t, ['--grant-file', codeFile(home), '--openkey-api-host', api.url]), { code: 'bad-grant' });
    assert.equal(fs.existsSync(pendingFile(home)), false, 'a permanently refused record is not kept');
    assert.equal(fs.existsSync(path.join(home, 'grant.json')), false);
    await assert.rejects(init(t, ['--resume']), { code: 'usage' });
    // The same code now reaches OpenKey again (it was consumed): the plain "approve again" answer, not a replayed refusal.
    await assert.rejects(init(t, ['--grant-file', codeFile(home), '--openkey-api-host', api.url]), { code: 'code-not-found' });
    assert.equal(JSON.parse(await init(t, ['--grant-file', codeFile(home, OTHER_CODE), '--openkey-api-host', api.url])).ok, true);
    assert.equal(loadProfile().status, 'ready');
    assert.equal(fs.existsSync(pendingFile(home)), false, 'no poisoned record is left behind');
  } finally {
    await api.close();
  }
}));

test('a transient failure keeps the record: a missing space is finished by --resume with no second redeem', async (t) => withHome(async (home) => {
  const agent = agentKey();
  saveKey(agent);
  saveProfile(profileFor(agent));
  const { delegation, api } = await redeemable(agent);
  try {
    stubSpace(t, missing);
    await assert.rejects(init(t, ['--grant-file', codeFile(home), '--openkey-api-host', api.url]), { code: 'no-space' });
    assert.equal(fs.existsSync(pendingFile(home)), true);
    stubSpace(t, ready);
    assert.equal(JSON.parse(await init(t, ['--resume'])).ok, true);
    assertInstalled(home, delegation, api);
  } finally {
    await api.close();
  }
}));

test('a pending record with a loose mode is repaired to 0600 and used, never deleted', async () => withHome(async (home) => {
  const agent = agentKey();
  saveKey(agent);
  const { delegation, api } = await redeemable(agent);
  try {
    await grantFromInput(CODE, agent, { apiHost: api.url });
    fs.chmodSync(pendingFile(home), 0o644);
    assert.equal((await grantFromInput(CODE, agent, { apiHost: api.url })).delegationCid, delegation.delegationCid);
    assert.equal(api.hits.length, 1, 'the consumed code is served from the only copy');
    assert.equal(fs.statSync(pendingFile(home)).mode & 0o777, 0o600);
  } finally {
    await api.close();
  }
}));

test('a pending path that is not a regular file is not trusted and not deleted', async () => withHome(async (home) => {
  const agent = agentKey();
  saveKey(agent);
  const { api } = await redeemable(agent);
  try {
    await grantFromInput(CODE, agent, { apiHost: api.url });
    const real = path.join(home, 'elsewhere.json');
    fs.renameSync(pendingFile(home), real);
    fs.symlinkSync(real, pendingFile(home));
    await assert.rejects(grantFromInput(CODE, agent, { apiHost: api.url }), { code: 'code-not-found' });
    assert.equal(api.hits.length, 2, 'a symlinked record is not read');
    assert.equal(fs.existsSync(real), true, 'the target is left alone');
  } finally {
    await api.close();
  }
}));

test('a grant that looks issued in the future (local clock behind) keeps its record; the same code finishes once the clock is right', async (t) => withHome(async (home) => {
  const agent = agentKey();
  saveKey(agent);
  saveProfile(profileFor(agent));
  stubSpace(t, ready);
  const delegation = await signedGrant(agent, { issuedAt: new Date(Date.now() + 10 * 60_000) });
  const api = await fakeOpenKey(new Map([[CODE.toLowerCase(), delegation]]));
  try {
    await assert.rejects(init(t, ['--grant-file', codeFile(home), '--openkey-api-host', api.url]), { code: 'bad-grant', message: /issued in the future/ });
    assert.equal(fs.existsSync(pendingFile(home)), true, 'a clock problem must not destroy the only copy of a consumed code');
    assert.equal(fs.existsSync(path.join(home, 'grant.json')), false);
    // The clock is fixed (10 minutes later): the same code completes from the local copy.
    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 10 * 60_000);
    assert.equal(JSON.parse(await init(t, ['--grant-file', codeFile(home), '--openkey-api-host', api.url])).ok, true);
    assertInstalled(home, delegation, api);
  } finally {
    await api.close();
  }
}));

test('a grant whose expiry is past by more than the skew is useless: its record is dropped', async (t) => withHome(async (home) => {
  const agent = agentKey();
  saveKey(agent);
  const profile = profileFor(agent);
  stubSpace(t, ready);
  const delegation = await signedGrant(agent, { lifetimeMs: 3_600_000 });
  const api = await fakeOpenKey(new Map([[CODE.toLowerCase(), delegation]]));
  try {
    const payload = await grantFromInput(CODE, agent, { apiHost: api.url });
    assert.equal(fs.existsSync(pendingFile(home)), true);
    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 2 * 3_600_000);
    await assert.rejects(installGrant(profile, agent, payload), { code: 'bad-grant' });
    assert.equal(fs.existsSync(pendingFile(home)), false);
  } finally {
    await api.close();
  }
}));


for (const [label, options, code] of [
  ['carries more authority than Courier allows', { extra: [{ service: 'tinycloud.space', space: 'agents', path: '', actions: ['tinycloud.space/host'] }] }, 'grant-too-broad'],
  ['is missing authority Courier needs', { omitLast: true }, 'grant-incomplete'],
]) {
  test(`a saved delegation that ${label} is dropped (${code}) and not replayed`, async (t) => withHome(async (home) => {
    const agent = agentKey();
    saveKey(agent);
    saveProfile(profileFor(agent));
    stubSpace(t, ready);
    const api = await fakeOpenKey(new Map([[CODE.toLowerCase(), await signedGrant(agent, options)]]));
    try {
      await assert.rejects(init(t, ['--grant-file', codeFile(home), '--openkey-api-host', api.url]), { code });
      assert.equal(fs.existsSync(pendingFile(home)), false);
      await assert.rejects(init(t, ['--grant-file', codeFile(home), '--openkey-api-host', api.url]), { code: 'code-not-found' });
      assert.equal(api.hits.length, 2);
    } finally {
      await api.close();
    }
  }));
}

test('a failing cleanup after a refused install does not replace the refusal', async (t) => withHome(async (home) => {
  const agent = agentKey();
  saveKey(agent);
  const profile = profileFor(agent);
  stubSpace(t, ready);
  const api = await fakeOpenKey(new Map([[CODE.toLowerCase(), await signedGrant(agent, { omitLast: true })]]));
  try {
    const payload = await grantFromInput(CODE, agent, { apiHost: api.url });
    // Make the rewrite of the record fail: the profile directory is read-only for the cleanup.
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (path.basename(String(to)) === 'pending-grant.json') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return rename(from, to);
    });
    t.mock.method(console, 'error', () => {});
    await assert.rejects(installGrant(profile, agent, payload), { code: 'grant-incomplete' });
  } finally {
    await api.close();
  }
}));

test('a symlink standing in for the pending record is left in place', async () => withHome(async (home) => {
  const agent = agentKey();
  saveKey(agent);
  const { api } = await redeemable(agent);
  try {
    await grantFromInput(CODE, agent, { apiHost: api.url });
    const real = path.join(home, 'elsewhere.json');
    fs.renameSync(pendingFile(home), real);
    fs.symlinkSync(real, pendingFile(home));
    await assert.rejects(grantFromInput(CODE, agent, { apiHost: api.url }), { code: 'code-not-found' });
    assert.equal(fs.lstatSync(pendingFile(home)).isSymbolicLink(), true, 'the symlink itself is not deleted');
  } finally {
    await api.close();
  }
}));
