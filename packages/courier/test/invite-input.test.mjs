import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readInviteArg } from '../dist/invite-commands.js';
import { parseArgs } from '../dist/args.js';

const usageError = (pattern) => (e) => e.code === 'usage' && pattern.test(e.message);

test('join: the positional invite string is returned as given', () => {
  assert.equal(readInviteArg(parseArgs(['tcinvite1:x:y:z'])), 'tcinvite1:x:y:z');
});

test('join: --file returns the file contents with surrounding whitespace trimmed', () => {
  const dir = fs.mkdtempSync(path.join('/var/tmp', 'courier-input-'));
  try {
    const file = path.join(dir, 'invite.txt');
    fs.writeFileSync(file, '  tcinvite1:x:y:z\n');
    assert.equal(readInviteArg(parseArgs(['--file', file])), 'tcinvite1:x:y:z');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('join: --file with no path is a usage error', () => {
  assert.throws(() => readInviteArg(parseArgs(['--file'])), usageError(/--file needs a path/));
});

test('join: --file together with a positional string is a usage error', () => {
  assert.throws(() => readInviteArg(parseArgs(['tcinvite1:x:y:z', '--file', 'f.txt'])), usageError(/once/));
});

test('join: --stdin together with --credential-stdin is refused before reading stdin', () => {
  assert.throws(() => readInviteArg(parseArgs(['--stdin', '--credential-stdin'])), usageError(/both read stdin/));
});

test('join: no invite source at all is a usage error', () => {
  assert.throws(() => readInviteArg(parseArgs([])), usageError(/Usage: .*join/));
});
