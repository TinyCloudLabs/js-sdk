import assert from 'node:assert/strict';
import { DEAD_PID } from './support/review-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { cmdInit } from '../dist/commands.js';
import { parseArgs } from '../dist/args.js';
import { deriveState } from '../dist/state.js';
import { loadProfile } from '../dist/profile.js';
import { ed25519DidKey, ed25519PublicKey } from '../dist/did-key.js';
import {
  Crash, crashAtWrite, homeFile, missingSpace, readHome, readySpace, scenario, signedGrant, stubSpaceProbe,
} from './support/approval-fixture.mjs';
import { writeTempIdentity } from './support/lock-identity.mjs';

// TC-2383 review: (1) an unreadable profile or approval is its own state with permission advice, never absent and never "discard";
// (2) the warning for a discarded granted approval says what happened and when the grant may be live; (3) `--wait` keeps its refusals
// on a ready or awaiting-space profile that has no saved approval; (4) a parse failure of a key-bearing file never echoes its content.

const OWNER_WALLET = 'c3'.repeat(32);
const SENTINEL = 'SENTINEL_PRIVATE_KEY_d0e1f2a3b4c5';
const REVOKE = 'https://account.tinycloud.xyz/delegations';

const snapshot = () => {
  const dir = path.dirname(homeFile('x'));
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, { bytes: fs.readFileSync(path.join(dir, name)).toString('base64'), mode: fs.statSync(path.join(dir, name)).mode & 0o777 }]));
};

async function readyProfile({ t, request, courier }) {
  stubSpaceProbe(t, readySpace);
  await request();
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(await signedGrant(readHome('key.json'), { wallet: OWNER_WALLET })));
  assert.equal((await courier('--grant-file', homeFile('legacy-grant.json'))).code, 0);
  fs.rmSync(homeFile('legacy-grant.json'));
  fs.rmSync(homeFile('approval-pending.json'), { force: true });
  assert.equal(loadProfile().status, 'ready');
}

// ---- (4) a key-bearing file that cannot be parsed is reported without its content ----

// A recognizable high-entropy private key part (43 base64url characters, canonical like an Ed25519 `d`).
const SECRET = 'q7Vn2xK9mT4rZ8wB1cL5hJ0dFgY3sA6uEiO-PpRkXe8';
/** The first 8-character window of the secret found in `text`, if any. */
const secretFragment = (text) => {
  for (let at = 0; at + 8 <= SECRET.length; at += 1) if (text.includes(SECRET.slice(at, at + 8))) return SECRET.slice(at, at + 8);
  return undefined;
};
const leaks = (text) => text.includes('SENTIN') || text.includes('f2a3b4c5') || secretFragment(text) !== undefined;
const GARBAGE = `${SENTINEL} {"v":1,"jwk":{"d":"${SECRET}"} oops`;
for (const [file, modes] of [
  ['rotation.json', [['--request'], ['--wait', '--timeout', '1s'], ['--resume'], ['--rotate-key', '--request']]],
  // `--resume` on an awaiting-grant profile with nothing saved refuses before it reads key.json, so it has nothing to report about it.
  ['key.json', [['--request'], ['--wait', '--timeout', '1s']]],
]) {
  for (const mode of modes) {
    scenario(`a ${file} that cannot be parsed: \`init ${mode.join(' ')}\` names the file and prints none of its content`, async (ctx) => {
      stubSpaceProbe(ctx.t, readySpace);
      await ctx.request();
      fs.writeFileSync(homeFile(file), GARBAGE, { mode: 0o600 });
      ctx.errors.length = 0;
      const run = await ctx.courier(...mode);
      assert.notEqual(run.code, 0, mode.join(' '));
      assert.match(run.stderr, new RegExp(file.replace('.', '\\.')));
      assert.equal(leaks(run.stderr), false, 'stderr holds no file content');
      assert.equal(leaks(run.stdout), false, 'stdout holds no file content');
      assert.equal(fs.readFileSync(homeFile(file), 'utf8'), GARBAGE, 'the file is left as it is');
    });
  }
}

