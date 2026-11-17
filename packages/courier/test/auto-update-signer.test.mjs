import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SIGNER_IDENTITY, assertSignerIdentity, checkForUpdate, detectInstall, managerEnv, signerPattern, writeTargets,
} from '../dist/auto-update.js';

const REGISTRY = 'https://registry.npmjs.org';
const LATEST_URL = `${REGISTRY}/@tinycloud%2fcourier/latest`;
// The real provenance bundle npm holds for @tinycloud/courier@0.6.0-beta.48, signed by this repository's release workflow.
const REAL_BUNDLE = JSON.parse(fs.readFileSync(new URL('./fixtures/courier-0.6.0-beta.48.provenance-bundle.json', import.meta.url), 'utf8'));
const STATES = () => (fs.existsSync(process.env.COURIER_HOME) ? fs.readdirSync(process.env.COURIER_HOME).filter((n) => n.startsWith('update-check-')) : []);
const clearState = () => { for (const n of STATES()) fs.rmSync(path.join(process.env.COURIER_HOME, n), { force: true }); };

test.beforeEach(clearState);

test('the signer pattern given to sigstore (which matches it unanchored) accepts the exact identity and nothing longer, shorter or similar', () => {
  const pattern = new RegExp(signerPattern(SIGNER_IDENTITY));
  assert.equal(pattern.test(SIGNER_IDENTITY), true);
  for (const other of [
    `${SIGNER_IDENTITY}-evil`,
    `${SIGNER_IDENTITY}/x`,
    SIGNER_IDENTITY.slice(0, -1),
    `x${SIGNER_IDENTITY}`,
    SIGNER_IDENTITY.replace('/js-sdk/', '/js-sdk-evil/'),
    SIGNER_IDENTITY.replace('TinyCloudLabs', 'EvilLabs'),
    // `.` is a literal dot, not "any character"
    SIGNER_IDENTITY.replace('changesets.yml', 'changesetsXyml'),
    SIGNER_IDENTITY.replace('github.com', 'githubXcom'),
  ]) assert.equal(pattern.test(other), false, other);
  // Regular-expression characters in an identity are literals.
  assert.equal(new RegExp(signerPattern('a.b(c)+d')).test('a.b(c)+d'), true);
  assert.equal(new RegExp(signerPattern('a.b(c)+d')).test('aXb(c)+d'), false);
});

test('the signing certificate of the real beta.48 provenance names exactly the pinned identity, and any other identity is refused', () => {
  assertSignerIdentity(REAL_BUNDLE, SIGNER_IDENTITY);
  for (const other of [
    `${SIGNER_IDENTITY}-evil`,
    `${SIGNER_IDENTITY}/x`,
    SIGNER_IDENTITY.slice(0, -2),
    SIGNER_IDENTITY.replace('/js-sdk/', '/other/'),
    SIGNER_IDENTITY.replace('changesets.yml', 'raw-publish.yml'),
    SIGNER_IDENTITY.replace('refs/heads/master', 'refs/tags/v1'),
  ]) assert.throws(() => assertSignerIdentity(REAL_BUNDLE, other), /certificate identity is/, other);
});

test('a bundle with no signing certificate is refused, not assumed fine', () => {
  for (const bundle of [undefined, {}, { verificationMaterial: {} }, { verificationMaterial: { publicKey: { hint: 'k' } } }, { verificationMaterial: { x509CertificateChain: { certificates: [] } } }]) {
    assert.throws(() => assertSignerIdentity(bundle, SIGNER_IDENTITY), /no signing certificate/);
  }
  // The newer bundle layout carries the certificate directly.
  const direct = { verificationMaterial: { certificate: REAL_BUNDLE.verificationMaterial.x509CertificateChain.certificates[0] } };
  assertSignerIdentity(direct, SIGNER_IDENTITY);
});

/** Minimal fake world: only `latest` is served, any package-manager call or download fails the test. */
function minimalWorld(install) {
  const fetched = [];
  const logs = [];
  const latest = {
    name: '@tinycloud/courier',
    version: '0.6.1',
    dist: {
      tarball: `${REGISTRY}/@tinycloud/courier/-/courier-0.6.1.tgz`,
      integrity: `sha512-${createHash('sha512').update('x').digest('base64')}`,
      attestations: { url: 'x', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
    },
  };
  const deps = {
    env: {},
    now: () => 1_800_000_000_000,
    version: '0.6.0',
    packageRoot: install.pkg,
    fetch: async (url) => {
      fetched.push(String(url));
      if (url === LATEST_URL) return new Response(JSON.stringify(latest));
      throw new Error(`unexpected request ${url}`);
    },
    run: async () => { throw new Error('no package manager may run'); },
    verifyBundle: async () => { throw new Error('nothing may be verified'); },
    log: (line) => logs.push(line),
  };
  return { deps, fetched, logs, check: () => checkForUpdate(['inbox'], deps) };
}

function layout(...parts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'au-sg-'));
  const pkg = path.join(root, ...parts);
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@tinycloud/courier', version: '0.6.0' }));
  return { root, pkg: fs.realpathSync(pkg) };
}

