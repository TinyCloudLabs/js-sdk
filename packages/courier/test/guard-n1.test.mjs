import { privateScratch } from './private-scratch.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { courierOnlyEnv, courierEnvOverrides } from '../dist/guard/install.js';
import { analyze } from '../dist/guard/policy.js';
import { decide } from '../dist/guard/hook.js';

const fixture = () => privateScratch('tc712-n1-');
test('N1: no broker/Courier roots in agent environment; HOME/XDG/TMP and tc profile are separate', () => {
  const dir = fixture();
  try {
    const home = path.join(dir, 'courier');
    const base = { HOME: path.join(dir, 'owner'), COURIER_HOME: home, COURIER_REAL_HOME: path.join(dir, 'owner'), COURIER_BROKER_DIR: path.join(dir, 'private'), TMPDIR: home };
    const env = courierOnlyEnv(base, home);
    assert.equal(env.COURIER_HOME, undefined);
    assert.equal(env.COURIER_REAL_HOME, undefined);
    for (const value of Object.values(env)) assert.ok(!value.includes(home + '/'), value);
    assert.ok(!env.HOME.startsWith(home + '/'));
    assert.ok(env.TMPDIR.startsWith(env.HOME + '/'));
    const overrides = courierEnvOverrides(base, home);
    for (const name of ['COURIER_HOME', 'COURIER_REAL_HOME', 'COURIER_BROKER_DIR']) assert.equal(overrides[name], '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('N1: file tools and Bash cannot traverse or search protected roots or their parents', async () => {
  const dir = fixture();
  try {
    const courier = path.join(dir, 'private/courier'); const broker = path.join(dir, 'owner-private/config'); const cwd = path.join(dir, 'work'); const agent = path.join(dir, 'agent');
    for (const d of [courier, broker, cwd, agent]) fs.mkdirSync(d, { recursive: true });
    fs.symlinkSync(courier, path.join(cwd, 'shortcut'));
    const env = { cwd, literals: [courier], protectedRoots: [courier, broker], realHome: path.join(dir, 'owner'), getenv: n => n === 'HOME' ? agent : undefined, readFile: () => ({ state: 'absent' }), git: () => ({ ok: false, out: '' }) };
    const deps = { env, protectedSet: { roots: [courier, broker], homes: [env.realHome, agent], realHome: env.realHome } };
    for (const tool_name of ['Read', 'Grep', 'Glob']) for (const file of [courier, broker, path.dirname(broker), path.join(courier, 'key.json'), path.dirname(courier), path.join(cwd, 'shortcut')]) {
      assert.equal((await decide({ tool_name, tool_input: { path: file, pattern: '**/*.json' }, cwd }, deps)).kind, 'deny', tool_name + ' ' + file);
    }
    for (const command of ['grep -r ghp_ ~/../..', 'cat $COURIER_HOME/broker/*', 'cat ~/../../broker/*', 'find / -name host?.yml', 'grep -r ghp_ /', 'ls ~/..', 'ls $HOME/..', 'cat shortcut/key.json', 'ls ' + path.dirname(courier)]) {
      assert.ok(analyze(command, env).length, command);
    }
    assert.equal((await decide({ tool_name: 'Read', tool_input: { path: path.join(cwd, 'src.js') }, cwd }, deps)).kind, 'pass');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('N1: a blanked Paseo COURIER_HOME discovers only the clean-home snapshot', async () => {
  const { profileDir } = await import('../dist/profile.js');
  const previousHome = process.env.HOME; const previousCourier = process.env.COURIER_HOME;
  try {
    process.env.HOME = path.join(process.env.COURIER_TEST_HOME, 'private-agent-home'); process.env.COURIER_HOME = '';
    assert.equal(profileDir(), path.join(process.env.COURIER_TEST_HOME, 'private-agent-home', '.courier'));
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousCourier === undefined) delete process.env.COURIER_HOME; else process.env.COURIER_HOME = previousCourier;
  }
});
