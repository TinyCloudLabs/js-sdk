import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { loadProfile } from '../dist/profile.js';
import { Crash, crashAtWrite, fakeTime, homeFile, readHome, readySpace, scenario, signedGrant, stubSpaceProbe } from './support/approval-fixture.mjs';

// Last round: nothing may change (key, grant, profile) before a writer learns the saved approval is unreadable.

async function heldApproval({ t, fx, request }) {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  const crash = crashAtWrite(t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  return printed;
}

const snapshot = () => Object.fromEntries(fs.readdirSync(process.env.COURIER_HOME).sort().map((name) => [name, fs.statSync(homeFile(name)).isFile() ? fs.readFileSync(homeFile(name), 'utf8') : 'dir']));

for (const command of [['--request'], ['--wait']]) {
  scenario(`--rotate-key ${command[0]} over an unreadable approval stops before rotating anything`, async (ctx) => {
    const { t, courier } = ctx;
    const printed = await heldApproval(ctx);
    // A renewal with an installed grant, so there is a grant.json and a ready profile to lose.
    const grant = await signedGrant(readHome('key.json'));
    fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
    const pendingBytes = fs.readFileSync(homeFile('approval-pending.json'));
    fs.rmSync(homeFile('approval-pending.json'));
    assert.equal((await courier('--grant-file', homeFile('legacy-grant.json'))).code, 0);
    fs.writeFileSync(homeFile('approval-pending.json'), pendingBytes, { mode: 0o600 });
    fs.chmodSync(homeFile('approval-pending.json'), 0o644);
    fakeTime(t);
    const before = snapshot();
    const run = await courier('--rotate-key', ...command);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /\[approval-unreadable\]/);
    assert.match(run.stderr, /chmod 600/);
    assert.deepEqual(snapshot(), before, 'key, grant, profile and the record are untouched');
    assert.equal(loadProfile().status, 'ready');
    void printed;
  });
}

scenario('--wait on a ready profile with an unreadable held renewal says approval-unreadable, not "no approval pending"', async (ctx) => {
  const { t, fx, request, courier } = ctx;
  stubSpaceProbe(t, readySpace);
  const first = await request();
  await fx.approve(first.openkeyUrl);
  assert.equal((await courier('--wait')).code, 0);
  const renewal = await request();
  await fx.approve(renewal.openkeyUrl);
  fs.chmodSync(homeFile('approval-pending.json'), 0o644);
  const run = await courier('--wait');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-unreadable\]/);
  assert.doesNotMatch(run.stderr, /no approval request is pending/);
});

scenario('a record written by a newer Courier (numeric version above 1) is not renamed aside: the command stops', async ({ request, courier }) => {
  await request();
  const saved = readHome('approval-pending.json');
  fs.writeFileSync(homeFile('approval-pending.json'), JSON.stringify({ ...saved, version: 2 }), { mode: 0o600 });
  const before = fs.readFileSync(homeFile('approval-pending.json'));
  const run = await courier('--request');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[approval-unreadable\]/);
  assert.match(run.stderr, /newer/);
  assert.deepEqual(fs.readFileSync(homeFile('approval-pending.json')), before);
  assert.deepEqual(fs.readdirSync(process.env.COURIER_HOME).filter((n) => n.includes('corrupt')), []);
});

scenario('legacy import notes: a committed record says its ack is never sent; an unreadable one says it was discarded', async (ctx) => {
  const { t, fx, request, courier } = ctx;
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl);
  fx.dropNextAck = true;
  assert.equal((await courier('--wait')).code, 0); // installed, ack dropped: committed record kept
  const grant = await signedGrant(readHome('key.json'));
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
  const committed = await courier('--grant-file', homeFile('legacy-grant.json'));
  assert.equal(committed.code, 0, committed.stderr);
  assert.match(committed.stderr, /already installed.*acknowledgement.*never sent/s);
  assert.doesNotMatch(committed.stderr, /was not installed/);
  // an unreadable record
  const again = await request();
  void again;
  fs.chmodSync(homeFile('approval-pending.json'), 0o644);
  const unreadable = await courier('--grant-file', homeFile('legacy-grant.json'));
  assert.equal(unreadable.code, 0, unreadable.stderr);
  assert.match(unreadable.stderr, /discarded an unreadable saved approval request/);
});

scenario('--resume from a saved XXXX-XXXX code keeps its --resume hint on a clock refusal', async ({ t, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  await request();
  const grant = await signedGrant(readHome('key.json'));
  const { savePending } = await import('../dist/pending.js');
  savePending('abcd-efgh', grant, new Date(Date.now() + 86_400_000));
  const real = Date.now;
  const behind = t.mock.method(Date, 'now', () => real() - 20 * 60_000);
  const run = await courier('--resume');
  behind.mock.restore();
  assert.equal(run.code, 1);
  assert.match(run.stderr, /system clock/);
  assert.match(run.stderr, /init --resume/);
});

scenario('the owner-pin message says rotation clears every pairing', async () => {
  const text = fs.readFileSync(new URL('../src/grant-request.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /re-pairs every peer/);
});
