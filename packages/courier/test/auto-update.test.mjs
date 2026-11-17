import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CHECK_INTERVAL_MS, REEXEC_ENV, SIGNER_IDENTITY, SIGNER_ISSUER, STEP_TIMEOUT_MS, checkForUpdate, compareSemver, detectInstall, installCommand,
  isStable, managerEnv, runOnNewVersion, stripOptOutFlag,
} from '../dist/auto-update.js';
import { WAKE_CHILD_ENV, courierEnvOverrides, courierOnlyEnv } from '../dist/guard/install.js';

const REGISTRY = 'https://registry.npmjs.org';
const LATEST_URL = `${REGISTRY}/@tinycloud%2fcourier/latest`;
const SLSA = 'https://slsa.dev/provenance/v1';
const TARBALL = Buffer.from('pretend tarball bytes');
const PREVIOUS = Buffer.from('the running release, as published');
const HOME_FILES = () => (fs.existsSync(process.env.COURIER_HOME) ? fs.readdirSync(process.env.COURIER_HOME) : []);
const STATES = () => HOME_FILES().filter((n) => n.startsWith('update-check-'));
const clearState = () => { for (const n of STATES()) fs.rmSync(path.join(process.env.COURIER_HOME, n), { force: true }); };
const WORK_DIRS = () => HOME_FILES().filter((n) => n.startsWith('update-') && !n.startsWith('update-check-'));

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

/** What `/-/npm/v1/attestations/<pkg>@<version>` answers: the publish attestation and the SLSA provenance bundle. */
function attestations(version, bytes, { digest, withoutProvenance } = {}) {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `pkg:npm/%40tinycloud/courier@${version}`, digest: { sha512: digest ?? createHash('sha512').update(bytes).digest('hex') } }],
    predicateType: SLSA,
    predicate: {},
  };
  const bundle = (s) => ({ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(s)).toString('base64') } });
  return {
    attestations: [
      { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: bundle({}) },
      ...(withoutProvenance ? [] : [{ predicateType: SLSA, bundle: bundle(statement) }]),
    ],
  };
}

/**
 * A fake registry, disk, sigstore and package manager. `latest` is the dist-tag document, `served` the bytes the tarball URL
 * sends. The package-manager stub records every call (with the bytes of the `.tgz` it was given, read at call time, since the
 * private directory is gone afterwards) and writes the package.json the install would leave.
 */
