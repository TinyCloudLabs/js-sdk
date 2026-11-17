import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CHECK_INTERVAL_MS, REEXEC_ENV, WAKE_CHILD_ENV, checkForUpdate, compareSemver, detectInstall, installCommand, isStable, runOnNewVersion, stripOptOutFlag,
} from '../dist/auto-update.js';
import { courierEnvOverrides, courierOnlyEnv } from '../dist/guard/install.js';

const REGISTRY = 'https://registry.npmjs.org';
const LATEST_URL = `${REGISTRY}/@tinycloud%2fcourier/latest`;
const REPO = 'https://github.com/TinyCloudLabs/js-sdk';
const SLSA = 'https://slsa.dev/provenance/v1';
const TARBALL = Buffer.from('pretend tarball bytes');
const STATE = () => path.join(process.env.COURIER_HOME, 'update-check.json');

function integrityOf(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/** `<root>/lib/node_modules/@tinycloud/courier`: an npm global prefix holding the running copy. */
function globalInstall(version = '0.6.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-'));
  const modules = path.join(root, 'lib', 'node_modules');
  const pkg = path.join(modules, '@tinycloud', 'courier');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@tinycloud/courier', version }));
  fs.writeFileSync(path.join(pkg, 'dist', 'cli.js'), '');
  return { root, modules, pkg: fs.realpathSync(pkg) };
}

function attestations(version, bytes, { repository = REPO, digest } = {}) {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `pkg:npm/%40tinycloud/courier@${version}`, digest: { sha512: digest ?? createHash('sha512').update(bytes).digest('hex') } }],
    predicateType: SLSA,
    predicate: { buildDefinition: { externalParameters: { workflow: { repository, path: '.github/workflows/changesets.yml' } } } },
  };
  const envelope = (s) => ({ bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(s)).toString('base64') } } });
  return { attestations: [{ predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', ...envelope({}) }, { predicateType: SLSA, ...envelope(statement) }] };
}

/**
 * A fake registry, disk and package manager. `latest` is the dist-tag document; `served` the bytes the tarball URL sends.
 * The package-manager stub records every call and, for the install into the real location, writes the new package.json.
 */
function world(options = {}) {
  const version = options.latest ?? '0.6.1';
  const served = options.served ?? TARBALL;
  const install = options.install ?? globalInstall(options.running ?? '0.6.0');
  const calls = [];
  const fetched = [];
  const logs = [];
  let clock = options.now ?? 1_800_000_000_000;
  const latestDoc = {
    name: '@tinycloud/courier',
    version,
    dist: {
      tarball: `${REGISTRY}/@tinycloud/courier/-/courier-${version}.tgz`,
      integrity: integrityOf(TARBALL),
      ...(options.provenance === false ? {} : { attestations: { url: 'x', provenance: { predicateType: SLSA } } }),
      ...options.dist,
    },
    ...options.doc,
  };
  const fakeFetch = async (url) => {
    fetched.push(String(url));
    if (options.offline) throw new TypeError('fetch failed');
    if (url === LATEST_URL) return new Response(JSON.stringify(latestDoc));
    if (url === `${REGISTRY}/-/npm/v1/attestations/@tinycloud%2fcourier@${version}`) {
      return new Response(JSON.stringify(attestations(version, TARBALL, options.attestation)));
    }
    if (url === latestDoc.dist.tarball) return new Response(served);
    return new Response('nope', { status: 404 });
  };
  const run = async (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd });
    if (command === 'npm' && args.includes('--prefix') && args[args.indexOf('--prefix') + 1] !== install.root) {
      return { code: options.stageFails ? 1 : 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'audit') {
      return options.auditFails ? { code: 1, stdout: '{"invalid":[{"name":"x"}],"missing":[]}', stderr: '' } : { code: 0, stdout: '{"invalid":[],"missing":[]}', stderr: '' };
    }
    // The install into the real location: npm puts the requested version there.
    const wanted = args.find((a) => a.startsWith('@tinycloud/courier@')).split('@').pop();
    const landed = options.landsAs ?? wanted;
    fs.writeFileSync(path.join(install.pkg, 'package.json'), JSON.stringify({ name: '@tinycloud/courier', version: landed }));
    if (options.recordedIntegrity) {
      fs.writeFileSync(path.join(install.modules, '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/@tinycloud/courier': { integrity: options.recordedIntegrity } } }));
    }
    return { code: options.installFails ? 1 : 0, stdout: '', stderr: '' };
  };
  const deps = {
    env: options.env ?? {},
    now: () => clock,
    version: options.running ?? '0.6.0',
    packageRoot: install.pkg,
    fetch: fakeFetch,
    run,
    log: (line) => logs.push(line),
  };
  return { deps, calls, fetched, logs, install, advance: (ms) => { clock += ms; }, check: (argv = ['inbox'], flag = false) => checkForUpdate(argv, deps, flag) };
}