// The parser error of a cut-off or damaged journal quotes text near the failure: the private `d` of the new key sits in the JWK, and no
// contiguous 8 characters of it may reach an output (the fragment V8 quotes is 10-20 characters).
for (const [shape, text] of [
  ['cut off inside the private key', `{"v":1,"key":{"v":1,"jwk":{"kty":"OKP","crv":"Ed25519","d":"${SECRET.slice(0, 30)}`],
  ['damaged just after the private key', `{"v":1,"key":{"v":1,"jwk":{"kty":"OKP","crv":"Ed25519","d":"${SECRET}" oops`],
  ['with garbage before the private key', `oops {"v":1,"key":{"v":1,"jwk":{"kty":"OKP","d":"${SECRET}"}}}`],
  ['with a stray character inside the private key', `{"v":1,"key":{"v":1,"jwk":{"kty":"OKP","d":"${SECRET.slice(0, 20)}"x${SECRET.slice(20)}"}}}`],
]) {
  scenario(`a rotation journal ${shape}: no output holds any part of the private key, and deriveState still says an interrupted rotation`, async (ctx) => {
    stubSpaceProbe(ctx.t, readySpace);
    await ctx.request();
    fs.writeFileSync(homeFile('rotation.json'), text, { mode: 0o600 });
    assert.equal(deriveState().state, 'rotation-interrupted');
    for (const argv of [['--wait', '--timeout', '1s'], ['--request'], ['--resume']]) {
      ctx.errors.length = 0;
      const run = await ctx.courier(...argv);
      assert.notEqual(run.code, 0, argv.join(' '));
      assert.equal(secretFragment(run.stderr + run.stdout), undefined, `${argv.join(' ')} printed a fragment of the private key`);
      assert.equal(fs.readFileSync(homeFile('rotation.json'), 'utf8'), text, 'the journal is left as it is');
    }
  });
}

// ---- (1) an unreadable profile or approval is not absent, and nothing says to discard what rotation does not discard ----

for (const [label, damage] of [
  ['mode 644', () => fs.chmodSync(homeFile('profile.json'), 0o644)],
  ['not valid JSON', () => fs.writeFileSync(homeFile('profile.json'), '{ not json', { mode: 0o600 })],
]) {
  scenario(`a profile.json with ${label} is profile-unreadable, never absent: every mode but --rotate-key refuses and changes no file`, async (ctx) => {
    stubSpaceProbe(ctx.t, readySpace);
    await ctx.request();
    damage();
    const derived = deriveState();
    assert.equal(derived.state, 'profile-unreadable');
    assert.equal(derived.action, 'fix-profile');
    assert.equal(derived.inputs.profile, 'unreadable');
    const before = snapshot();
    for (const argv of [['--resume'], ['--wait'], ['--request']]) {
      const run = await ctx.courier(...argv);
      assert.notEqual(run.code, 0, argv.join(' '));
      assert.match(run.stderr, /profile\.json/, argv.join(' '));
      assert.deepEqual(snapshot(), before, `${argv.join(' ')} changed a file`);
    }
  });
}

scenario('an unreadable profile.json beside a saved approval is profile-unreadable, not an orphaned approval', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await ctx.request();
  fs.chmodSync(homeFile('profile.json'), 0o644);
  assert.equal(deriveState().state, 'profile-unreadable');
});

scenario('--rotate-key still replaces an unreadable profile.json', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await ctx.request();
  fs.chmodSync(homeFile('profile.json'), 0o644);
  const run = await ctx.courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(loadProfile().status, 'awaiting-grant');
});

for (const [kind, shape, advice, notAdvice] of [
  ['held', async (ctx) => {
    const printed = await ctx.request();
    await ctx.fx.approve(printed.openkeyUrl);
    const crash = crashAtWrite(ctx.t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
    await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
    crash.disarm();
  }, /--rotate-key.*discard/s, null],
  ['open', async (ctx) => { await ctx.request(); }, /--rotate-key/, /discard/i],
  ['unreadable', async (ctx) => { await ctx.request(); fs.chmodSync(homeFile('approval-pending.json'), 0o644); }, /chmod 600/, /discard/i],
]) {
  scenario(`an orphaned ${kind} approval (profile.json missing): the advice says only what the next command does`, async (ctx) => {
    stubSpaceProbe(ctx.t, readySpace);
    await shape(ctx);
    fs.rmSync(homeFile('profile.json'));
    const run = await ctx.courier('--wait', '--timeout', '1s');
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /approval-pending\.json/);
    assert.match(run.stderr, advice);
    if (notAdvice) assert.doesNotMatch(run.stderr, notAdvice);
  });
}

