import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deriveState } from '../dist/state.js';
import { loadProfile } from '../dist/profile.js';
import {
  Crash, crashAtWrite, homeFile, readHome, readySpace, scenario, signedGrant, stubSpaceProbe,
} from './support/approval-fixture.mjs';

// TC-2383: `init --rotate-key` replaces key.json, profile.json and grant.json as ONE journaled step.
//   1. rotation.json (0600, in the profile directory) is written atomically (temp file in the same directory, fsync, rename, directory fsync)
//      and holds the complete new key and new profile.
//   2. key.json is replaced.  3. profile.json is replaced (awaiting-grant).  4. grant.json is removed.
//   5. rotation.json is removed. That is the only deletion point.
// Rule at every crash point: before step 1's rename nothing has changed (roll back = do nothing); from step 1's rename on, every
// init mode rolls the rotation forward from the journal alone. No state in between is "ready without a grant".

const privatePart = (key) => key.jwk.d;

/** Die on the unlink of `file`, before it happens. */
function crashBeforeUnlink(t, file) {
  const original = fs.unlinkSync;
  fs.unlinkSync = (target, ...rest) => {
    if (path.basename(String(target)) === file) throw new Crash(`before removing ${file}`);
    return original(target, ...rest);
  };
  t.after(() => { fs.unlinkSync = original; });
  return { disarm: () => { fs.unlinkSync = original; } };
}

/** A ready profile with its grant, as left by a finished install. */
async function readyProfile({ t, request, courier }) {
  stubSpaceProbe(t, readySpace);
  await request();
  const grant = await signedGrant(readHome('key.json'));
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
  assert.equal((await courier('--grant-file', homeFile('legacy-grant.json'))).code, 0);
  fs.rmSync(homeFile('legacy-grant.json'));
  fs.rmSync(homeFile('approval-pending.json'), { force: true });
  assert.equal(loadProfile().status, 'ready');
  assert.equal(deriveState().state, 'ready');
}

const files = () => fs.readdirSync(path.dirname(homeFile('x'))).sort();
const noTemporaries = () => assert.deepEqual(files().filter((name) => name.endsWith('.tmp')), []);

const BOUNDARIES = [
  { name: 'after rotation.json is written', arm: (t) => crashAtWrite(t, 'rotation.json', { phase: 'after' }) },
  { name: 'after key.json is replaced', arm: (t) => crashAtWrite(t, 'key.json', { phase: 'after' }) },
  { name: 'after profile.json is replaced', arm: (t) => crashAtWrite(t, 'profile.json', { phase: 'after' }) },
  { name: 'after grant.json is removed', arm: (t) => crashBeforeUnlink(t, 'rotation.json') },
];

