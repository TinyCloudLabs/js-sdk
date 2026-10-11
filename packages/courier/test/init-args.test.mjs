import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