test.beforeEach(() => { fs.rmSync(STATE(), { force: true }); });

const realInstalls = (w) => w.calls.filter((c) => c.cwd === w.install.root);

test('a newer stable release is verified, installed where the running copy lives, and re-run', async () => {
  const w = world();
  const result = await w.check(['watch', '--wake', 'none']);
  assert.equal(result.kind, 'updated');
  assert.equal(result.to, '0.6.1');
  assert.equal(result.entry, fs.realpathSync(path.join(w.install.pkg, 'dist', 'cli.js')));
  const [install] = realInstalls(w);
  assert.deepEqual(install.args.slice(0, 4), ['install', '--global', '--prefix', w.install.root]);
  assert.ok(install.args.includes('@tinycloud/courier@0.6.1'));
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /updated 0\.6\.0 → 0\.6\.1 \(npm global\)/);
  // Verified on a staged copy first, with the signature audit.
  assert.ok(w.calls.some((c) => c.args[0] === 'audit' && c.args[1] === 'signatures'));
  assert.ok(w.calls.some((c) => c.args.includes('--ignore-scripts')));
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('courier-update-')), []);
});

test('the same or an older release changes nothing and says nothing', async () => {
  for (const latest of ['0.6.0', '0.5.3']) {
    fs.rmSync(STATE(), { force: true });
    const w = world({ latest });
    assert.equal((await w.check()).kind, 'none');
    assert.deepEqual(w.logs, []);
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.fetched, [LATEST_URL]);
  }
});

test('a prerelease on latest is never installed', async () => {
  for (const latest of ['0.7.0-beta.3', '0.7.0-rc.1', '1.0.0-0']) {
    fs.rmSync(STATE(), { force: true });
    const w = world({ latest });
    assert.equal((await w.check()).kind, 'none');
    assert.deepEqual(w.logs, []);
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.fetched, [LATEST_URL]);
  }
});

test('a beta moves to the stable release of the same version and never to an older stable one', async () => {
  const up = world({ running: '0.6.0-beta.47', latest: '0.6.0' });
  assert.equal((await up.check()).kind, 'updated');
  fs.rmSync(STATE(), { force: true });
  const down = world({ running: '0.6.0-beta.47', latest: '0.5.3' });
  assert.equal((await down.check()).kind, 'none');
  assert.deepEqual(down.calls, []);
});

test('semver precedence', () => {
  assert.ok(compareSemver('0.6.1', '0.6.0') > 0);
  assert.ok(compareSemver('0.10.0', '0.9.9') > 0);
  assert.ok(compareSemver('0.6.0', '0.6.0-beta.47') > 0);
  assert.ok(compareSemver('0.6.0-beta.10', '0.6.0-beta.9') > 0);
  assert.ok(compareSemver('0.6.0-beta.9', '0.6.0-beta') > 0);
  assert.ok(compareSemver('0.6.0-1', '0.6.0-a') < 0);
  assert.equal(compareSemver('1.2.3+build.5', '1.2.3'), 0);
  assert.equal(isStable('1.2.3'), true);
  assert.equal(isStable('1.2.3-rc.1'), false);
  assert.equal(isStable('latest'), false);
});

