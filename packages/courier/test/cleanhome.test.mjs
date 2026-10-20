import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareCleanHome } from '../dist/guard/cleanhome.js';
import { courierOnlyEnv, courierEnvOverrides, agentHomeEnv } from '../dist/guard/install.js';

test('clean HOME exposes only the minimal dummy login and git identity; shell/XDG credentials stay out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanhome-'));
  try {
    const realHome = path.join(dir, 'owner'); const courier = path.join(dir, 'courier');
    fs.mkdirSync(path.join(realHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(realHome, '.claude/.credentials.json'), '{"dummy":"dummy-login"}');
    fs.writeFileSync(path.join(realHome, '.claude.json'), '{"mcpServers":{"evil":{}}}');
    for (const name of ['.bashrc', '.profile', '.bash_profile', '.zshenv']) fs.writeFileSync(path.join(realHome, name), 'export DUMMY_API_TOKEN=dummy-secret\n');
    fs.writeFileSync(path.join(realHome, '.gitconfig'), '[user]\n name=Dummy\n email=dummy@example.invalid\n[credential]\n helper=evil\n');
    const base = { PATH: process.env.PATH, HOME: realHome, DUMMY_API_TOKEN: 'dummy', XDG_CONFIG_HOME: realHome, XDG_RUNTIME_DIR: realHome, XDG_UNKNOWN: realHome, BASH_ENV: path.join(realHome, '.bashrc'), ENV: path.join(realHome, '.profile'), NODE_OPTIONS: '--require evil', COURIER_HOME: courier, TC_HOME: path.join(dir, 'tc') };
    const env = courierOnlyEnv(base, courier);
    const built = prepareCleanHome({ realHome, cleanHome: env.HOME });
    assert.deepEqual(built.exposed, ['.claude/.credentials.json', '.gitconfig (user.name, user.email)']);
    assert.equal(fs.statSync(path.join(env.HOME, '.claude/.credentials.json')).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(env.HOME, '.claude.json')), false);
    assert.ok(!fs.readFileSync(path.join(env.HOME, '.gitconfig'), 'utf8').includes('helper'));
    for (const args of [['-lc', 'test -z "$DUMMY_API_TOKEN"'], ['-ic', 'test -z "$DUMMY_API_TOKEN"']]) assert.equal(spawnSync('bash', args, { env }).status, 0);
    assert.equal(spawnSync('sh', ['-lc', 'test -z "$DUMMY_API_TOKEN"'], { env }).status, 0);
    assert.equal(env.DUMMY_API_TOKEN, undefined); assert.equal(env.XDG_UNKNOWN, undefined);
    for (const [name, value] of Object.entries(agentHomeEnv(courier))) assert.equal(env[name], value);
    const overrides = courierEnvOverrides(base, courier);
    for (const name of ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'XDG_UNKNOWN', 'DUMMY_API_TOKEN']) assert.equal(overrides[name], '', name);
    assert.equal(overrides.XDG_RUNTIME_DIR, path.join(env.HOME, '.runtime'));
    fs.writeFileSync(path.join(env.HOME, '.bashrc'), 'export DUMMY_API_TOKEN=dummy');
    fs.writeFileSync(path.join(env.HOME, '.claude.json'), '{}');
    prepareCleanHome({ realHome, cleanHome: env.HOME, claude: false });
    assert.equal(fs.existsSync(path.join(env.HOME, '.bashrc')), false);
    assert.equal(fs.existsSync(path.join(env.HOME, '.claude.json')), false);
    assert.equal(fs.existsSync(path.join(env.HOME, '.claude/.credentials.json')), false, 'exec receives no model login');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
