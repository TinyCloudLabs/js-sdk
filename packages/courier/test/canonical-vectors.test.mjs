import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalJson, requestHash } from '../dist/canonical.js';

const { vectors } = JSON.parse(fs.readFileSync(new URL('./vectors/canonical.json', import.meta.url), 'utf8'));

for (const v of vectors) {
  test(`shared canonical vector: ${v.name}`, () => {
    const parsed = JSON.parse(v.json);
    if (v.canonical === null) {
      assert.throws(() => canonicalJson(parsed), (e) => e.code === 'canonical-invalid');
      assert.throws(() => requestHash(parsed), (e) => e.code === 'canonical-invalid');
      return;
    }
    assert.equal(canonicalJson(parsed), v.canonical);
    assert.equal(createHash('sha256').update(v.canonical, 'utf8').digest('hex'), v.sha256, 'the vector file is self-consistent');
    assert.equal(requestHash(parsed), v.sha256);
  });
}

test('NaN and Infinity are refused too when the input did not come from parsed JSON', () => {
  assert.throws(() => canonicalJson({ n: NaN }), (e) => e.code === 'canonical-invalid');
  assert.throws(() => canonicalJson([Infinity]), (e) => e.code === 'canonical-invalid');
});
