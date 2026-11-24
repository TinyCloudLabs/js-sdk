import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('invite and join help explain their part of the private link handoff', () => {
  for (const [args, instruction] of [
    [['invite'], /invite serve <invitationId>/],
    [['invite', 'serve'], /same invitation/],
    [['join'], /full URL, including its fragment/],
    [['pair'], /Advanced.*manual pairing/i],
  ]) {
    const { status, stdout, stderr } = run(...args, '--help');
    assert.equal(status, 0, stderr);
    assert.match(stdout, instruction);
    assert.doesNotMatch(stdout, /\bwatch\b|--mode[^\n]*\bemail\b/);
  }
});

test('a broken private link keeps its error code and asks for the full URL, never manual pairing', () => {
  const broken = 'https://courier.tinycloud.xyz/join#not-an-invite';
  for (const args of [['join', broken], ['start', '--link', broken]]) {
    const { status, stdout, stderr } = run(...args, '--consent');
    assert.equal(status, 1, stderr);
    assert.equal(stdout, '');
    assert.match(stderr, /\[path_grammar\]/);
    assert.match(stderr, /ask the sender for the exact full invitation URL/i);
    assert.doesNotMatch(stderr, /not-an-invite|pair start|pair accept/);
  }
});