function world(options = {}) {
  const version = options.latest ?? '0.6.1';
  const running = options.running ?? '0.6.0';
  const install = options.install ?? globalInstall(running);
  const calls = [];
  const fetched = [];
  const verified = [];
  const order = [];
  const logs = [];
  let realInstalls = 0;
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
  const previousDoc = {
    name: '@tinycloud/courier',
    version: running,
    dist: { tarball: `${REGISTRY}/@tinycloud/courier/-/courier-${running}.tgz`, integrity: integrityOf(PREVIOUS) },
  };
  const fakeFetch = async (url) => {
    fetched.push(String(url));
    if (options.offline) throw new TypeError('fetch failed');
    if (url === LATEST_URL) return new Response(JSON.stringify(latestDoc));
    if (url === `${REGISTRY}/@tinycloud%2fcourier/${running}`) return options.noPrevious ? new Response('nope', { status: 404 }) : new Response(JSON.stringify(previousDoc));
    if (url === `${REGISTRY}/-/npm/v1/attestations/@tinycloud%2fcourier@${version}`) return new Response(JSON.stringify(attestations(version, TARBALL, options.attestation)));
    // A second download of the release would get something else: the install must not need one.
    if (url === latestDoc.dist.tarball) return new Response(fetched.filter((u) => u === url).length === 1 ? (options.served ?? TARBALL) : 'swapped after the check');
    if (url === previousDoc.dist.tarball) return new Response(options.previousServed ?? PREVIOUS);
    return new Response('nope', { status: 404 });
  };
  const verifyBundle = async (bundle, policy) => {
    order.push('verify');
    verified.push({ bundle, policy });
    if (options.verifyFails) throw new Error('UNTRUSTED_SIGNER_ERROR certificate identity error');
  };
  const run = async (command, args, opts) => {
    const file = args.find((a) => a.endsWith('.tgz'));
    calls.push({
      command, args, cwd: opts.cwd, timeoutMs: opts.timeoutMs, file,
      bytes: file ? fs.readFileSync(file) : undefined,
      fileMode: file ? fs.statSync(file).mode & 0o777 : undefined,
      dirMode: file ? fs.statSync(path.dirname(file)).mode & 0o777 : undefined,
    });
    order.push(`run ${args[0]}`);
    if (args[0] === 'audit') {
      return options.auditFails ? { code: 1, stdout: '{"invalid":[{"name":"x"}],"missing":[]}', stderr: '' } : { code: 0, stdout: '{"invalid":[],"missing":[]}', stderr: '' };
    }
    if (args[args.indexOf('--prefix') + 1] !== install.root) return { code: options.stageFails ? 1 : 0, stdout: '', stderr: '' };
    // An install into the real location: npm puts the version named by the file there.
    realInstalls += 1;
    const wanted = path.basename(file).replace(/^(courier|previous)-/, '').replace(/\.tgz$/, '');
    if (realInstalls === 1) {
      if (options.installFails) return { code: 1, stdout: '', stderr: '' };
      fs.writeFileSync(path.join(install.pkg, 'package.json'), JSON.stringify({ name: '@tinycloud/courier', version: options.landsAs ?? wanted }));
      return { code: 0, stdout: '', stderr: '' };
    }
    if (options.rollbackFails) return { code: 1, stdout: '', stderr: '' };
    fs.writeFileSync(path.join(install.pkg, 'package.json'), JSON.stringify({ name: '@tinycloud/courier', version: wanted }));
    return { code: 0, stdout: '', stderr: '' };
  };
  const deps = {
    env: options.env ?? {},
    now: () => clock,
    version: running,
    packageRoot: install.pkg,
    fetch: fakeFetch,
    run,
    verifyBundle,
    log: (line) => logs.push(line),
    platform: options.platform,
  };
  const real = () => calls.filter((c) => c.args[0] === 'install' && c.args[c.args.indexOf('--prefix') + 1] === install.root);
  return { deps, calls, fetched, verified, order, logs, install, real, advance: (ms) => { clock += ms; }, check: (argv = ['inbox'], flag = false) => checkForUpdate(argv, deps, flag) };
}

test.beforeEach(() => { clearState(); });

