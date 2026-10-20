import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TEXT_ALLOWED_RANGES, TEXT_UNICODE_VERSION } from '../dist/text-ranges.js';
import { textCodePointAllowed, textVerdict } from '../dist/text.js';
const vectors = JSON.parse(fs.readFileSync(new URL('./vectors/text-verdicts.json', import.meta.url)));

// Independent oracle: runtime property tables are used ONLY here, never in a decision function.
const category = /^(?:\p{Lu}|\p{Ll}|\p{Lt}|\p{Lo}|\p{Nd})$/u;
const ignorable = /\p{Default_Ignorable_Code_Point}/u;
const summaryPunctuation = new Set([0x21,0x23,0x27,0x28,0x29,0x2c,0x2d,0x2e,0x2f,0x3a,0x3b,0x3f,0x5f]);

test('all 1,114,112 code points: frozen verdicts match implementation, and never exceed the independent Unicode oracle', t => {
  assert.equal(TEXT_UNICODE_VERSION, '15.0.0');
  assert.equal(vectors.unicodeVersion, TEXT_UNICODE_VERSION);
  let tableIndex = 0, vectorIndex = 0, newer = 0;
  let previous = -1;
  for (const [start,end] of TEXT_ALLOWED_RANGES) {
    assert.ok(start > previous && end >= start && end <= 0x10ffff);
    previous = end;
  }
  previous = -1;
  for (const [start,end,mask] of vectors.ranges) {
    assert.equal(start, previous + 1); assert.ok(end >= start && mask >= 0 && mask <= 7);
    previous = end;
  }
  assert.equal(previous, 0x10ffff);
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const c = String.fromCodePoint(cp);
    while (tableIndex < TEXT_ALLOWED_RANGES.length && cp > TEXT_ALLOWED_RANGES[tableIndex][1]) tableIndex++;
    const tableAllows = tableIndex < TEXT_ALLOWED_RANGES.length && cp >= TEXT_ALLOWED_RANGES[tableIndex][0];
    const oracleAllows = category.test(c) && !ignorable.test(c);
    if (tableAllows && !oracleAllows) assert.fail(`frozen table wider than runtime oracle: U+${cp.toString(16)}`);
    if (oracleAllows && !tableAllows) newer++;
    while (cp > vectors.ranges[vectorIndex][1]) vectorIndex++;
    const mask = vectors.ranges[vectorIndex][2];
    for (const [i,field] of ['summary','multiline','target'].entries()) {
      const ascii = cp >= 0x20 && cp <= 0x7e;
      const asciiLetterDigit = (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122);
      const independent = field === 'target' ? ascii :
        field === 'summary' ? cp === 32 || asciiLetterDigit || summaryPunctuation.has(cp) || (!ascii && oracleAllows) :
        cp === 10 || ascii || oracleAllows;
      const eligibility = textCodePointAllowed(cp, field);
      if (eligibility && !independent) assert.fail(`field ${field} wider than oracle: U+${cp.toString(16)}`);
      // ASCII rules must match exactly; non-ASCII additions to newer runtimes remain refused.
      if (cp < 128) assert.equal(eligibility, independent, `${field} ASCII ${cp}`);
      const actual = textVerdict(`a${c}a`, field).allowed;
      if (actual !== Boolean(mask & (1 << i))) assert.fail(`shared vector differs: ${field} U+${cp.toString(16)}`);
    }
  }
  t.diagnostic(`Unicode ${process.versions.unicode} runtime: ${newer} category-allowed code points beyond frozen Unicode ${TEXT_UNICODE_VERSION} (reported, refused everywhere).`);
});

test('full-string vectors include NFC/NFD, field limits and stable reason codes', () => {
  for (const {field,value,allowed,reason} of vectors.samples) assert.deepEqual(textVerdict(value,field),{allowed,reason}, `${field}: ${JSON.stringify(value).slice(0,80)}`);
  assert.deepEqual(textVerdict(3,'summary'),{allowed:false,reason:'not-string'});
});