scenario('--rotate-key with an unreadable saved approval refuses before rotating, leaves it untouched, and says nothing about discarding it', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await readyProfile(ctx);
  await ctx.request();
  fs.chmodSync(homeFile('approval-pending.json'), 0o644);
  const bytes = fs.readFileSync(homeFile('approval-pending.json'));
  ctx.errors.length = 0;
  // `--grant-file` with an empty file ends the command after the rotation (no prompt, no wait).
  fs.writeFileSync(homeFile('empty-grant.json'), '', { mode: 0o600 });
  const run = await ctx.courier('--rotate-key', '--grant-file', homeFile('empty-grant.json'));
  assert.equal(run.code, 1, 'refused');
  assert.equal(readHome('profile.json').status, 'ready', 'the key was not rotated');
  assert.match(run.stderr, /chmod 600/);
  assert.deepEqual(fs.readFileSync(homeFile('approval-pending.json')), bytes, 'left as it was');
  assert.doesNotMatch(run.stderr, /discards that approval/);
});

// ---- (2) the warning for a discarded granted approval ----

async function resultHeld(ctx) {
  stubSpaceProbe(ctx.t, readySpace);
  await readyProfile(ctx);
  const printed = await ctx.request();
  await ctx.fx.approve(printed.openkeyUrl, { grant: { wallet: OWNER_WALLET } });
  const crash = crashAtWrite(ctx.t, 'approval-pending.json', { phase: 'after', when: (c) => c.resultEnvelope !== undefined });
  await assert.rejects(cmdInit(parseArgs(['--wait'])), (error) => error instanceof Crash);
  crash.disarm();
}

scenario('rotating over a granted approval says it was granted, when the grant may be live until, and where to revoke it; no refusal wording', async (ctx) => {
  await resultHeld(ctx);
  ctx.errors.length = 0;
  const run = await ctx.courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /already granted/);
  assert.match(run.stderr, /live grant may exist/);
  assert.match(run.stderr, /valid until \d{4}-\d{2}-\d{2}T/);
  assert.ok(run.stderr.includes(REVOKE));
  assert.match(run.stderr, /discards that approval/);
  assert.doesNotMatch(run.stderr, /Refused delegation|Nothing was installed or used|refused/i);
});

// ---- (3) --wait keeps its refusals while no approval is saved ----

scenario('--wait on a ready profile with no saved approval refuses as before, even when grant.json is gone, and changes no file', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await readyProfile(ctx);
  fs.rmSync(homeFile('grant.json'));
  const created = ctx.fx.created.length;
  const before = snapshot();
  const run = await ctx.courier('--wait', '--timeout', '1s');
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /already has a grant and no approval request is pending/);
  assert.equal(ctx.fx.created.length, created, 'no request was started');
  assert.deepEqual(snapshot(), before);
});

scenario('--wait on an awaiting-space profile with no saved approval and no grant refuses as before and changes no file', async (ctx) => {
  stubSpaceProbe(ctx.t, missingSpace);
  await ctx.request();
  fs.rmSync(homeFile('approval-pending.json'));
  fs.writeFileSync(homeFile('profile.json'), JSON.stringify({ ...readHome('profile.json'), status: 'awaiting-space' }), { mode: 0o600 });
  const created = ctx.fx.created.length;
  const before = snapshot();
  const run = await ctx.courier('--wait', '--timeout', '1s');
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /space is still being set up/);
  assert.equal(ctx.fx.created.length, created);
  assert.deepEqual(snapshot(), before);
});

// ---- (5) a redeemed delegation addressed to the old key is discarded by rotation, with a warning, never dropped silently later ----