test('a newer stable release is downloaded once, verified, and that file is installed where the running copy lives, then re-run', async () => {
  const w = world();
  const result = await w.check(['watch', '--wake', 'none']);
  assert.equal(result.kind, 'updated');
  assert.equal(result.to, '0.6.1');
  assert.equal(result.entry, fs.realpathSync(path.join(w.install.pkg, 'dist', 'cli.js')));
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /updated 0\.6\.0 → 0\.6\.1 \(npm global\)/);

  // The order: hash, sigstore, stage + audit, then the real install.
  assert.deepEqual(w.order, ['verify', 'run install', 'run audit', 'run install']);
  // One download of the release; its bytes are what both the stage and the real install were given.
  assert.equal(w.fetched.filter((u) => u.endsWith('.tgz')).length, 1);
  const [stage, audit, install] = w.calls;
  assert.deepEqual(install.bytes, TARBALL);
  assert.deepEqual(stage.bytes, TARBALL);
  assert.equal(install.file, stage.file);
  assert.equal(path.basename(install.file), 'courier-0.6.1.tgz');
  // Never by name and version: nothing is resolved from the registry again.
  assert.ok(w.calls.every((c) => !c.args.some((a) => a.includes('@tinycloud/courier@'))));
  // Private directory and file, under the Courier home, gone afterwards.
  assert.equal(install.dirMode, 0o700);
  assert.equal(install.fileMode, 0o400);
  assert.ok(install.file.startsWith(process.env.COURIER_HOME));
  assert.deepEqual(WORK_DIRS(), []);
  // Scripts off, registry explicit, user and global npm configuration replaced.
  const work = path.dirname(install.file);
  assert.deepEqual(install.args, [
    'install', '--global', '--prefix', w.install.root, install.file, '--ignore-scripts', '--no-audit', '--no-fund',
    '--userconfig', path.join(work, 'user.npmrc'), '--globalconfig', path.join(work, 'global.npmrc'),
    '--registry', `${REGISTRY}/`, `--@tinycloud:registry=${REGISTRY}/`, '--no-update-notifier', '--loglevel', 'error',
  ]);
  assert.equal(audit.args[1], 'signatures');
  assert.ok(audit.args.includes('--userconfig'));
  assert.ok(stage.args.includes('--ignore-scripts'));
  // A hard limit on each step.
  assert.deepEqual([stage.timeoutMs, audit.timeoutMs, install.timeoutMs], [STEP_TIMEOUT_MS.stage, STEP_TIMEOUT_MS.audit, STEP_TIMEOUT_MS.install]);
  // Only our release workflow, on master, is accepted as the signer.
  assert.deepEqual(w.verified.map((v) => v.policy), [{ certificateIssuer: SIGNER_ISSUER, certificateIdentityURI: SIGNER_IDENTITY }]);
  assert.equal(SIGNER_ISSUER, 'https://token.actions.githubusercontent.com');
  assert.equal(SIGNER_IDENTITY, 'https://github.com/TinyCloudLabs/js-sdk/.github/workflows/changesets.yml@refs/heads/master');
});

test('the worst case for a blocked start, every step at its limit plus a rollback, stays under two minutes', () => {
  const total = Object.values(STEP_TIMEOUT_MS).reduce((sum, ms) => sum + ms, 0);
  assert.ok(total <= 120_000, `${total} ms`);
});

test('the same or an older release changes nothing and says nothing', async () => {
  for (const latest of ['0.6.0', '0.5.3']) {
    clearState();
    const w = world({ latest });
    assert.equal((await w.check()).kind, 'none');
    assert.deepEqual(w.logs, []);
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.fetched, [LATEST_URL]);
  }
});

