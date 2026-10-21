import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, createPublicKey } from 'node:crypto';
import { mkdtempSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from '../dist/args.js';
import { cmdCredential } from '../dist/credential.js';
import { savePendingEmailProof } from '../dist/credential-source.js';
import { EmailProofError } from '@tinycloud/web-sdk/credentials';

const WITNESS = 'https://witness.credentials.org';
const ADDRESS = 'qa.owner@example.test';
const CODE = '12345678';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const jwk = { ...privateKey.export({ format: 'jwk' }) };
const publicJwk = publicKey.export({ format: 'jwk' });
const DID = 'did:key:z6MkTestHolder';
const key = () => ({ v: 1, jwk, did: DID, createdAt: '2026-10-20T10:00:00Z' });

const freshHome = () => mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'courier-cred-test-'));
const credDir = (home) => join(home, 'credentials');
const modeOf = (p) => statSync(p).mode & 0o777;

function pendingFixture(now, over = {}) {
  return {
    type: 'TinyCloudEmailProofPending',
    version: 1,
    address: ADDRESS,
    requestId: 'req-1',
    verifier: 'verifier-secret-value',
    holderDid: DID,
    descriptorDigest: 'd'.repeat(64),
    requirementDigest: 'r'.repeat(64),
    openerOrigin: 'https://localhost',
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    ...over,
  };
}

function run(argv, deps) {
  const out = [];
  const promise = cmdCredential(parseArgs(argv), { loadKey: () => key(), out: (t) => out.push(t), ...deps });
  return { promise, out: () => out.join('') };
}

const NOW = new Date('2026-10-20T12:00:00Z');

test('acquire step 1 persists pending state 0600 in a 0700 dir and prints no verifier or request id', async () => {
  const home = freshHome();
  const seen = {};
  const { promise, out } = run(['acquire', '--email', ADDRESS], {
    home,
    now: () => NOW,
    requestCode: async (input) => {
      seen.address = input.address;
      seen.holderDid = input.holder.did;
      seen.pending = pendingFixture(NOW);
      return seen.pending;
    },
  });
  await promise;
  assert.equal(seen.address, ADDRESS);
  assert.equal(seen.holderDid, DID);
  assert.equal(modeOf(credDir(home)), 0o700);
  const files = readdirSync(credDir(home));
  assert.equal(files.length, 1);
  assert.equal(modeOf(join(credDir(home), files[0])), 0o600);
  const text = out();
  assert.match(text, /Verification code sent/);
  assert.ok(!text.includes(seen.pending.verifier), 'verifier must not be printed');
  assert.ok(!text.includes(seen.pending.requestId), 'request id must not be printed');
});

test('holder adapter signs with the agent key (Ed25519 verifies against the public key)', async () => {
  const home = freshHome();
  let holder;
  await run(['acquire', '--email', ADDRESS], {
    home,
    now: () => NOW,
    requestCode: async (input) => {
      holder = input.holder;
      return pendingFixture(NOW);
    },
  }).promise;
  const bytes = new TextEncoder().encode('holder binding canonical bytes');
  const signature = await holder.sign(bytes);
  assert.equal(signature.length, 64);
  assert.equal(verify(null, bytes, createPublicKey({ key: publicJwk, format: 'jwk' }), signature), true);
});

test('acquire step 1 maps witness RATE_LIMITED to stable code and whole-minute wait, and stores nothing', async () => {
  const home = freshHome();
  const cases = [
    [150_000, 'Try again in 3 minutes.'],
    [60_000, 'Try again in 1 minute.'],
    [1, 'Try again in 1 minute.'],
  ];
  for (const [retryAfterMs, phrase] of cases) {
    await assert.rejects(
      run(['acquire', '--email', ADDRESS], {
        home,
        now: () => NOW,
        requestCode: async () => {
          throw new EmailProofError('request', 'RATE_LIMITED', 'raw witness text', retryAfterMs);
        },
      }).promise,
      (error) => {
        assert.equal(error.code, 'credential.request.RATE_LIMITED');
        assert.ok(error.message.endsWith(phrase), `got: ${error.message}`);
        assert.ok(!error.message.includes('raw witness text'));
        return true;
      },
    );
  }
  assert.equal(existsSync(credDir(home)), false, 'no credential dir or pending file on rate limit');
});

test('acquire step 1 only talks to the witness origin (real requestEmailProofCode, stubbed fetch)', async () => {
  const home = freshHome();
  const urls = [];
  const fetchStub = async (input) => {
    urls.push(String(input.url ?? input));
    return new Response('unavailable', { status: 503 });
  };
  await assert.rejects(
    run(['acquire', '--email', ADDRESS], { home, now: () => NOW, fetch: fetchStub }).promise,
    (error) => {
      assert.match(error.code, /^credential\.request\./);
      return true;
    },
  );
  assert.ok(urls.length >= 1, 'discovery was attempted');
  for (const url of urls) {
    assert.equal(new URL(url).origin, WITNESS, `unexpected origin: ${url}`);
  }
  assert.equal(existsSync(credDir(home)), false);
});