const crashBeforeUnlink = (t, file) => {
  const original = fs.unlinkSync;
  fs.unlinkSync = (target, ...rest) => {
    if (path.basename(String(target)) === file) throw new Crash(`before removing ${file}`);
    return original(target, ...rest);
  };
  t.after(() => { fs.unlinkSync = original; });
  return { disarm: () => { fs.unlinkSync = original; } };
};

async function savedRedeemedGrant(ctx) {
  stubSpaceProbe(ctx.t, readySpace);
  await ctx.request();
  const grant = await signedGrant(readHome('key.json'), { wallet: OWNER_WALLET });
  const record = { codeHash: 'a-redeemed-code', expiresAt: '2999-01-01T00:00:00.000Z', savedAt: new Date().toISOString(), delegation: grant };
  fs.writeFileSync(homeFile('pending-grant.json'), JSON.stringify({ v: 1, records: [record] }), { mode: 0o600 });
  return grant;
}

scenario('rotating with a redeemed delegation saved for the old key discards it and says a live grant may exist, with its CID, expiry and the revoke page', async (ctx) => {
  const grant = await savedRedeemedGrant(ctx);
  ctx.errors.length = 0;
  const run = await ctx.courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.stderr.includes(grant.delegationCid), 'the CID is named');
  assert.match(run.stderr, /live grant may exist/);
  assert.match(run.stderr, /valid until \d{4}-\d{2}-\d{2}T/);
  assert.ok(run.stderr.includes(REVOKE));
  assert.equal(fs.existsSync(homeFile('pending-grant.json')), false, 'the stale delegation is gone');
  assert.equal(deriveState().inputs.pendingGrant, false);
});

scenario('the discard of a redeemed delegation is journaled without secrets and its warning survives a crash at each boundary', async (ctx) => {
  const grant = await savedRedeemedGrant(ctx);
  const crash = crashBeforeUnlink(ctx.t, 'rotation.json');
  await assert.rejects(cmdInit(parseArgs(['--rotate-key', '--request'])), (error) => error instanceof Crash);
  crash.disarm();
  assert.equal(fs.existsSync(homeFile('pending-grant.json')), false, 'removed in the journaled step');
  const journal = readHome('rotation.json');
  assert.equal(journal.discardedGrants.length, 1);
  assert.equal(journal.discardedGrants[0].delegationCid, grant.delegationCid);
  const text = fs.readFileSync(homeFile('rotation.json'), 'utf8');
  assert.equal(text.includes(grant.delegationHeader.Authorization), false, 'no delegation header in the journal');
  assert.equal(text.includes(grant.signature), false, 'no signature in the journal');
  ctx.errors.length = 0;
  const run = await ctx.courier('--request');
  assert.ok(run.stderr.includes(grant.delegationCid));
  assert.ok(run.stderr.includes(REVOKE));
  assert.equal(fs.existsSync(homeFile('rotation.json')), false);
});

scenario('a crash right after the journal is written leaves the redeemed delegation until the next init rolls the rotation forward and warns', async (ctx) => {
  const grant = await savedRedeemedGrant(ctx);
  const crash = crashAtWrite(ctx.t, 'rotation.json', { phase: 'after' });
  await assert.rejects(cmdInit(parseArgs(['--rotate-key', '--request'])), (error) => error instanceof Crash);
  crash.disarm();
  assert.equal(fs.existsSync(homeFile('pending-grant.json')), true);
  assert.equal(readHome('rotation.json').discardedGrants[0].delegationCid, grant.delegationCid);
  ctx.errors.length = 0;
  const run = await ctx.courier('--resume');
  assert.ok(run.stderr.includes(grant.delegationCid), run.stderr);
  assert.ok(run.stderr.includes(REVOKE));
  assert.equal(fs.existsSync(homeFile('pending-grant.json')), false);
});

scenario('rotating with no redeemed delegation saved prints no delegation warning and leaves pending-grant.json absent', async (ctx) => {
  stubSpaceProbe(ctx.t, readySpace);
  await ctx.request();
  ctx.errors.length = 0;
  const run = await ctx.courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr.includes(REVOKE), false);
  assert.equal(readHome('profile.json').status, 'awaiting-grant');
});