test('a prerelease on latest is never installed', async () => {
  for (const latest of ['0.7.0-beta.3', '0.7.0-rc.1', '1.0.0-0']) {
    clearState();
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
  clearState();
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

test('a tarball whose hash is not the registry integrity is refused before anything is verified or installed', async () => {
  const w = world({ served: Buffer.from('something else') });
  const result = await w.check();
  assert.equal(result.kind, 'none');
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /refused @tinycloud\/courier@0\.6\.1: .*integrity.*staying on 0\.6\.0/);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(w.verified, []);
  assert.deepEqual(WORK_DIRS(), []);
});

test('an unknown, weak or unrecorded integrity, or a tarball from another host, is refused for every manager', async () => {
  for (const [dist, pattern] of [
    [{ integrity: 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=' }, /refused .*sha512/],
    [{ integrity: undefined }, /refused .*sha512/],
    [{ tarball: 'https://evil.example/courier-0.6.1.tgz' }, /refused .*npm registry/],
  ]) {
    clearState();
    const w = world({ dist });
    assert.equal((await w.check()).kind, 'none');
    assert.match(w.logs[0], pattern);
    assert.deepEqual(w.fetched, [LATEST_URL]);
    assert.deepEqual(w.calls, []);
  }
});

test('a release with no npm provenance is refused', async () => {
  const w = world({ provenance: false });
  assert.equal((await w.check()).kind, 'none');
  assert.deepEqual(w.logs, ['no npm provenance for 0.6.1, staying on 0.6.0']);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(w.fetched, [LATEST_URL]);
});

test('provenance that says the right things but does not verify for the pinned signer is refused (a stolen npm token is not enough)', async () => {
  // The registry JSON is perfect: right package, right digest, flagged as having provenance. Only the signature/identity fails.
  const w = world({ verifyFails: true });
  assert.equal((await w.check()).kind, 'none');
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /refused @tinycloud\/courier@0\.6\.1: its provenance did not verify for https:\/\/github\.com\/TinyCloudLabs\/js-sdk\/\.github\/workflows\/changesets\.yml@refs\/heads\/master/);
  assert.equal(w.verified.length, 1);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(WORK_DIRS(), []);
});

test('a verified provenance statement about another tarball, or no provenance attestation at all, is refused', async () => {
  const other = world({ attestation: { digest: createHash('sha512').update('other').digest('hex') } });
  assert.equal((await other.check()).kind, 'none');
  assert.match(other.logs[0], /refused .*different tarball/);
  assert.equal(other.verified.length, 1);
  assert.deepEqual(other.calls, []);
  clearState();
  const none = world({ attestation: { withoutProvenance: true } });
  assert.equal((await none.check()).kind, 'none');
  assert.match(none.logs[0], /refused .*provenance attestation is missing/);
  assert.deepEqual(none.verified, []);
  assert.deepEqual(none.calls, []);
});

test('a failing signature audit refuses the release and removes the private directory', async () => {
  const w = world({ auditFails: true });
  assert.equal((await w.check()).kind, 'none');
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /refused .*npm audit signatures/);
  assert.deepEqual(w.real(), []);
  assert.deepEqual(WORK_DIRS(), []);
});

test('an install that lands another version is rolled back from the running version\'s registry tarball, checked against its integrity', async () => {
  const w = world({ landsAs: '0.6.2' });
  assert.equal((await w.check()).kind, 'none');
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0], /auto-update failed: .*0\.6\.0 was put back and checked against its registry integrity/);
  const [, back] = w.real();
  assert.equal(path.basename(back.file), 'previous-0.6.0.tgz');
  assert.deepEqual(back.bytes, PREVIOUS);
  assert.equal(back.timeoutMs, STEP_TIMEOUT_MS.rollbackInstall);
  assert.ok(back.args.includes('--ignore-scripts'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.install.pkg, 'package.json'), 'utf8')).version, '0.6.0');
  assert.deepEqual(WORK_DIRS(), []);

  // An install that fails outright is rolled back the same way.
  clearState();
  const failed = world({ installFails: true });
  assert.equal((await failed.check()).kind, 'none');
  assert.match(failed.logs[0], /0\.6\.0 was put back/);
  assert.equal(failed.real().length, 2);
});

test('a rollback that cannot be verified or installed is reported loudly, and stops the command only when no usable copy is left', async () => {
  // The previous release's tarball does not match its registry integrity: it is not reinstalled.
  const unverifiable = world({ installFails: true, previousServed: Buffer.from('not what was published') });
  assert.equal((await unverifiable.check()).kind, 'none');
  assert.equal(unverifiable.logs.length, 1);
  assert.match(unverifiable.logs[0], /auto-update FAILED: .*putting 0\.6\.0 back failed too \(.*integrity.*\); the installed copy still reports 0\.6\.0, repair it with: npm install --global --prefix \S+ @tinycloud\/courier@0\.6\.0/);
  assert.equal(unverifiable.real().length, 1);

  // Nothing to roll back to, and the copy on disk is another version: broken, the command must not run.
  clearState();
  const gone = world({ landsAs: '0.6.2', noPrevious: true });
  assert.equal((await gone.check()).kind, 'broken');
  assert.match(gone.logs[0], /auto-update FAILED: .*putting 0\.6\.0 back failed too \(.*404.*\); the installed copy is not usable, repair it with: npm install/);

  clearState();
  const stuck = world({ landsAs: '0.6.2', rollbackFails: true });
  assert.equal((await stuck.check()).kind, 'broken');
  assert.match(stuck.logs[0], /did not leave 0\.6\.0 in place/);
  assert.equal(stuck.real().length, 2);
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

test('an app-directory install by pnpm, yarn or bun is not updated from a file, with the command to run by hand', async () => {
  for (const [lock, manual] of [['pnpm-lock.yaml', /pnpm add --dir \S+ @tinycloud\/courier@0\.6\.1/], ['yarn.lock', /yarn --cwd \S+ add @tinycloud\/courier@0\.6\.1/], ['bun.lock', /bun add --cwd \S+ @tinycloud\/courier@0\.6\.1/]]) {
    clearState();
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'au-'));
    const pkg = path.join(app, 'node_modules', '@tinycloud', 'courier');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), '{}');
    fs.writeFileSync(path.join(app, lock), '');
    const w = world({ install: { root: app, modules: path.join(app, 'node_modules'), pkg: fs.realpathSync(pkg) } });
    assert.equal((await w.check()).kind, 'none');
    assert.equal(w.logs.length, 1);
    assert.match(w.logs[0], /can't take a verified file without rewriting package\.json/);
    assert.match(w.logs[0], manual);
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.fetched, [LATEST_URL]);
  }
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
    assert.deepEqual(STATES(), []);
  }
  // Not set, empty, or 0 is not an opt-out.
  for (const env of [{ CI: '' }, { CI: 'false' }, { COURIER_NO_AUTO_UPDATE: '0' }]) {
    const w = world({ env, latest: '0.6.0' });
    await w.check();
    assert.deepEqual(w.fetched, [LATEST_URL]);
    clearState();
  }
});

