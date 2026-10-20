import { privateScratch } from './private-scratch.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyze } from '../dist/guard/policy.js';
import { realEnv } from '../dist/guard/command.js';
import { writeGuardSettings } from '../dist/guard/install.js';

test('N2: executable aliases, hardlinks and copies cannot hide gated tools', () => {
  const dir = privateScratch('tc712-n2-');
  const previous = process.env.PATH;
  try {
    const bin = path.join(dir, 'bin'); const cwd = path.join(dir, 'work'); fs.mkdirSync(bin); fs.mkdirSync(cwd);
    for (const tool of ['gh', 'paseo', 'tc', 'curl']) fs.writeFileSync(path.join(bin, tool), '\x7fELF\0' + tool, { mode: 0o700 });
    process.env.PATH = bin + path.delimiter + cwd;
    writeGuardSettings({ argv: [process.execPath, '/opt/courier/dist/cli.js', 'guard'], home: path.join(dir, 'courier'), entry: '/opt/courier/dist/cli.js' });
    const env = realEnv(cwd, path.join(dir, 'courier'), '/opt/courier/dist/cli.js');
    fs.symlinkSync(path.join(bin, 'gh'), path.join(cwd, 'hub'));
    fs.linkSync(path.join(bin, 'paseo'), path.join(cwd, 'runner'));
    fs.linkSync(path.join(bin, 'tc'), path.join(cwd, 'ownercli'));
    fs.copyFileSync(path.join(bin, 'gh'), path.join(cwd, 'copy'));
    for (const command of ['./hub pr merge 5 -R a/b', './runner run hi', './ownercli kv list', './copy pr merge 5 -R a/b', './copy auth login --with-token < t', 'copy auth login --with-token < t', 'cp -r ' + bin + ' ./tools', 'node ' + bin + '/paseo run hi', 'ln -s ' + bin + '/gh ./hub', 'ln ' + bin + '/paseo ./p', 'cp --reflink=auto ' + bin + '/gh ./x', 'install ' + bin + '/tc ./t', 'mv ' + bin + '/curl ./c', 'hardlink ' + bin + '/gh ./h', 'PATH=./bin gh pr merge 5 -R a/b']) {
      assert.ok(analyze(command, env).length, command);
    }
    fs.renameSync(path.join(bin, 'paseo'), path.join(cwd, 'renamed'));
    assert.ok(analyze('./renamed run hi', env).length, 'saved inode survives rename');
  } finally { process.env.PATH = previous; fs.rmSync(dir, { recursive: true, force: true }); }
});
