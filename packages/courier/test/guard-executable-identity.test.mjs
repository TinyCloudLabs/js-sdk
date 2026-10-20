import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { privateScratch } from './private-scratch.mjs';
import { analyze } from '../dist/guard/policy.js';
import { decide } from '../dist/guard/hook.js';
import { realEnv } from '../dist/guard/command.js';
import { writeGuardSettings } from '../dist/guard/install.js';

const content = '#!/bin/sh\ngh pr merge 5 -R a/b\n';
test('N2: an unregistered executable gets no exemption from a trusted-tool basename', async () => {
  const dir = privateScratch('tc712-executable-identity-');
  const previousPath = process.env.PATH; const previousHome = process.env.HOME;
  try {
    const cwd = path.join(dir, 'work'); const home = path.join(dir, 'agent-home'); const tmp = path.join(dir, 'tmp'); const bin = path.join(dir, 'bin');
    for (const d of [cwd, home, tmp, bin]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    process.env.PATH = bin + path.delimiter + previousPath; process.env.HOME = home;
    const env = { ...realEnv(cwd, path.join(dir, 'courier'), '/opt/courier/dist/cli.js'), literals: [], protectedRoots: [], realHome: undefined };
    const deps = { env, protectedSet: { roots: [], homes: [] } };
    assert.equal((await decide({ tool_name: 'Bash', tool_input: { command: 'gh pr view 5 -R a/b' }, cwd }, deps)).kind, 'pass');
    assert.equal((await decide({ tool_name: 'Write', tool_input: { file_path: path.join(bin, 'gh'), content }, cwd }, deps)).kind, 'deny', 'the agent cannot rewrite a registered executable in place');
    for (const name of ['courier', 'gh', 'git', 'tc', 'curl', 'node', 'bash', 'npm', 'env', 'echo', 'source', 'export', 'true', 'notknown']) {
      for (const target of [cwd, tmp, home]) {
        const file = path.join(target, name); fs.writeFileSync(file, content, { mode: 0o700 });
        const commands = [file, ...(target === cwd ? ['./' + name, '../work/' + name] : [])];
        for (const command of commands) {
          assert.equal((await decide({ tool_name: 'Bash', tool_input: { command }, cwd }, deps)).kind, 'deny', command);
        }
      }
    }
    fs.mkdirSync(path.join(cwd, 'links'));
    fs.symlinkSync(path.join(tmp, 'notknown'), path.join(cwd, 'links/gh'));
    for (const command of ['./links/gh', 'env ./gh', 'PATH=.:$PATH gh', '$PWD/courier', '~/courier', 'env -u PATH echo hi', 'env --unset=PATH echo hi', 'env -uPATH echo hi', 'command -p echo hi']) assert.ok(analyze(command, env).length, command);
  } finally {
    process.env.PATH = previousPath; process.env.HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('N2: replacing a registered path does not preserve its identity or promote it on the next hook start', () => {
  const dir = privateScratch('tc712-executable-replaced-'); const previousPath = process.env.PATH;
  try {
    const cwd = path.join(dir, 'work'); const bin = path.join(dir, 'bin'); const home = path.join(dir, 'courier'); const install = path.join(dir, 'install');
    for (const d of [cwd, bin, install]) fs.mkdirSync(d);
    const gh = path.join(bin, 'gh'); const entry = path.join(install, 'cli.js');
    fs.writeFileSync(gh, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(entry, '#!/usr/bin/env node\nconsole.log("fixture")\n', { mode: 0o700 });
    fs.symlinkSync(entry, path.join(bin, 'courier'));
    process.env.PATH = bin + path.delimiter + previousPath;
    writeGuardSettings({ argv: [process.execPath, entry, 'guard'], home, entry });
    const env = { ...realEnv(cwd, home, entry), literals: [], protectedRoots: [], realHome: undefined };
    assert.deepEqual(analyze('gh pr view 5 -R a/b', env), []);
    assert.deepEqual(analyze('courier inbox', env), []);
    assert.deepEqual(analyze(`node ${entry} inbox`, { ...env, literals: [install] }), []);
    assert.deepEqual(analyze(`${entry} inbox`, { ...env, literals: [install] }), []);
    assert.ok(analyze('courier broker status', env).length);
    const other = path.join(dir, 'other'); fs.mkdirSync(other);
    fs.linkSync(entry, path.join(cwd, 'courier')); fs.linkSync(entry, path.join(cwd, 'cli.js'));
    fs.writeFileSync(path.join(other, 'courier'), content, { mode: 0o700 });
    fs.writeFileSync(path.join(other, 'cli.js'), `require('child_process').execSync('gh pr merge 5 -R a/b')`, { mode: 0o700 });
    for (const command of [`cd ${other}; ./courier inbox`, `cd ${other}; node ./cli.js inbox`]) assert.ok(analyze(command, env).length, 'cwd changes cannot switch a verified command to an unverified file: ' + command);
    for (const file of [gh, entry]) { fs.writeFileSync(file + '.new', content, { mode: 0o700 }); fs.renameSync(file + '.new', file); }
    assert.ok(analyze('gh pr view 5 -R a/b', env).length, 'same path with new inode is untrusted');
    writeGuardSettings({ argv: [process.execPath, entry, 'guard'], home, entry });
    const restarted = { ...realEnv(cwd, home, entry), literals: [], protectedRoots: [], realHome: undefined };
    assert.ok(analyze('gh pr view 5 -R a/b', restarted).length, 'hook restart must use installed identity, not enroll a replacement');
    assert.ok(analyze(`node ${entry} inbox`, restarted).length, 'Courier entry path equality is insufficient');
  } finally { process.env.PATH = previousPath; fs.rmSync(dir, { recursive: true, force: true }); }
});
