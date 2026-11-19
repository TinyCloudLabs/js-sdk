import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const tc = fileURLToPath(new URL('../../cli/bin/tinycloud', import.meta.url));

test('Courier and tc courier help omit invite from their command listings', () => {
  for (const args of [[cli, '--help'], [tc, 'courier', '--help']]) {
    const result = spawnSync(process.execPath, args, { env: process.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\bjoin\b/);
    assert.doesNotMatch(result.stdout, /\binvite\b/);
  }
});
