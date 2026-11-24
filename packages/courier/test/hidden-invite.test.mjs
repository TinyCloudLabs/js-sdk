import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const tc = fileURLToPath(new URL('../../cli/bin/tinycloud', import.meta.url));

test('help leads with invitation links and puts manual pairing under Advanced', () => {
  for (const args of [[cli, '--help'], [tc, 'courier', '--help']]) {
    const result = spawnSync(process.execPath, args, { env: process.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const [primary, advanced] = result.stdout.split('\nAdvanced');
    assert.match(primary, /^\s+invite --session\b/m);
    assert.match(primary, /^\s+invite serve\b/m);
    assert.match(primary, /^\s+join\b/m);
    assert.doesNotMatch(primary, /^\s+pair (?:start|accept)\b/m);
    assert.match(advanced ?? '', /^\s+pair start\b/m);
    assert.match(advanced ?? '', /^\s+pair accept\b/m);
    assert.doesNotMatch(result.stdout, /--mode[^\n]*\bemail\b|^\s+invite [^\n]*--(?:invite-)?email\b/m);
  }
});