test('a wake-adapter child, a re-executed process, informational commands and the hooks never check, wherever a flag puts the hook name', async () => {
  for (const [env, argv] of [
    [{ [WAKE_CHILD_ENV]: '1' }, ['inbox']],
    [{ [REEXEC_ENV]: '1' }, ['inbox']],
    [{}, ['--version']],
    [{}, []],
    [{}, ['send', '--help']],
    [{}, ['guard']],
    [{}, ['run-approved', 'abc']],
    [{}, ['--profile', 'work', 'guard']],
    [{}, ['--some-flag', 'value', 'run-approved', 'abc']],
    [{}, ['--x', 'broker']],
  ]) {
    const w = world({ env });
    assert.equal((await w.check(argv)).kind, 'none');
    assert.deepEqual(w.logs, [], argv.join(' '));
    assert.deepEqual(w.fetched, [], argv.join(' '));
  }
  // After `--` a word is just an argument.
  const w = world({ latest: '0.6.0' });
  await w.check(['send', 'bob', '--', 'guard']);
  assert.deepEqual(w.fetched, [LATEST_URL]);
});

test('the environment a woken agent gets says so', () => {
  assert.equal(courierOnlyEnv({ PATH: '/bin' }, '/var/tmp/home-x').COURIER_WAKE_CHILD, '1');
  assert.equal(courierEnvOverrides({ PATH: '/bin' }, '/var/tmp/home-x').COURIER_WAKE_CHILD, '1');
  assert.equal(WAKE_CHILD_ENV, 'COURIER_WAKE_CHILD');
});

test('package-manager configuration in the environment cannot redirect the install', () => {
  const env = managerEnv({
    PATH: '/bin', HOME: '/home/x', npm_config_registry: 'https://evil.example/', NPM_CONFIG_USERCONFIG: '/tmp/rc', 'npm_config_@tinycloud:registry': 'https://evil.example/',
    YARN_REGISTRY: 'https://evil.example/', bun_config_registry: 'x', pnpm_config_registry: 'x', npm_package_name: 'kept', HTTPS_PROXY: 'http://proxy:3128',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'HTTPS_PROXY', 'PATH', 'npm_package_name']);
});

