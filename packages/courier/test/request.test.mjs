import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestFields, cleanSummary, storedRequestFields, MAX_SUMMARY } from '../dist/request.js';

const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no error'; };

test('requestFields accepts the fixed verbs and stores the canonical target', () => {
  const f = requestFields({ verb: 'merge', target: 'https://github.com/TinyCloudLabs/Docs/pull/42', summary: 'Merge docs PR 42' });
  assert.deepEqual(f, { verb: 'merge', target: 'tinycloudlabs/docs#42', summary: 'Merge docs PR 42' });
});

test('requestFields rejects a missing or unknown verb, a missing target or summary, and a non-canonical target', () => {
  const ok = { verb: 'merge', target: 'o/r#1', summary: 's' };
  assert.equal(code(() => requestFields({ ...ok, verb: undefined })), 'usage');
  assert.equal(code(() => requestFields({ ...ok, verb: 'Merge' })), 'usage');
  assert.equal(code(() => requestFields({ ...ok, verb: 'rm' })), 'usage');
  assert.equal(code(() => requestFields({ ...ok, target: undefined })), 'usage');
  assert.equal(code(() => requestFields({ ...ok, target: 'whatever' })), 'usage');
  assert.equal(code(() => requestFields({ ...ok, summary: undefined })), 'usage');
});

test('summary: one line, control and bidi characters stripped, whitespace collapsed, empty or over-long rejected', () => {
  assert.equal(cleanSummary('  Merge\u202e  docs\n\tPR\u0000 42 '), 'Merge docs PR 42');
  assert.equal(code(() => cleanSummary('\u0000 \n')), 'usage');
  assert.equal(code(() => cleanSummary('x'.repeat(MAX_SUMMARY + 1))), 'usage');
  assert.equal(cleanSummary('x'.repeat(MAX_SUMMARY)).length, MAX_SUMMARY);
});

test('storedRequestFields reads only well-formed fields', () => {
  assert.deepEqual(storedRequestFields({ verb: 'other', target: 'secrets:set KEY', summary: 'Set a key' }), { verb: 'other', target: 'secrets:set KEY', summary: 'Set a key' });
  assert.equal(storedRequestFields({ verb: 'other', target: 'a\u0007b', summary: 's' }), undefined);
  assert.equal(storedRequestFields({ verb: 'other', target: 't' }), undefined);
});