test('a tarball whose hash is not the registry integrity is refused', async () => {
  const w = world({ served: Buffer.from('something else') });
  const result = await w.check();
  assert.equal(result.kind, 'none');
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /refused @tinycloud\/courier@0\.6\.1: .*integrity.*staying on 0\.6\.0/);
  assert.deepEqual(realInstalls(w), []);
  assert.deepEqual(w.calls, []);
});

test('a registry document without sha512 integrity or from another host is refused', async () => {
  const noHash = world({ dist: { integrity: 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=' } });
  assert.equal((await noHash.check()).kind, 'none');
  assert.match(noHash.logs[0], /refused .*sha512/);
  fs.rmSync(STATE(), { force: true });
  const elsewhere = world({ dist: { tarball: 'https://evil.example/courier-0.6.1.tgz' } });
  assert.equal((await elsewhere.check()).kind, 'none');
  assert.match(elsewhere.logs[0], /refused .*npm registry/);
  assert.deepEqual(elsewhere.fetched, [LATEST_URL]);
});

test('a release with no npm provenance is refused', async () => {
  const w = world({ provenance: false });
  assert.equal((await w.check()).kind, 'none');
  assert.deepEqual(w.logs, ['no npm provenance for 0.6.1, staying on 0.6.0']);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(w.fetched, [LATEST_URL]);
});

test('provenance for another tarball or another repository is refused', async () => {
  const other = world({ attestation: { digest: createHash('sha512').update('other').digest('hex') } });
  assert.equal((await other.check()).kind, 'none');
  assert.match(other.logs[0], /refused .*different tarball/);
  assert.deepEqual(other.calls, []);
  fs.rmSync(STATE(), { force: true });
  const fork = world({ attestation: { repository: 'https://github.com/someone/else' } });
  assert.equal((await fork.check()).kind, 'none');
  assert.match(fork.logs[0], /refused .*built from https:\/\/github\.com\/someone\/else/);
  assert.deepEqual(fork.calls, []);
});

test('a failing signature audit refuses the release and removes the staged copy', async () => {
  const w = world({ auditFails: true });
  assert.equal((await w.check()).kind, 'none');
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /refused .*npm audit signatures/);
  assert.deepEqual(realInstalls(w), []);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('courier-update-')), []);
});

test('an install that lands a different version or integrity is rolled back', async () => {
  const wrongVersion = world({ landsAs: '0.6.2' });
  assert.equal((await wrongVersion.check()).kind, 'none');
  assert.equal(wrongVersion.logs.length, 1);
  assert.match(wrongVersion.logs[0], /auto-update failed/);
  const installs = realInstalls(wrongVersion);
  assert.equal(installs.length, 2);
  assert.ok(installs[1].args.includes('@tinycloud/courier@0.6.0'));

  fs.rmSync(STATE(), { force: true });
  const wrongHash = world({ recordedIntegrity: integrityOf(Buffer.from('swapped')) });
  assert.equal((await wrongHash.check()).kind, 'none');
  assert.equal(realInstalls(wrongHash).length, 2);
});

test('an unreachable registry is one log line and the command goes on', async () => {
  const w = world({ offline: true });
  assert.equal((await w.check()).kind, 'none');
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /registry unreachable.*staying on 0\.6\.0/);
  assert.deepEqual(w.calls, []);
});

test('no write permission to the install is one log line with the command to run by hand', { skip: process.getuid?.() === 0 }, async () => {
  const w = world();
  fs.chmodSync(w.install.modules, 0o555);
  try {
    assert.equal((await w.check()).kind, 'none');
  } finally {
    fs.chmodSync(w.install.modules, 0o755);
  }
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /not writable/);
  assert.match(w.logs[0], /run: npm install --global --prefix \S+ @tinycloud\/courier@0\.6\.1/);
  assert.deepEqual(w.calls, []);
});

