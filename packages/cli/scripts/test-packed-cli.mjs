import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const temp = mkdtempSync(join(tmpdir(), 'tc-packed-cli-'));
const cliRoot = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(TC_|TINYCLOUD_|NODE_AUTH_TOKEN$|NPM_TOKEN$|npm_config_)/i.test(name)));
env.TC_HOME = join(temp, 'profiles');
env.NPM_CONFIG_USERCONFIG = '/dev/null';
env.NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/';
try {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], { cwd: cliRoot, env, encoding: 'utf8' }));
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ name: 'packed-cli-check', version: '1.0.0', private: true }));
  execFileSync('npm', ['install', '--prefix', temp, '--ignore-scripts', '--no-audit', '--no-fund', join(temp, packed.filename)], { cwd: temp, env, encoding: 'utf8' });
  const executable = join(temp, 'node_modules/@tinycloud/cli/bin/tc');
  const run = (...args) => execFileSync(process.execPath, [executable, ...args], { cwd: temp, env, encoding: 'utf8' });
  assert.equal(run('--version').trim(), pkg.version);
  const help = run('auth', 'login', '--help');
  for (const option of ['--manifest', '--owner', '--expiry', '--paste']) assert.ok(help.includes(option), `Missing ${option}`);
  run('init', '--name', 'clean-install', '--host', 'https://node.example.test', '--key-only');
  const context = JSON.parse(run('--profile', 'clean-install', '--host', 'https://selected.example.test', 'context'));
  assert.equal(context.profile, 'clean-install');
  assert.equal(context.host, 'https://selected.example.test');
  assert.equal(context.session.state, 'missing');
  assert.equal(context.access, 'not-tested');
  assert.equal(context.cliVersion, pkg.version);
  const { NodeWasmBindings, PrivateKeySigner } = createRequire(join(temp, 'package.json'))('@tinycloud/node-sdk');
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner('4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f');
  const address = await signer.getAddress();
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const key = JSON.parse(readFileSync(join(env.TC_HOME, '.tinycloud/profiles/clean-install/key.json'), 'utf8'));
  const spaceId = wasm.makeSpaceId(address, 1, 'applications');
  const prepared = wasm.prepareSession({ abilities: { kv: { 'example/': ['tinycloud.kv/get'] } }, address, chainId: 1, domain: 'cli.example.test', spaceId, jwk: key,
    issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 3600_000).toISOString() });
  const signature = await signer.signMessage(prepared.siwe);
  const proof = { ...wasm.completeSessionSetup({ ...prepared, signature }), address, chainId: 1, spaceId, ownerDid, siwe: prepared.siwe, signature };
  const manifest = join(temp, 'read.manifest.json');
  writeFileSync(manifest, JSON.stringify({ app_id: 'example', space: 'applications', permissions: [{ service: 'kv', path: '', actions: ['get'] }] }));
  const login = JSON.parse(execFileSync(process.execPath, [executable, '--profile', 'clean-install', '--host', 'https://node.example.test', 'auth', 'login', '--method', 'openkey', '--manifest', manifest, '--owner', ownerDid, '--expiry', '1h', '--paste'], {
    cwd: temp, env, encoding: 'utf8', input: JSON.stringify(proof) + '\n', stdio: ['pipe', 'pipe', 'pipe'],
  }));
  assert.equal(login.scoped, true);
  assert.deepEqual(login.permissions, [{ service: 'tinycloud.kv', space: spaceId, path: 'example/', actions: ['tinycloud.kv/get'] }]);
  assert.equal(login.ownerDid, ownerDid);
  assert.equal(JSON.parse(run('--profile', 'clean-install', '--host', 'https://node.example.test', 'context', '--space', 'applications')).session.state, 'present');

  const installed = join(temp, 'node_modules/@tinycloud/cli/skills/tc-cli');
  for (const file of ['SKILL.md', 'AUTH.md', 'INSTALL.md', 'REFERENCE.md', 'SDK.md', 'release.json']) assert.ok(existsSync(join(installed, file)), `Missing ${file}`);
  assert.equal(JSON.parse(readFileSync(join(installed, 'release.json'), 'utf8')).version, pkg.version);
  console.log(JSON.stringify({ package: `${pkg.name}@${pkg.version}`, checks: ['anonymous-public-dependencies', 'packed-install', 'version', 'scoped-login-help', 'fresh-context', 'synthetic-scoped-paste-login', 'skill-resources'], passed: true }));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