test('acquire step 2 rejects a malformed code without echoing it and without touching the witness', async () => {
  for (const bad of ['1234', '1234567a', '123456789', '']) {
    const home = freshHome();
    let called = false;
    await assert.rejects(
      run(['acquire', '--email', ADDRESS, '--code', bad], {
        home,
        now: () => NOW,
        completeProof: async () => { called = true; throw new Error('unreachable'); },
      }).promise,
      (error) => {
        assert.equal(error.code, 'credential.code.CODE_INVALID');
        if (bad) assert.ok(!error.message.includes(bad));
        return true;
      },
    );
    assert.equal(called, false);
  }
  // Bare --code parses as 'true' and must be rejected.
  await assert.rejects(
    run(['acquire', '--email', ADDRESS, '--code'], { home: freshHome(), now: () => NOW }).promise,
    (error) => error.code === 'credential.code.CODE_INVALID',
  );
});

test('acquire step 2 without a pending request fails with credential-request-missing', async () => {
  const home = freshHome();
  let called = false;
  await assert.rejects(
    run(['acquire', '--email', ADDRESS, '--code', CODE], {
      home,
      now: () => NOW,
      completeProof: async () => { called = true; },
    }).promise,
    (error) => error.code === 'credential-request-missing' && !error.message.includes(CODE),
  );
  assert.equal(called, false);
});

test('acquire step 2 deletes expired pending state and does not call the witness', async () => {
  const home = freshHome();
  savePendingEmailProof(pendingFixture(NOW, { expiresAt: new Date(NOW.getTime() - 1000).toISOString() }), home);
  assert.equal(readdirSync(credDir(home)).length, 1);
  let called = false;
  await assert.rejects(
    run(['acquire', '--email', ADDRESS, '--code', CODE], {
      home,
      now: () => NOW,
      completeProof: async () => { called = true; },
    }).promise,
    (error) => error.code === 'credential-session-expired',
  );
  assert.equal(called, false);
  assert.equal(readdirSync(credDir(home)).length, 0, 'expired pending file deleted');
});

test('acquire step 2 refuses pending state bound to a different holder and deletes it', async () => {
  const home = freshHome();
  savePendingEmailProof(pendingFixture(NOW, { holderDid: 'did:key:z6MkOther' }), home);
  let called = false;
  await assert.rejects(
    run(['acquire', '--email', ADDRESS, '--code', CODE], {
      home,
      now: () => NOW,
      completeProof: async () => { called = true; },
    }).promise,
    (error) => error.code === 'credential.session.SESSION_INVALID',
  );
  assert.equal(called, false);
  assert.equal(readdirSync(credDir(home)).length, 0);
});

test('a rejected code maps to a per-step code, deletes pending state, and never echoes code or verifier', async () => {
  const home = freshHome();
  savePendingEmailProof(pendingFixture(NOW), home);
  let sentCode;
  await assert.rejects(
    run(['acquire', '--email', ADDRESS, '--code', CODE], {
      home,
      now: () => NOW,
      completeProof: async (input) => {
        sentCode = input.code;
        throw new EmailProofError('code', 'CODE_REJECTED', 'witness said no');
      },
    }).promise,
    (error) => {
      assert.equal(error.code, 'credential.code.CODE_REJECTED');
      assert.ok(!error.message.includes(CODE));
      assert.ok(!error.message.includes('verifier-secret-value'));
      return true;
    },
  );
  assert.equal(sentCode, CODE, 'code is passed to the witness flow only');
  assert.equal(readdirSync(credDir(home)).length, 0, 'failure deletes pending state');
});

test('an attempts-exhausted or unexpected failure also deletes pending state', async () => {
  const home = freshHome();
  savePendingEmailProof(pendingFixture(NOW), home);
  await assert.rejects(
    run(['acquire', '--email', ADDRESS, '--code', CODE], {
      home,
      now: () => NOW,
      completeProof: async () => { throw new Error('network blew up with ' + CODE); },
    }).promise,
    (error) => error.code === 'credential.credential.FAILED' && !error.message.includes(CODE),
  );
  assert.equal(readdirSync(credDir(home)).length, 0);
});

test('show without a stored credential fails with NOT_FOUND and prints nothing', async () => {
  const home = freshHome();
  const { promise, out } = run(['show', '--email', ADDRESS], { home, now: () => NOW });
  await assert.rejects(promise, (error) => error.code === 'credential.show.NOT_FOUND');
  assert.equal(out(), '');
});

test('unknown subcommand prints usage', async () => {
  await assert.rejects(
    run(['bogus'], { home: freshHome(), now: () => NOW }).promise,
    (error) => error.code === 'usage' && /credential acquire/.test(error.message),
  );
});