test('CI, the opt-out variable and the opt-out flag each skip with one line and no network', async () => {
  for (const [env, flag, pattern] of [
    [{ CI: 'true' }, false, /running under CI/],
    [{ COURIER_NO_AUTO_UPDATE: '1' }, false, /COURIER_NO_AUTO_UPDATE is set/],
    [{}, true, /--no-auto-update/],
  ]) {
    const w = world({ env });
    assert.equal((await w.check(['inbox'], flag)).kind, 'none');
    assert.equal(w.logs.length, 1);
    assert.match(w.logs[0], pattern);
    assert.deepEqual(w.fetched, []);
    assert.equal(fs.existsSync(STATE()), false);
  }
  // Not set, empty, or 0 is not an opt-out.
  for (const env of [{ CI: '' }, { CI: 'false' }, { COURIER_NO_AUTO_UPDATE: '0' }]) {
    const w = world({ env, latest: '0.6.0' });
    await w.check();
    assert.deepEqual(w.fetched, [LATEST_URL]);
    fs.rmSync(STATE(), { force: true });
  }
});

test('a wake-adapter child, a re-executed process and informational commands never check', async () => {
  for (const [env, argv] of [
    [{ [WAKE_CHILD_ENV]: '1' }, ['inbox']],
    [{ [REEXEC_ENV]: '1' }, ['inbox']],
    [{}, ['--version']],
    [{}, []],
    [{}, ['send', '--help']],
    [{}, ['guard']],
    [{}, ['run-approved', 'abc']],
  ]) {
    const w = world({ env });
    assert.equal((await w.check(argv)).kind, 'none');
    assert.deepEqual(w.logs, []);
    assert.deepEqual(w.fetched, []);
  }
});

test('the environment a woken agent gets says so', () => {
  assert.equal(courierOnlyEnv({ PATH: '/bin' }, '/var/tmp/home-x').COURIER_WAKE_CHILD, '1');
  assert.equal(courierEnvOverrides({ PATH: '/bin' }, '/var/tmp/home-x').COURIER_WAKE_CHILD, '1');
  assert.equal(WAKE_CHILD_ENV, 'COURIER_WAKE_CHILD');
});

test('at most one registry check per install per 24 hours', async () => {
  const w = world({ latest: '0.6.0' });
  await w.check();
  await w.check();
  assert.equal(w.fetched.length, 1, 'the second start within a day does not ask the registry');
  const state = JSON.parse(fs.readFileSync(STATE(), 'utf8'));
  assert.equal(state.install, w.install.pkg);

  w.advance(CHECK_INTERVAL_MS - 1);
  await w.check();
  assert.equal(w.fetched.length, 1);
  w.advance(1);
  await w.check();
  assert.equal(w.fetched.length, 2);

  // Another install under the same Courier home has its own slot.
  const second = world({ latest: '0.6.0', now: w.deps.now() });
  await second.check();
  assert.equal(second.fetched.length, 1);
});

test('a failed check also uses up the day, so an offline machine is not delayed on every start', async () => {
  const w = world({ offline: true });
  await w.check();
  await w.check();
  assert.equal(w.fetched.length, 1);
  assert.equal(w.logs.length, 1);
});

test('a copy that is not an installed package (source checkout, npx cache) is left alone', async () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'au-'));
  fs.mkdirSync(path.join(checkout, 'packages', 'courier'), { recursive: true });
  assert.equal(detectInstall(path.join(checkout, 'packages', 'courier')), undefined);
  const npx = path.join(checkout, '.npm', '_npx', 'abc', 'node_modules', '@tinycloud', 'courier');
  fs.mkdirSync(npx, { recursive: true });
  fs.writeFileSync(path.join(checkout, '.npm', '_npx', 'abc', 'package.json'), '{}');
  assert.equal(detectInstall(npx), undefined);
  // Silent even under CI or an opt-out: a source checkout is not something that updates itself.
  const w = world({ env: { CI: 'true', COURIER_NO_AUTO_UPDATE: '1' }, install: { root: checkout, modules: checkout, pkg: path.join(checkout, 'packages', 'courier') } });
  assert.equal((await w.check()).kind, 'none');
  assert.deepEqual(w.fetched, []);
  assert.deepEqual(w.logs, []);
});

