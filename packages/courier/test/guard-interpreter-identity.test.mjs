import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { privateScratch } from './private-scratch.mjs';
import { analyze } from '../dist/guard/policy.js';
import { decide } from '../dist/guard/hook.js';
import { realEnv } from '../dist/guard/command.js';
import { writeGuardSettings } from '../dist/guard/install.js';
import { realpathBest } from '../dist/guard/paths.js';

const CONTENT = "require('child_process').execSync('gh pr merge 5 -R a/b')";
test('N2: interpreter operands and preload files follow executable and package policy', async t => {
  const root = privateScratch('tc712-interpreter-'); const oldPath = process.env.PATH;
  try {
    const cwd = path.join(root, 'work'); const bin = path.join(root, 'bin'); const home = path.join(root, 'courier');
    fs.mkdirSync(cwd); fs.mkdirSync(bin); fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const entry = path.join(root, 'cli.js'); fs.writeFileSync(entry, 'console.log(1)');
    process.env.PATH = bin;
    writeGuardSettings({ argv: [process.execPath, entry, 'guard'], home, entry });
    const env = { ...realEnv(cwd, home, entry), literals: [], protectedRoots: [], realHome: undefined };
    fs.writeFileSync(path.join(cwd, 'm'), CONTENT);
    fs.writeFileSync(path.join(cwd, 'ok'), 'console.log(1)');
    fs.writeFileSync(path.join(cwd, 'binary'), Buffer.from([0, 1, 2]));
    const script = (name, suffix) => {
      const pkg = path.join(cwd, 'node_modules', name); const file = path.join(pkg, suffix);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name }));
      fs.writeFileSync(file, 'console.log(1)'); return file;
    };
    const paseo = script('@getpaseo/cli', 'bin/paseo');
    const cases = [
      [`node ${paseo} run hi`, 'never'],
      [`node ${script('@getpaseo/cli', 'dist/index.js')} run hi`, 'never'],
      [`node ${script('npm', 'bin/npm')} publish`, 'never'],
      ['node ./m', 'unresolved'], ['node m', 'unresolved'], ['node -r ./m -e 1', 'unresolved'],
      ['node --require=./m -e 1', 'unresolved'], ['node --import ./m -e 1', 'unresolved'],
      ['node --loader ./m -e 1', 'unresolved'], ['python3 ./m', 'unresolved'],
      ['node ./missing', 'unresolved'], ['node ./binary', 'unresolved'],
      ['python3 -m missing', 'unresolved'], ['node -r missing -e 1', 'unresolved'],
    ];
    for (const name of ['@anthropic-ai/claude-code', '@openai/codex', '@google/gemini-cli', 'opencode-ai', 'wrangler', '@phala/cli', '@tinycloud/cli', '@oh-my-pi/pi-coding-agent', 'phala']) cases.push([`node ${script(name, 'bin/run')} status`, 'never']);
    const link = path.join(bin, 'paseo-link'); fs.symlinkSync(paseo, link); cases.push([`node ${link} run hi`, 'never']);
    for (const [command, kind] of cases) await t.test(command, async () => {
      assert.ok(analyze(command, env).some(f => f.kind === kind), command + ' => ' + kind);
      assert.equal((await decide({ tool_name: 'Bash', tool_input: { command }, cwd }, { env, protectedSet: { roots: [], homes: [] } })).kind, 'deny', command);
    });
    assert.deepEqual(analyze('node ./ok', env), []);
    for (const alias of ['/usr/local/bin/paseo', '/opt/fixture/bin/npm']) {
      const file = realpathBest(alias); const manifest = path.join(path.dirname(file), 'package.json');
      const virtual = { ...env, readFile: f => f === file ? { state: 'text', text: 'console.log(1)' } : f === manifest ? { state: 'text', text: JSON.stringify({ name: alias.endsWith('npm') ? 'npm' : '@getpaseo/cli' }) } : { state: 'absent' } };
      await t.test(alias, () => assert.ok(analyze(`node ${alias} ${alias.endsWith('npm') ? 'publish' : 'run hi'}`, virtual).some(f => f.kind === 'never'), alias));
    }
  } finally { process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); }
});


test('guard startup requires an installed census', () => {
  const root = privateScratch('tc712-census-required-');
  try { assert.throws(() => realEnv(root, path.join(root, 'missing')), /invalid installed executable census/); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('hook git probes use the installed git identity', () => {
  const root = privateScratch('tc712-git-probe-'); const oldPath = process.env.PATH;
  try {
    const bin = path.join(root, 'bin'); const shadow = path.join(root, 'shadow');
    fs.mkdirSync(bin); fs.mkdirSync(shadow);
    const git = path.join(bin, 'git');
    const writeGit = (file, message) => fs.writeFileSync(file, `#!${process.execPath}\nconsole.log(${JSON.stringify(message)})\n`, { mode: 0o700 });
    writeGit(git, 'trusted'); writeGit(path.join(shadow, 'git'), 'shadow');
    process.env.PATH = bin;
    const entry = path.join(root, 'cli.js'); fs.writeFileSync(entry, 'console.log(1)');
    const home = path.join(root, 'courier'); writeGuardSettings({ argv: [process.execPath, entry, 'guard'], home, entry });
    const env = realEnv(root, home, entry); process.env.PATH = shadow + path.delimiter + bin;
    assert.equal(env.git(root, ['status']).out.trim(), 'trusted');
    writeGit(git + '.new', 'replacement'); fs.renameSync(git + '.new', git);
    assert.equal(env.git(root, ['status']).ok, false);
  } finally { process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); }
});