// ---- (6) a journal that parses but is not a rotation is refused before anything is replayed ----

// The journal's key is proven before replay (Ed25519 JWK of 32-byte parts, did:key derived from `x`), so the stand-in is a well-formed one.
const NEW_PUBLIC = ed25519PublicKey(Buffer.from(SECRET, 'base64url'));
const NEW_DID = ed25519DidKey(NEW_PUBLIC);
const goodJournal = () => ({
  v: 1,
  key: { v: 1, jwk: { kty: 'OKP', crv: 'Ed25519', x: NEW_PUBLIC.toString('base64url'), d: SECRET }, did: NEW_DID, createdAt: '2026-01-01T00:00:00.000Z' },
  profile: {
    version: 3, host: 'https://node.test', openkeyHost: 'https://openkey.test', label: 'l', courierDid: NEW_DID, status: 'awaiting-grant', peers: {},
  },
  discardApproval: false,
  grantedResult: false,
});
const withKey = (change) => { const j = goodJournal(); change(j.key); return j; };
const withProfile = (change) => { const j = goodJournal(); change(j.profile); return j; };
const withJournal = (change) => { const j = goodJournal(); change(j); return j; };

const MALFORMED = {
  'a journal version other than 1': withJournal((j) => { j.v = 2; }),
  'no key': withJournal((j) => { delete j.key; }),
  'no profile': withJournal((j) => { delete j.profile; }),
  'a key version other than 1': withKey((k) => { k.v = 2; }),
  'a key without a jwk': withKey((k) => { delete k.jwk; }),
  'a key did that is not a did:key': withKey((k) => { k.did = 'did:web:example.test'; }),
  'a key without a did': withKey((k) => { delete k.did; }),
  'a profile version 2': withProfile((p) => { p.version = 2; }),
  'a profile without a version': withProfile((p) => { delete p.version; }),
  'a profile without a host': withProfile((p) => { delete p.host; }),
  'a profile without an openkeyHost': withProfile((p) => { delete p.openkeyHost; }),
  'a profile without a courierDid': withProfile((p) => { delete p.courierDid; }),
  'a profile courierDid that is not the key did': withProfile((p) => { p.courierDid = 'did:key:z6MkSomeoneElse'; }),
  'a profile status other than awaiting-grant': withProfile((p) => { p.status = 'ready'; }),
  'a discardApproval that is not a boolean': withJournal((j) => { j.discardApproval = 'yes'; }),
  'a grantedResult that is not a boolean': withJournal((j) => { j.grantedResult = 1; }),
  'discardedGrants that is not a list': withJournal((j) => { j.discardedGrants = 'bafy'; }),
  'a discardedGrants entry without a delegationCid': withJournal((j) => { j.discardedGrants = [{ expiresAt: '2999-01-01T00:00:00.000Z' }]; }),
  'an array instead of an object': [goodJournal()],
  'null': null,
};

const STRAY_KEY_TEMP = `key.json.${DEAD_PID}.0a1b2c3d4e5f.tmp`;

/** A ready profile with an open request, a saved redeemed delegation, an invalid journal and a stray key temp: all must stay as they are. */
async function plantInvalidJournal(ctx, journal) {
  await readyProfile(ctx);
  await ctx.request();
  const record = { codeHash: 'a-code', expiresAt: '2999-01-01T00:00:00.000Z', savedAt: new Date().toISOString(), delegation: { delegationCid: 'bafy-saved' } };
  fs.writeFileSync(homeFile('pending-grant.json'), JSON.stringify({ v: 1, records: [record] }), { mode: 0o600 });
  fs.writeFileSync(homeFile('rotation.json'), JSON.stringify(journal), { mode: 0o600 });
  fs.writeFileSync(homeFile(STRAY_KEY_TEMP), JSON.stringify({ v: 1, jwk: { d: SECRET } }), { mode: 0o600 });
  writeTempIdentity(homeFile(STRAY_KEY_TEMP), DEAD_PID, '0a1b2c3d4e5f');
}

