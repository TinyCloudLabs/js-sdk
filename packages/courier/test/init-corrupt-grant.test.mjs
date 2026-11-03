import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { deriveState } from '../dist/state.js';
import { loadProfile } from '../dist/profile.js';
import {
  Crash, crashAtWrite, homeFile, readHome, readySpace, scenario, stubSpaceProbe,
} from './support/approval-fixture.mjs';

// TC-2383: a saved grant is a grant.json that parses and has the shape of a grant (`loadGrant`), not a path that merely exists. A grant file
// cut short by a crash is not a saved grant: it classifies as no saved grant, is reported once by name, and is left as it is.

const TRUNCATED = '{"v":1,"delegationHeader":{"Authoriz';
const WARNING = /grant\.json is not a usable saved grant/g;
const warnings = (stderr) => (stderr.match(WARNING) ?? []).length;

function truncatedGrant() {
  fs.writeFileSync(homeFile('grant.json'), TRUNCATED, { mode: 0o600 });
}

scenario('a truncated grant.json classifies as no saved grant, is reported once by name, and deriveState leaves it alone', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await ctx.request();
  truncatedGrant();
  const derived = deriveState();
  assert.equal(derived.inputs.grant, false);
  assert.equal(derived.state, 'approval-open', 'like no saved grant: the open request is collected');
  assert.equal(derived.notes.length, 1);
  assert.match(derived.notes[0], /grant\.json/);
  assert.equal(fs.readFileSync(homeFile('grant.json'), 'utf8'), TRUNCATED);
});

scenario('a directory where grant.json belongs classifies as no saved grant', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await ctx.request();
  fs.mkdirSync(homeFile('grant.json'));
  const derived = deriveState();
  assert.equal(derived.inputs.grant, false);
  assert.equal(derived.notes.length, 1);
});

scenario('a truncated grant.json beside an open request: --wait collects the request instead of advising --resume', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  const printed = await ctx.request();
  await ctx.fx.approve(printed.openkeyUrl);
  truncatedGrant();
  ctx.errors.length = 0;
  const run = await ctx.courier('--wait');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(warnings(run.stderr), 1, 'one warning naming grant.json');
  assert.equal(ctx.fx.created.length, 1, 'no new request');
  assert.equal(ctx.fx.acks.length, 1);
  assert.equal(loadProfile().status, 'ready');
  assert.notEqual(fs.readFileSync(homeFile('grant.json'), 'utf8'), TRUNCATED, 'the collected grant replaced it');
});

scenario('a truncated grant.json beside a held approval: --resume hands off to --wait, which collects it', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  const printed = await ctx.request();
  await ctx.fx.approve(printed.openkeyUrl);
  const crash = crashAtWrite(ctx.t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
  const held = readHome('approval-pending.json');
  truncatedGrant();
  ctx.errors.length = 0;
  const run = await ctx.courier('--resume');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(warnings(run.stderr), 1);
  assert.equal(ctx.fx.created.length, 1);
  assert.equal(ctx.fx.acks.length, 1);
  assert.equal(ctx.fx.acks.at(-1).ackId, held.ackId);
  assert.equal(loadProfile().status, 'ready');
});

scenario('a truncated grant.json with nothing else saved: --resume reports it once and changes no file', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await ctx.request();
  fs.rmSync(homeFile('approval-pending.json'));
  truncatedGrant();
  ctx.errors.length = 0;
  const run = await ctx.courier('--resume');
  assert.notEqual(run.code, 0, run.stderr);
  assert.equal(warnings(run.stderr), 1);
  assert.equal(fs.readFileSync(homeFile('grant.json'), 'utf8'), TRUNCATED);
  assert.equal(loadProfile().status, 'awaiting-grant');
});

scenario('a truncated grant.json on a ready profile counts as a missing grant', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await ctx.request();
  fs.writeFileSync(homeFile('grant.json'), JSON.stringify({ v: 1, delegationHeader: { Authorization: 'a' }, delegationCid: 'c', spaceId: 's', siwe: 'x' }), { mode: 0o600 });
  fs.writeFileSync(homeFile('profile.json'), JSON.stringify({ ...readHome('profile.json'), status: 'ready' }), { mode: 0o600 });
  fs.rmSync(homeFile('approval-pending.json'));
  assert.equal(deriveState().state, 'ready');
  truncatedGrant();
  assert.equal(deriveState().state, 'grant-missing');
});

// Valid JSON that is not a grant (a field a grant has is missing) is as unusable as a cut-short file. Only the shape is checked here; the
// full verification of a saved grant stays in the install path (`--resume`), never in the derivation.
for (const [name, content] of [
  ['no delegation header', { v: 1, delegationCid: 'c', spaceId: 's', siwe: 'x' }],
  ['an unknown version', { v: 2, delegationHeader: { Authorization: 'a' }, delegationCid: 'c', spaceId: 's', siwe: 'x' }],
  ['not an object', [1, 2]],
]) {
  scenario(`a grant.json with ${name} classifies as no saved grant and is reported once by name`, async (ctx) => {
    stubSpaceProbe(ctx.t, readySpace);
    await ctx.request();
    const text = JSON.stringify(content);
    fs.writeFileSync(homeFile('grant.json'), text, { mode: 0o600 });
    const derived = deriveState();
    assert.equal(derived.inputs.grant, false);
    assert.equal(derived.state, 'approval-open');
    assert.equal(derived.notes.length, 1);
    assert.match(derived.notes[0], /grant\.json/);
    assert.equal(fs.readFileSync(homeFile('grant.json'), 'utf8'), text, 'left as it is');
    ctx.errors.length = 0;
    const run = await ctx.courier('--wait', '--timeout', '1s');
    assert.equal(warnings(run.stderr), 1);
  });
}
