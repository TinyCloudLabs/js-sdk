import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { credentialTextRefusal, protectedTextRefusal, isProtectedFile, installRoots } from '../dist/guard/paths.js';
import { decide } from '../dist/guard/hook.js';

test('credential paths, globs, find, proc environments and token-printing tools are refused', () => {
  for (const text of ['cat ~/.config/g*/hosts.yml', 'cat ~/.n"p"mrc', 'cat ~/.n\\pmrc', 'base64 ~/.npmrc', 'find /home/u -name hosts.yml -exec cat {} +', 'cat /proc/1234/environ', 'cat /proc/*/environ', 'gh auth token', '/usr/bin/gh auth token', 'git credential fill', 'npm config get //registry.npmjs.org/:_authToken', 'cat ~/.paseo/config.json', 'cat /private/broker/gh.json']) assert.ok(credentialTextRefusal(text), text);
  assert.equal(credentialTextRefusal('cat README.md'), undefined);
  for (const text of ['echo x > .claude/settings.local.json', 'cat .mcp.json', 'tee .git/hooks/pre-push', 'cat /opt/courier/dist/index.js']) assert.ok(protectedTextRefusal(text, ['/opt/courier']), text);
});

test('edit tools protect ancestor settings, real home, install dependencies and symlinks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-paths-'));
  try {
    const cwd = path.join(dir, 'repo/sub'); const home = path.join(dir, 'courier');
    fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(home);
    fs.symlinkSync(home, path.join(dir, 'alias'));
    const pkg = path.join(dir, 'install/courier'); const entry = path.join(pkg, 'dist/cli.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, ''); fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    fs.mkdirSync(path.join(pkg, 'node_modules'));
    const set = { roots: [home, ...installRoots(entry)], homes: [path.join(dir, 'owner')] };
    const env = { cwd, readFile: () => ({ state: 'absent' }), git: () => ({ ok: false, out: '' }), getenv: () => undefined };
    for (const file of [path.join(dir, 'repo/.claude/settings.json'), path.join(cwd, '.claude/settings.local.json'), path.join(cwd, '.mcp.json'), path.join(dir, 'owner/.claude/settings.json'), path.join(pkg, 'node_modules/@tinycloud/node-sdk/dist/index.js'), path.join(dir, 'alias/guard/settings.json'), path.join(cwd, '.git/config'), path.join(cwd, '.git/hooks/pre-push')]) {
      assert.equal(isProtectedFile(file, cwd, set), true, file);
      for (const tool_name of ['Write', 'Edit', 'NotebookEdit']) assert.equal((await decide({ tool_name, tool_input: { file_path: file }, cwd }, { env, protectedSet: set })).kind, 'deny', `${tool_name}: ${file}`);
    }
    assert.equal(isProtectedFile(path.join(cwd, 'src/x.ts'), cwd, set), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