test('yarn, pnpm and bun global installs are not updated from a file (they record its path); the line gives the command to run', async () => {
  for (const [manager, parts, manual] of [
    ['yarn', ['home', '.config', 'yarn', 'global', 'node_modules', '@tinycloud', 'courier'], /yarn global add @tinycloud\/courier@0\.6\.1 --registry/],
    ['bun', ['home', '.bun', 'install', 'global', 'node_modules', '@tinycloud', 'courier'], /bun add --global @tinycloud\/courier@0\.6\.1 --registry/],
    ['pnpm', ['home', 'pnpm', 'global', '5', 'node_modules', '.pnpm', '@tinycloud+courier@0.6.0', 'node_modules', '@tinycloud', 'courier'], /pnpm add --global @tinycloud\/courier@0\.6\.1 --registry/],
  ]) {
    clearState();
    const install = layout(...parts);
    const detected = detectInstall(install.pkg);
    assert.equal(detected.manager, manager);
    assert.equal(detected.scope, 'global');
    const w = minimalWorld(install);
    assert.equal((await w.check()).kind, 'none');
    assert.equal(w.logs.length, 1, manager);
    assert.match(w.logs[0], new RegExp(`a ${manager} global install records the path of a file it installs`));
    assert.match(w.logs[0], manual);
    assert.deepEqual(w.fetched, [LATEST_URL]);
  }
});

test('an npm global install whose bin directory is not writable is skipped up front, with the command to run by hand', { skip: process.getuid?.() === 0 }, async () => {
  const install = layout('prefix', 'lib', 'node_modules', '@tinycloud', 'courier');
  const prefix = path.join(install.root, 'prefix');
  const bin = path.join(prefix, 'bin');
  fs.mkdirSync(bin);
  fs.chmodSync(bin, 0o555);
  try {
    const w = minimalWorld(install);
    assert.equal((await w.check()).kind, 'none');
    assert.equal(w.logs.length, 1);
    assert.ok(w.logs[0].includes(`${fs.realpathSync(bin)} is not writable`), w.logs[0]);
    assert.match(w.logs[0], /run: npm install --global --prefix \S+ @tinycloud\/courier@0\.6\.1/);
    assert.deepEqual(w.fetched, [LATEST_URL]);
  } finally {
    fs.chmodSync(bin, 0o755);
  }
});

test('a bin directory that does not exist yet is fine when the prefix can create it, and not when it cannot', { skip: process.getuid?.() === 0 }, async () => {
  const install = layout('prefix', 'lib', 'node_modules', '@tinycloud', 'courier');
  const prefix = path.join(install.root, 'prefix');
  const detected = detectInstall(install.pkg);
  assert.deepEqual(writeTargets(detected), [detected.modulesDir, path.join(detected.root, 'bin')]);
  // Prefix writable: the check passes (and the stubbed world then stops at the first download).
  const open = minimalWorld(install);
  await open.check();
  assert.ok(open.fetched.length > 1, 'went on to download');

  clearState();
  fs.chmodSync(prefix, 0o555);
  try {
    const closed = minimalWorld(install);
    await closed.check();
    assert.match(closed.logs[0], /is not writable/);
    assert.deepEqual(closed.fetched, [LATEST_URL]);
  } finally {
    fs.chmodSync(prefix, 0o755);
  }
});

test('the install writes into an app\'s node_modules/.bin too, so a read-only one is a clean skip', () => {
  const detected = { manager: 'npm', scope: 'local', root: '/app', modulesDir: '/app/node_modules' };
  assert.deepEqual(writeTargets(detected), ['/app', '/app/node_modules', '/app/node_modules/.bin']);
});

test('COREPACK_* and the other package managers\' configuration are removed from the environment the package manager gets', () => {
  const env = managerEnv({
    PATH: '/bin', HOME: '/home/x', COREPACK_NPM_REGISTRY: 'https://evil.example/', corepack_home: '/tmp/x', COREPACK_ENABLE_STRICT: '0',
    npm_config_registry: 'https://evil.example/', YARN_NPM_REGISTRY_SERVER: 'https://evil.example/', BUN_CONFIG_REGISTRY: 'x',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});