test('install detection: global prefix, app directory, and each package manager', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-'));
  const make = (...parts) => {
    const dir = path.join(root, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync(dir);
  };
  const touch = (dir, name) => fs.writeFileSync(path.join(dir, name), '');

  const npmGlobal = make('prefix', 'lib', 'node_modules', '@tinycloud', 'courier');
  assert.deepEqual(detectInstall(npmGlobal), { manager: 'npm', scope: 'global', root: path.join(root, 'prefix'), modulesDir: path.join(root, 'prefix', 'lib', 'node_modules') });

  const app = make('opt', 'courier', 'app', 'node_modules', '@tinycloud', 'courier');
  touch(path.join(root, 'opt', 'courier', 'app'), 'package.json');
  assert.deepEqual(detectInstall(app), { manager: 'npm', scope: 'local', root: path.join(root, 'opt', 'courier', 'app'), modulesDir: path.join(root, 'opt', 'courier', 'app', 'node_modules') });
  touch(path.join(root, 'opt', 'courier', 'app'), 'pnpm-lock.yaml');
  assert.equal(detectInstall(app).manager, 'pnpm');
  fs.rmSync(path.join(root, 'opt', 'courier', 'app', 'pnpm-lock.yaml'));
  touch(path.join(root, 'opt', 'courier', 'app'), 'yarn.lock');
  assert.equal(detectInstall(app).manager, 'yarn');
  fs.rmSync(path.join(root, 'opt', 'courier', 'app', 'yarn.lock'));
  touch(path.join(root, 'opt', 'courier', 'app'), 'bun.lock');
  assert.equal(detectInstall(app).manager, 'bun');
  touch(path.join(root, 'opt', 'courier', 'app'), '.yarnrc.yml');
  assert.ok('unsupported' in detectInstall(app));

  const bunGlobal = make('home', '.bun', 'install', 'global', 'node_modules', '@tinycloud', 'courier');
  assert.equal(detectInstall(bunGlobal).manager, 'bun');
  assert.equal(detectInstall(bunGlobal).scope, 'global');

  const pnpmGlobal = make('home', '.local', 'share', 'pnpm', 'global', '5', 'node_modules', '.pnpm', '@tinycloud+courier@0.6.0', 'node_modules', '@tinycloud', 'courier');
  assert.deepEqual(detectInstall(pnpmGlobal), {
    manager: 'pnpm', scope: 'global', root: path.join(root, 'home', '.local', 'share', 'pnpm', 'global', '5'), modulesDir: path.join(root, 'home', '.local', 'share', 'pnpm', 'global', '5', 'node_modules'),
  });
});

test('each package manager installs the exact version where it was installed', () => {
  const at = (manager, scope) => installCommand({ manager, scope, root: '/r', modulesDir: '/r/node_modules' }, '0.6.1');
  const reg = ['--registry', 'https://registry.npmjs.org/'];
  const spec = '@tinycloud/courier@0.6.1';
  assert.deepEqual(at('npm', 'global'), { command: 'npm', args: ['install', '--global', '--prefix', '/r', spec, '--no-audit', '--no-fund', ...reg] });
  assert.deepEqual(at('npm', 'local'), { command: 'npm', args: ['install', '--prefix', '/r', spec, '--no-audit', '--no-fund', ...reg] });
  assert.deepEqual(at('pnpm', 'global'), { command: 'pnpm', args: ['add', '--global', spec, ...reg] });
  assert.deepEqual(at('pnpm', 'local'), { command: 'pnpm', args: ['add', '--dir', '/r', spec, ...reg] });
  assert.deepEqual(at('yarn', 'global'), { command: 'yarn', args: ['global', 'add', spec, ...reg] });
  assert.deepEqual(at('yarn', 'local'), { command: 'yarn', args: ['--cwd', '/r', 'add', spec, ...reg] });
  assert.deepEqual(at('bun', 'global'), { command: 'bun', args: ['add', '--global', spec, ...reg] });
  assert.deepEqual(at('bun', 'local'), { command: 'bun', args: ['add', '--cwd', '/r', spec, ...reg] });
});

