import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { credentialSourceFromArgs } from '../dist/invite-credential-source.js';
import { CREDENTIAL_MAX_BYTES } from '../dist/invite-schema.js';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const BINDING = { courierDid: 'did:key:z6MkTestCourier', inviteId: 'a'.repeat(25) + 'b' };

/** Minimal ParsedArgs stand-in: flags map name → value (`true` for bare flags). */
function args(flags) {
  return {
    get: (name) => (name in flags ? flags[name] : undefined),
    has: (name) => name in flags,
    all: () => [],
    positional: [],
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join('/var/tmp', 'courier-cred-'));
}

async function errorOf(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}

test('no credential flags yields no source', () => {
  assert.equal(credentialSourceFromArgs(args({})), undefined);
});

test('passing both credential flags is a usage error', () => {
  assert.throws(
    () => credentialSourceFromArgs(args({ 'credential-file': '/nonexistent', 'credential-stdin': true })),
    /mutually exclusive/,
  );
});

test('a bare --credential-file with no path is a usage error', () => {
  assert.throws(() => credentialSourceFromArgs(args({ 'credential-file': 'true' })), /needs a path/);
});

test('file source returns the trimmed credential', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'proof.txt');
  fs.writeFileSync(file, '  proof-token-abc\n');
  const source = credentialSourceFromArgs(args({ 'credential-file': file }));
  assert.equal(await source.getEmailProof('hunter@example.test', BINDING), 'proof-token-abc');
});

test('an empty credential file is refused without echoing its contents', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'empty.txt');
  fs.writeFileSync(file, '   \n');
  const source = credentialSourceFromArgs(args({ 'credential-file': file }));
  const err = await errorOf(source.getEmailProof('hunter@example.test', BINDING));
  assert.equal(err.code, 'usage');
  assert.match(err.message, /is empty/);
});

test('an oversize credential file is refused without echoing its contents', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'big.txt');
  const secret = 'SECRETMARK' + 'x'.repeat(CREDENTIAL_MAX_BYTES);
  fs.writeFileSync(file, secret);
  const source = credentialSourceFromArgs(args({ 'credential-file': file }));
  const err = await errorOf(source.getEmailProof('hunter@example.test', BINDING));
  assert.equal(err.code, 'usage');
  assert.match(err.message, new RegExp(`over ${CREDENTIAL_MAX_BYTES} bytes`));
  assert.doesNotMatch(err.message, /SECRETMARK/);
});

test('stdin source reads the credential from standard input', () => {
  const script = `
    import('${DIST}/invite-credential-source.js').then(async ({ credentialSourceFromArgs }) => {
      const source = credentialSourceFromArgs({
        get: () => undefined, has: (n) => n === 'credential-stdin', all: () => [], positional: [],
      });
      process.stdout.write(await source.getEmailProof('hunter@example.test', ${JSON.stringify(BINDING)}));
    });`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    input: 'stdin-proof-xyz\n',
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'stdin-proof-xyz');
});

test('an empty stdin credential is refused as a usage error', () => {
  const script = `
    import('${DIST}/invite-credential-source.js').then(async ({ credentialSourceFromArgs }) => {
      const source = credentialSourceFromArgs({
        get: () => undefined, has: (n) => n === 'credential-stdin', all: () => [], positional: [],
      });
      await source.getEmailProof('hunter@example.test', ${JSON.stringify(BINDING)});
    });`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    input: '\n',
    encoding: 'utf8',
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--credential-stdin is empty/);
});
