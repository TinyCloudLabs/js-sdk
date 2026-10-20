import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestFields, storedRequestFields } from '../dist/request.js';

const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no error'; };

test('requestFields accepts the fixed verbs and stores the canonical target', () => {
  const f = requestFields({ verb: 'merge', headSha: 'a'.repeat(40), base: 'Main', target: 'https://github.com/TinyCloudLabs/Docs/pull/42', summary: 'Merge docs PR 42' });
  assert.deepEqual(f, { verb: 'merge', headSha: 'a'.repeat(40), base: 'Main', target: 'tinycloudlabs/docs#42', summary: 'Merge docs PR 42' });
});

test('requestFields rejects a missing or unknown verb, a missing target or summary, and a non-canonical target', () => {
  const ok = { verb: 'merge', headSha: 'a'.repeat(40), base: 'Main', target: 'o/r#1', summary: 's' };
  assert.equal(code(() => requestFields({ ...ok, verb: undefined })), 'usage');
  assert.equal(code(() => requestFields({ ...ok, verb: 'Merge' })), 'usage');
  assert.equal(code(() => requestFields({ ...ok, verb: 'rm' })), 'usage');
  assert.equal(code(() => requestFields({ ...ok, target: undefined })), 'usage');
  assert.equal(code(() => requestFields({ ...ok, target: 'whatever' })), 'usage');
  assert.equal(code(() => requestFields({ ...ok, summary: undefined })), 'usage');
});

test('storedRequestFields reads only well-formed fields', () => {
  assert.deepEqual(storedRequestFields({ verb: 'other', target: 'secrets:set KEY', summary: 'Set a key' }), { verb: 'other', target: 'secrets:set KEY', summary: 'Set a key' });
  assert.equal(storedRequestFields({ verb: 'other', target: 'a\u0007b', summary: 's' }), undefined);
  assert.equal(storedRequestFields({ verb: 'other', target: 't' }), undefined);
});

test('merge pins are mandatory on write and read; request flags cannot smuggle them into other verbs', async () => {
  const { main } = await import('../dist/main.js');
  const merge = { verb: 'merge', target: 'o/r#1', summary: 'Merge PR 1', headSha: 'a'.repeat(40), base: 'Main' };
  for (const key of ['headSha', 'base']) {
    const missing = { ...merge };
    delete missing[key];
    assert.throws(() => requestFields(missing), (e) => e.code === 'usage');
    assert.equal(storedRequestFields(missing), undefined);
  }
  const args = ['request', '01M5C9EDF03QMRZS2DJXGN5A4C', '--peer', 'bob', '--task', '01M5CBKA6RNA3RZ2819T9M7NK1', '--summary', 'Test request', '--why', 'test'];
  const original = console.error;
  let output = '';
  console.error = (message) => { output += message; };
  try {
    assert.equal(await main([...args, '--verb', 'merge', '--target', 'o/r#1']), 2);
    assert.match(output, /--head-sha is refused/);
    output = '';
    assert.equal(await main([...args, '--verb', 'merge', '--target', 'o/r#1', '--head-sha', 'a'.repeat(40), '--base']), 2);
    assert.match(output, /--base is required/);
    for (const flags of [['--head-sha'], ['--base'], ['--head-sha', 'a'.repeat(40)], ['--base', 'Main']]) {
      output = '';
      assert.equal(await main([...args, '--verb', 'deploy', '--target', 'pages:site', ...flags]), 2);
      assert.match(output, /only allowed for --verb merge|is required/);
    }
  } finally {
    console.error = original;
  }
});