test('--no-auto-update is removed before the command sees its arguments, except after --', () => {
  assert.deepEqual(stripOptOutFlag(['watch', '--no-auto-update', '--once']), { argv: ['watch', '--once'], optOut: true });
  assert.deepEqual(stripOptOutFlag(['send', 'bob', '--', '--no-auto-update']), { argv: ['send', 'bob', '--', '--no-auto-update'], optOut: false });
  assert.deepEqual(stripOptOutFlag(['inbox']), { argv: ['inbox'], optOut: false });
});

// The re-executed child: records every signal it gets and exits 42 on SIGINT, 43 on SIGTERM, 44 on SIGHUP.
function signalChild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sig-'));
  const entry = path.join(dir, 'child.js');
  fs.writeFileSync(entry, `
    const fs = require('node:fs');
    const log = ${JSON.stringify(path.join(dir, 'signals'))};
    fs.writeFileSync(${JSON.stringify(path.join(dir, 'pid'))}, String(process.pid));
    for (const [name, code] of [['SIGINT', 42], ['SIGTERM', 43], ['SIGHUP', 44]]) {
      process.on(name, () => { fs.appendFileSync(log, name + '\\n'); process.exit(code); });
    }
    fs.writeFileSync(${JSON.stringify(path.join(dir, 'ready'))}, '');
    setInterval(() => {}, 1000);
  `);
  fs.renameSync(entry, `${entry}.cjs`);
  const read = () => (fs.existsSync(path.join(dir, 'signals')) ? fs.readFileSync(path.join(dir, 'signals'), 'utf8').trim().split('\n') : []);
  const ready = async () => { while (!fs.existsSync(path.join(dir, 'ready'))) await new Promise((r) => setTimeout(r, 10)); };
  return { entry: `${entry}.cjs`, signals: read, ready, pid: () => Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8')) };
}

test('the re-executed child gets SIGINT, SIGTERM and SIGHUP sent to the parent, once each', async () => {
  for (const [signal, code] of [['SIGINT', 42], ['SIGTERM', 43], ['SIGHUP', 44]]) {
    const child = signalChild();
    const done = runOnNewVersion(child.entry, ['watch'], process.env, { interactive: false });
    await child.ready();
    process.kill(process.pid, signal);
    assert.equal(await done, code);
    assert.deepEqual(child.signals(), [signal]);
  }
});

test('with a terminal attached, Ctrl-C that already reached the child is not sent to it a second time', async () => {
  const child = signalChild();
  const done = runOnNewVersion(child.entry, ['watch'], process.env, { interactive: true, graceMs: 300 });
  await child.ready();
  // The terminal signals the whole foreground group: the parent and the child.
  process.kill(process.pid, 'SIGINT');
  process.kill(child.pid(), 'SIGINT');
  assert.equal(await done, 42);
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(child.signals(), ['SIGINT']);
});

test('with a terminal attached, a SIGINT sent to the parent alone still stops the child, once', async () => {
  const child = signalChild();
  const done = runOnNewVersion(child.entry, ['watch'], process.env, { interactive: true, graceMs: 200 });
  await child.ready();
  process.kill(process.pid, 'SIGINT');
  assert.deepEqual(child.signals(), []);
  assert.equal(await done, 42);
  assert.deepEqual(child.signals(), ['SIGINT']);
});