async function assertRefusedUnchanged(ctx, argv) {
  const before = snapshot();
  ctx.errors.length = 0;
  const run = await ctx.courier(...argv);
  assert.notEqual(run.code, 0, argv.join(' '));
  const lines = run.stderr.split('\n').filter((line) => /rotation\.json/.test(line));
  assert.equal(lines.length, 1, `${argv.join(' ')}: exactly one recovery line, got: ${run.stderr}`);
  assert.match(lines[0], /not a valid key rotation record/);
  assert.match(lines[0], /Nothing was changed/);
  assert.equal(secretFragment(run.stderr + run.stdout), undefined, 'no key material in the output');
  // The journal, key, profile, grant, approval, pending grant and the stray temp are all byte-identical (and keep their modes).
  assert.deepEqual(snapshot(), before, `${argv.join(' ')} changed a file`);
}

for (const [kind, journal] of Object.entries(MALFORMED)) {
  scenario(`a rotation journal with ${kind} is refused with one recovery line, and no file changes (init --request)`, async (ctx) => {
    await plantInvalidJournal(ctx, journal);
    await assertRefusedUnchanged(ctx, ['--request']);
  });
}

scenario('an invalid rotation journal is refused the same way, unchanged, by every other mode', async (ctx) => {
  await plantInvalidJournal(ctx, MALFORMED['a key version other than 1']);
  for (const argv of [['--resume'], ['--wait', '--timeout', '1s'], ['--rotate-key', '--request'], ['--grant-file', homeFile('rotation.json')]]) {
    await assertRefusedUnchanged(ctx, argv);
  }
});

scenario('a well-formed journal is rolled forward by the same validation (control)', async (ctx) => {
  await readyProfile(ctx);
  fs.writeFileSync(homeFile('rotation.json'), JSON.stringify(goodJournal()), { mode: 0o600 });
  // The journal key is a stand-in, so only the replay is asserted (the command after it may refuse, which is not what is under test).
  await ctx.courier('--resume');
  assert.equal(readHome('key.json').did, NEW_DID);
  assert.equal(readHome('profile.json').courierDid, NEW_DID);
  assert.equal(fs.existsSync(homeFile('rotation.json')), false);
  assert.equal(fs.existsSync(homeFile('grant.json')), false);
});

// ---- (7) stray temp scrub touches only the temp file itself ----

scenario('a stray key temp that is a hard link to another file is refused and the other file is not overwritten', async (ctx) => {
  await readyProfile(ctx);
  const victim = homeFile('victim.json');
  fs.writeFileSync(victim, JSON.stringify({ keep: 'this content' }), { mode: 0o600 });
  fs.linkSync(victim, homeFile(STRAY_KEY_TEMP));
  writeTempIdentity(homeFile(STRAY_KEY_TEMP), DEAD_PID, '0a1b2c3d4e5f');
  const before = snapshot();
  ctx.errors.length = 0;
  const run = await ctx.courier('--request');
  assert.notEqual(run.code, 0, run.stderr);
  assert.match(run.stderr, new RegExp(`key\\.json\\.${DEAD_PID}`));
  assert.deepEqual(snapshot(), before, 'no file was overwritten or removed');
});

scenario('a stray key temp that is a symlink is refused and its target is not touched', async (ctx) => {
  await readyProfile(ctx);
  const victim = homeFile('victim.json');
  fs.writeFileSync(victim, JSON.stringify({ keep: 'this content' }), { mode: 0o600 });
  fs.symlinkSync(victim, homeFile(STRAY_KEY_TEMP));
  writeTempIdentity(homeFile(STRAY_KEY_TEMP), DEAD_PID, '0a1b2c3d4e5f');
  const bytes = fs.readFileSync(victim);
  ctx.errors.length = 0;
  const run = await ctx.courier('--request');
  assert.notEqual(run.code, 0, run.stderr);
  assert.deepEqual(fs.readFileSync(victim), bytes);
  assert.equal(fs.lstatSync(homeFile(STRAY_KEY_TEMP)).isSymbolicLink(), true);
});
