import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const PKG = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

test('courier --version prints the package version and exits 0', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-version-'));
  try {
    const result = spawnSync(process.execPath, [CLI, '--version'], {
      env: { ...process.env, COURIER_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${PKG.version}\n`);
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
