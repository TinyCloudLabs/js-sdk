import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPending } from '../dist/approval-phase.js';
import { deriveState } from '../dist/state.js';
import { homeFile, readHome, scenario } from './support/approval-fixture.mjs';
import { leakedWindow } from './support/review-fixture.mjs';

// TC-2383: approval-pending.json holds `relayPrivateKey`. A JSON parser's error message quotes the text around the failure, so a corrupt
// or truncated file must be reported with a fixed reason, never the parser's message. No 8-character window of the key may appear anywhere
// in what a command prints (stdout and stderr together).

const CORRUPTIONS = {
  // Cut inside the key itself.
  'truncated inside the private key': (text, key) => text.slice(0, text.indexOf(key) + 20),
  // A token the parser rejects right at the key: node quotes the surrounding text.
  'an unquoted private key': (text, key) => text.replace(`"${key}"`, `q${key}`),
  // Cut just after the key, so the key is the last thing in the file.
  'truncated right after the private key': (text, key) => text.slice(0, text.indexOf(key) + key.length + 1),
};

const COMMANDS = [
  ['--request'],
  ['--wait', '--timeout', '1s'],
  ['--resume'],
  ['--rotate-key', '--request'],
];

async function corruptApproval(ctx, corrupt) {
  await ctx.request();
  const text = fs.readFileSync(homeFile('approval-pending.json'), 'utf8');
  const key = readHome('approval-pending.json').relayPrivateKey;
  assert.ok(key.length >= 32, 'the fixture key is long enough to be a meaningful secret');
  const broken = corrupt(text, key);
  assert.ok(broken.includes(key.slice(0, 20)), 'the corrupt file still holds the key');
  assert.throws(() => JSON.parse(broken));
  fs.writeFileSync(homeFile('approval-pending.json'), broken, { mode: 0o600 });
  ctx.errors.length = 0;
  return key;
}

for (const [name, corrupt] of Object.entries(CORRUPTIONS)) {
  for (const argv of COMMANDS) {
    scenario(`a corrupt approval-pending.json (${name}) never reaches the output of \`init ${argv.join(' ')}\``, async (ctx) => {
      const key = await corruptApproval(ctx, corrupt);
      const run = await ctx.courier(...argv);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.equal(leakedWindow(output, key), undefined, `output echoed part of the private key: ${leakedWindow(output, key)}`);
    });
  }

  scenario(`a corrupt approval-pending.json (${name}) never reaches the output of the read-only readers`, async (ctx) => {
    const key = await corruptApproval(ctx, corrupt);
    const derived = deriveState();
    assert.equal(derived.inputs.approval, 'corrupt');
    loadPending();
    const output = [...ctx.errors, ...derived.notes].join('\n');
    assert.match(output, /approval-pending\.json/, 'the file is still named');
    assert.equal(leakedWindow(output, key), undefined);
  });
}

scenario('a corrupt approval-pending.json is still named, set aside and replaced, with a reason that quotes nothing from the file', async (ctx) => {
  const key = await corruptApproval(ctx, CORRUPTIONS['an unquoted private key']);
  const run = await ctx.courier('--request');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /approval-pending\.json is corrupt/);
  assert.match(run.stderr, /approval-pending\.json\.corrupt-/);
  assert.equal(leakedWindow(`${run.stdout}\n${run.stderr}`, key), undefined);
  const aside = fs.readdirSync(process.env.COURIER_HOME).filter((name) => name.startsWith('approval-pending.json.corrupt-'));
  assert.equal(aside.length, 1, 'the original bytes are kept, not printed');
  assert.ok(fs.readFileSync(homeFile(aside[0]), 'utf8').includes(key));
});
