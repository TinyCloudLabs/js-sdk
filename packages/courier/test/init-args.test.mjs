import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-init-args-'));
  const initial = spawnSync(process.execPath, [CLI, 'init', '--request', '--handle', 'alice'], {
    env: { ...process.env, COURIER_HOME: home }, encoding: 'utf8',
  });
  assert.equal(initial.status, 0, initial.stderr);
  fs.writeFileSync(path.join(home, 'grant.json'), '{"fake":1}');
  const profilePath = path.join(home, 'profile.json');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  profile.peers.bob = { handle: 'bob', status: 'paired' };
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n');
  return home;
}

function snapshot(home) {
  return Object.fromEntries(fs.readdirSync(home).sort().map((name) => [name, fs.readFileSync(path.join(home, name))]));
}

for (const { argv, exit, stderr } of [
  { argv: ['init', '--rotate-key', '--openkey-api-host'], exit: 2, stderr: /--openkey-api-host needs a URL\./ },
  { argv: ['init', '--rotate-key', '--openkey-api-host', 'notaurl'], exit: 2, stderr: /--openkey-api-host needs a URL\./ },
  { argv: ['init', '--rotate-key', '--grant-file'], exit: 2, stderr: /--grant-file is required/ },
  { argv: (home) => ['init', '--rotate-key', '--grant-file', path.join(home, 'missing.json')], exit: 1, stderr: /ENOENT/ },
  { argv: ['init', '--host'], exit: 2, stderr: /--host needs a URL\./ },
  { argv: ['init', '--rotate-key', '--label'], exit: 2, stderr: /--label needs a value\./ },
]) {
  test(`init ${typeof argv === 'function' ? 'with missing grant file' : argv.slice(1).join(' ')}` , { timeout: 20_000 }, () => {
    const home = fixture();
    const before = snapshot(home);
    const result = spawnSync(process.execPath, [CLI, ...(typeof argv === 'function' ? argv(home) : argv)], {
      env: { ...process.env, COURIER_HOME: home }, encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, exit, result.stderr);
    assert.match(result.stderr, stderr);
    assert.doesNotMatch(result.stderr, /Agent key rotated/);
    assert.equal(result.stdout, '');
    assert.deepEqual(snapshot(home), before);
  });
}

test('init --resume rejects --grant-file - before reading open stdin and preserves profile bytes', { timeout: 15_000 }, async () => {
  const home = fixture();
  const before = snapshot(home);
  const startedAt = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'init', '--resume', '--grant-file', '-'], {
      env: { ...process.env, COURIER_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.signal, null);
  assert.ok(Date.now() - startedAt < 10_000);
  assert.match(result.stderr, /--resume` cannot be combined with --request, --grant-file, --paste or --rotate-key/);
  assert.equal(result.stdout, '');
  assert.deepEqual(snapshot(home), before);
});