test('at most one registry check per install per 24 hours', async () => {
  const w = world({ latest: '0.6.0' });
  await w.check();
  await w.check();
  assert.equal(w.fetched.length, 1, 'the second start within a day does not ask the registry');
  const [file] = STATES();
  assert.equal(STATES().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.COURIER_HOME, file), 'utf8')).install, w.install.pkg);

  w.advance(CHECK_INTERVAL_MS - 1);
  await w.check();
  assert.equal(w.fetched.length, 1);
  w.advance(1);
  await w.check();
  assert.equal(w.fetched.length, 2);

  // Another install under the same Courier home has its own slot, and does not use up or overwrite the first one's.
  const second = world({ latest: '0.6.0', now: w.deps.now() });
  await second.check();
  assert.equal(second.fetched.length, 1);
  assert.equal(STATES().length, 2);
  await second.check();
  await w.check();
  assert.equal(second.fetched.length, 1);
  assert.equal(w.fetched.length, 2);
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
  // pnpm dlx, bunx and yarn dlx run from throwaway directories too.
  for (const dir of [['.cache', 'pnpm', 'dlx', 'abc'], ['tmp', 'bunx-1000-@tinycloud', 'courier@latest'], ['tmp', 'xfs-1234abcd']]) {
    const thrown = path.join(checkout, ...dir, 'node_modules', '@tinycloud', 'courier');
    fs.mkdirSync(thrown, { recursive: true });
    fs.writeFileSync(path.join(checkout, ...dir, 'package.json'), '{}');
    assert.equal(detectInstall(thrown), undefined, dir.join('/'));
  }
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

test('each package manager installs the verified file, scripts off, where it was installed; the hand-run form names the version', () => {
  const at = (manager, scope, spec, work) => installCommand({ manager, scope, root: '/r', modulesDir: '/r/node_modules' }, spec, work);
  const reg = ['--registry', 'https://registry.npmjs.org/'];
  const file = '/w/courier-0.6.1.tgz';
  const npmConfig = ['--userconfig', '/w/user.npmrc', '--globalconfig', '/w/global.npmrc', ...reg, '--@tinycloud:registry=https://registry.npmjs.org/', '--no-update-notifier', '--loglevel', 'error'];
  assert.deepEqual(at('npm', 'global', file, '/w'), { command: 'npm', args: ['install', '--global', '--prefix', '/r', file, '--ignore-scripts', '--no-audit', '--no-fund', ...npmConfig] });
  assert.deepEqual(at('npm', 'local', file, '/w'), { command: 'npm', args: ['install', '--no-save', '--prefix', '/r', file, '--ignore-scripts', '--no-audit', '--no-fund', ...npmConfig] });
  assert.deepEqual(at('pnpm', 'global', file, '/w'), { command: 'pnpm', args: ['add', '--global', file, '--ignore-scripts', ...reg] });
  assert.deepEqual(at('yarn', 'global', file, '/w'), { command: 'yarn', args: ['global', 'add', file, '--ignore-scripts', ...reg] });
  assert.deepEqual(at('bun', 'global', file, '/w'), { command: 'bun', args: ['add', '--global', file, '--ignore-scripts', ...reg] });

  const spec = '@tinycloud/courier@0.6.1';
  assert.deepEqual(at('npm', 'global', spec), { command: 'npm', args: ['install', '--global', '--prefix', '/r', spec, ...reg] });
  assert.deepEqual(at('npm', 'local', spec), { command: 'npm', args: ['install', '--prefix', '/r', spec, ...reg] });
  assert.deepEqual(at('pnpm', 'local', spec), { command: 'pnpm', args: ['add', '--dir', '/r', spec, ...reg] });
  assert.deepEqual(at('yarn', 'local', spec), { command: 'yarn', args: ['--cwd', '/r', 'add', spec, ...reg] });
  assert.deepEqual(at('bun', 'local', spec), { command: 'bun', args: ['add', '--cwd', '/r', spec, ...reg] });
});

test('--no-auto-update is removed before the command sees its arguments, except after --', () => {
  assert.deepEqual(stripOptOutFlag(['watch', '--no-auto-update', '--once']), { argv: ['watch', '--once'], optOut: true });
  assert.deepEqual(stripOptOutFlag(['send', 'bob', '--', '--no-auto-update']), { argv: ['send', 'bob', '--', '--no-auto-update'], optOut: false });
  assert.deepEqual(stripOptOutFlag(['inbox']), { argv: ['inbox'], optOut: false });
});