for (const boundary of BOUNDARIES) {
  scenario(`rotation ${boundary.name}: deriveState sees an interrupted rotation, with a 0600 journal holding the new key`, async (ctx) => {
    await readyProfile(ctx);
    const oldKey = readHome('key.json');
    const crash = boundary.arm(ctx.t);
    await assert.rejects(ctx.courier('--rotate-key', '--request'), (error) => error instanceof Crash);
    crash.disarm();
    const derived = deriveState();
    assert.equal(derived.state, 'rotation-interrupted');
    assert.equal(derived.action, 'finish-rotation');
    assert.equal(fs.statSync(homeFile('rotation.json')).mode & 0o777, 0o600);
    const journal = readHome('rotation.json');
    assert.equal(journal.v, 1);
    assert.notEqual(journal.key.did, oldKey.did);
    assert.equal(journal.profile.status, 'awaiting-grant');
    noTemporaries();
  });

  for (const mode of [['--request'], ['--wait', '--timeout', '1s'], ['--resume'], ['--rotate-key', '--request']]) {
    scenario(`rotation ${boundary.name}: \`init ${mode.join(' ')}\` rolls it forward to the journal's key and an empty grant slot`, async (ctx) => {
      await readyProfile(ctx);
      const crash = boundary.arm(ctx.t);
      await assert.rejects(ctx.courier('--rotate-key', '--request'), (error) => error instanceof Crash);
      crash.disarm();
      const newKey = readHome('rotation.json').key;
      await ctx.courier(...mode);
      assert.equal(fs.existsSync(homeFile('rotation.json')), false, 'the journal is gone once the rotation is finished');
      assert.equal(fs.existsSync(homeFile('grant.json')), false);
      const profile = loadProfile();
      assert.equal(profile.status, 'awaiting-grant');
      assert.deepEqual(profile.peers, {});
      if (mode[0] !== '--rotate-key') {
        assert.equal(readHome('key.json').did, newKey.did);
        assert.equal(profile.courierDid, newKey.did.replace(/#.*$/, ''));
      }
      assert.notEqual(deriveState().state, 'rotation-interrupted');
      assert.notEqual(deriveState().state, 'grant-missing');
      noTemporaries();
    });
  }
}

// A process killed before the rename leaves `rotation.json.<pid>.<hex>.tmp` (0600, in the profile directory) holding the new key. The
// in-process Crash used by the other tests unwinds through `finally`, so the file a real kill leaves is planted by hand.
const STRAY = 'rotation.json.4242.0a1b2c3d4e5f.tmp';
for (const mode of [['--request'], ['--wait', '--timeout', '1s'], ['--resume'], ['--rotate-key', '--request']]) {
  scenario(`rotation killed before rotation.json is renamed: the old state stands and \`init ${mode.join(' ')}\` removes the stray temp file holding the new key`, async (ctx) => {
    await readyProfile(ctx);
    const keyBefore = fs.readFileSync(homeFile('key.json'));
    const grantBefore = fs.readFileSync(homeFile('grant.json'));
    const crash = crashAtWrite(ctx.t, 'rotation.json', { phase: 'before' });
    await assert.rejects(ctx.courier('--rotate-key', '--request'), (error) => error instanceof Crash);
    crash.disarm();
    fs.writeFileSync(homeFile(STRAY), JSON.stringify({ v: 1, key: { v: 1, jwk: { d: 'new-private-part' }, did: 'did:key:z6Mn', createdAt: 'now' }, profile: {} }), { mode: 0o600 });
    const derived = deriveState();
    assert.equal(derived.state, 'ready', 'roll back: the old state stands');
    assert.equal(derived.cleanTemp, true);
    assert.equal(fs.existsSync(homeFile('rotation.json')), false);
    assert.deepEqual(fs.readFileSync(homeFile('key.json')), keyBefore);
    await ctx.courier(...mode);
    assert.equal(fs.existsSync(homeFile(STRAY)), false, 'the stray temp file is removed by the next init');
    noTemporaries();
    assert.equal(deriveState().cleanTemp, false);
    if (mode[0] !== '--rotate-key') assert.deepEqual(fs.readFileSync(homeFile('key.json')), keyBefore);
    if (mode[0] !== '--rotate-key') assert.deepEqual(fs.readFileSync(homeFile('grant.json')), grantBefore);
  });
}

scenario('a finished rotation leaves no journal, no temporary file and no copy of the old private key', async (ctx) => {
  await readyProfile(ctx);
  const oldKey = readHome('key.json');
  const run = await ctx.courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(fs.existsSync(homeFile('rotation.json')), false);
  noTemporaries();
  assert.notEqual(readHome('key.json').did, oldKey.did);
  for (const name of files()) assert.equal(fs.readFileSync(homeFile(name), 'utf8').includes(privatePart(oldKey)), false, `${name} still holds the old private key`);
  assert.equal(deriveState().state, 'approval-open');
});

// ---- a refused rotation leaves no journal ----

scenario('a refused rotation writes no journal and keeps the key', async (ctx) => {
  await readyProfile(ctx);
  const key = fs.readFileSync(homeFile('key.json'));
  const refusals = [
    ['--rotate-key', '--resume'],
    ['--rotate-key', '--wait', '--request'],
    ['--rotate-key', '--expiry', 'forever'],
    ['--rotate-key', '--timeout', '1s'],
  ];
  for (const argv of refusals) {
    const run = await ctx.courier(...argv);
    assert.notEqual(run.code, 0, argv.join(' '));
    assert.equal(fs.existsSync(homeFile('rotation.json')), false, `${argv.join(' ')} left a journal`);
    assert.deepEqual(fs.readFileSync(homeFile('key.json')), key);
    noTemporaries();
  }
});

scenario('a rotation refused because the saved approval cannot be read writes no journal and keeps the key', async (ctx) => {
  await readyProfile(ctx);
  await ctx.request();
  fs.chmodSync(homeFile('approval-pending.json'), 0o644);
  const key = fs.readFileSync(homeFile('key.json'));
  for (const argv of [['--rotate-key', '--request'], ['--rotate-key', '--wait', '--timeout', '1s']]) {
    const run = await ctx.courier(...argv);
    assert.notEqual(run.code, 0, argv.join(' '));
    assert.equal(fs.existsSync(homeFile('rotation.json')), false);
    assert.deepEqual(fs.readFileSync(homeFile('key.json')), key);
    noTemporaries();
  }
});

// ---- a held approval is bound to the old key: a validated rotation discards it as part of the same journaled step ----
// The journal records `discardApproval: true` when an approval the owner gave (held or committed) was on disk at validation; step 4 then
// removes approval-pending.json together with grant.json. Rotation before step 1 keeps the approval untouched.

async function readyWithHeldApproval(ctx) {
  await readyProfile(ctx);
  const printed = await ctx.request();
  await ctx.fx.approve(printed.openkeyUrl);
  const crash = crashAtWrite(ctx.t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  const { cmdInit } = await import('../dist/commands.js');
  const { parseArgs } = await import('../dist/args.js');
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  assert.equal(deriveState().state, 'ready-approval');
}

scenario('rotation killed before rotation.json is renamed keeps a held approval untouched', async (ctx) => {
  await readyWithHeldApproval(ctx);
  const pending = fs.readFileSync(homeFile('approval-pending.json'));
  const crash = crashAtWrite(ctx.t, 'rotation.json', { phase: 'before' });
  await assert.rejects(ctx.courier('--rotate-key', '--request'), (error) => error instanceof Crash);
  crash.disarm();
  assert.deepEqual(fs.readFileSync(homeFile('approval-pending.json')), pending);
  assert.equal(deriveState().state, 'ready-approval');
});

for (const boundary of BOUNDARIES) {
  scenario(`rotation ${boundary.name} over a held approval: the next init finishes it and the held approval is discarded with a warning`, async (ctx) => {
    await readyWithHeldApproval(ctx);
    const held = readHome('approval-pending.json');
    const crash = boundary.arm(ctx.t);
    await assert.rejects(ctx.courier('--rotate-key', '--request'), (error) => error instanceof Crash);
    crash.disarm();
    assert.equal(readHome('rotation.json').discardApproval, true);
    assert.equal(deriveState().state, 'rotation-interrupted');
    const run = await ctx.courier('--request');
    assert.match(run.stderr, /discards that approval/);
    assert.equal(fs.existsSync(homeFile('rotation.json')), false);
    const now = readHome('approval-pending.json');
    assert.notEqual(now.requestId, held.requestId, 'the old request is gone; this one is new');
    assert.equal(now.resultEnvelope, undefined);
    noTemporaries();
  });
}

scenario('a rotation with no approval held writes discardApproval: false and never touches approval-pending.json', async (ctx) => {
  await readyProfile(ctx);
  const crash = crashAtWrite(ctx.t, 'rotation.json', { phase: 'after' });
  await assert.rejects(ctx.courier('--rotate-key', '--request'), (error) => error instanceof Crash);
  crash.disarm();
  assert.equal(readHome('rotation.json').discardApproval, false);
});
