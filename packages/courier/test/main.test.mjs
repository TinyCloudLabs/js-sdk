import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../dist/index.js';
import { setProgramName } from '../dist/program.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-main-'));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runCli(args, home) {
  return spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, COURIER_HOME: home }, encoding: 'utf8' });
}

test('courier bin: unknown command is a usage error', () => withHome((home) => {
  const result = runCli(['frobnicate'], home);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: courier </);
}));

test('courier bin: errors carry the code and name the courier command', () => withHome((home) => {
  const result = runCli(['init', '--resume'], home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^courier: \[no-grant\]/);
  assert.match(result.stderr, /`courier init`/);
}));

test('main() names the program it was invoked as', async () => {
  const previous = process.env.COURIER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-main-'));
  process.env.COURIER_HOME = home;
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    assert.equal(await main(['init', '--resume'], { prog: 'tc courier' }), 1);
    assert.match(errors.join('\n'), /^tc courier: \[no-grant\]/);
    assert.match(errors.join('\n'), /`tc courier init`/);
  } finally {
    console.error = consoleError;
    setProgramName('courier');
    if (previous === undefined) delete process.env.COURIER_HOME;
    else process.env.COURIER_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('courier invite --help: --tier trusted is a request; the peer starts strict until confirmed', () => {
  withHome((home) => {
    const r = runCli(['invite', '--help'], home);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--tier trusted  request trusted status; the peer starts as strict until you confirm/);
  });
});