// The re-executed child: records every signal it gets and exits 42 on SIGINT, 43 on SIGTERM, 44 on SIGHUP.
function signalChild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sig-'));
  const entry = path.join(dir, 'child.cjs');
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
  const read = () => (fs.existsSync(path.join(dir, 'signals')) ? fs.readFileSync(path.join(dir, 'signals'), 'utf8').trim().split('\n') : []);
  const ready = async () => { while (!fs.existsSync(path.join(dir, 'ready'))) await new Promise((r) => setTimeout(r, 10)); };
  return { entry, signals: read, ready, pid: () => Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8')) };
}

test('SIGTERM and SIGHUP sent to the parent reach the re-executed child at once, once each', async () => {
  for (const [signal, code] of [['SIGTERM', 43], ['SIGHUP', 44]]) {
    const child = signalChild();
    const done = runOnNewVersion(child.entry, ['watch'], process.env, { graceMs: 60_000 });
    await child.ready();
    process.kill(process.pid, signal);
    assert.equal(await done, code);
    assert.deepEqual(child.signals(), [signal]);
  }
});

test('Ctrl-C that already reached the child is not sent to it a second time, with stdin piped or not', async () => {
  const child = signalChild();
  const done = runOnNewVersion(child.entry, ['watch'], process.env, { graceMs: 300 });
  await child.ready();
  // The terminal signals the whole foreground group: the parent and the child.
  process.kill(process.pid, 'SIGINT');
  process.kill(child.pid(), 'SIGINT');
  assert.equal(await done, 42);
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(child.signals(), ['SIGINT']);
});

test('a SIGINT sent to the parent alone still stops the child, once, after the grace period', async () => {
  const child = signalChild();
  const done = runOnNewVersion(child.entry, ['watch'], process.env, { graceMs: 200 });
  await child.ready();
  process.kill(process.pid, 'SIGINT');
  assert.deepEqual(child.signals(), []);
  assert.equal(await done, 42);
  assert.deepEqual(child.signals(), ['SIGINT']);
});

test('on Windows auto-update is off, with one line saying so and the command to run, and nothing is fetched or recorded', async () => {
  const w = world({ platform: 'win32' });
  assert.equal((await w.check()).kind, 'none');
  assert.deepEqual(w.logs, ['auto-update skipped: not supported on Windows; update with: npm install --global @tinycloud/courier@latest']);
  assert.deepEqual(w.fetched, []);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(STATES(), []);
});

/** A copy of dist with no package.json beside it, as while `npm install` replaces the package. */
function distWithoutManifest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-lazy-'));
  fs.cpSync(path.join(import.meta.dirname, '..', 'dist'), path.join(root, 'dist'), { recursive: true });
  fs.symlinkSync(path.join(import.meta.dirname, '..', '..', '..', 'node_modules'), path.join(root, 'node_modules'));
  return root;
}

function checkInCopy(root, argv, packageRoot, extra = '') {
  const script = `
    const { checkForUpdate } = await import(${JSON.stringify(path.join(root, 'dist', 'auto-update.js'))});
    const logs = [];
    const result = await checkForUpdate(${JSON.stringify(argv)}, { env: {}, now: Date.now, version: '1.0.0', packageRoot: ${JSON.stringify(packageRoot)}, ${extra} log: (l) => logs.push(l) });
    console.log(JSON.stringify({ result, logs }));
  `;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

test('loading the module reads no package.json: a package mid-swap must not crash every courier command', () => {
  const root = distWithoutManifest();
  assert.deepEqual(checkInCopy(root, ['--version'], root), { result: { kind: 'none' }, logs: [] });
});

test('a courier whose package.json is unreadable gets one skip line from the check, never a crash', () => {
  const root = distWithoutManifest();
  const pkg = path.join(root, 'prefix', 'lib', 'node_modules', '@tinycloud', 'courier');
  fs.mkdirSync(pkg, { recursive: true });
  const { result, logs } = checkInCopy(root, ['inbox'], pkg, "platform: 'win32',");
  assert.equal(result.kind, 'none');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /auto-update skipped: .*package\.json/);
});
