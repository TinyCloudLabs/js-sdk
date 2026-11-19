// `StoredCredentialSource.find` authenticates a stored record with the offline verifier before any lifecycle
// rule runs, hands the verifier the caller's holder and requirement, refuses loose or hard-linked credential
// files, and `credential acquire` / `show` write exactly one JSON document to stdout.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoredCredentialSource } from '../dist/credential-source.js';
import { parseArgs } from '../dist/args.js';
import { cmdCredential } from '../dist/credential.js';
import { credentialRequirementDigest } from '@tinycloud/sdk-core';
import { generateHolderKey, makeWitness } from './support/witness-stub.mjs';
import { ADDRESS, credentialFilesIn, freshHome, removeHomes, requirement, resultFor, storedRecord } from './support/stored-record.mjs';

after(removeHomes);

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const acceptStandIn = async () => {};
/** Accepts only the untouched original record. */
const acceptOnly = (original) => async (input) => { assert.deepEqual(input.record, original, 'record differs from the original'); };
const digest = () => credentialRequirementDigest(requirement);
const agentKey = (holder, nowMs) => ({ v: 1, jwk: holder.jwk, did: holder.bare, createdAt: new Date(nowMs).toISOString() });

// Lifecycle fields the lifecycle rules read. Each edit makes the record look expired or stale if it were believed.
const lifecycleTampers = [
  { name: 'expiresAt moved to the past', mutate: (r) => ({ ...r, expiresAt: new Date(Date.now() - 3_600_000).toISOString() }) },
  { name: 'issuedAt moved 2 h earlier', mutate: (r) => ({ ...r, issuedAt: new Date(Date.parse(r.issuedAt) - 2 * 3_600_000).toISOString() }) },
  { name: 'issuedAt is not a date', mutate: (r) => ({ ...r, issuedAt: 'not-a-date' }), verifierNotReached: true },
  { name: 'expiresAt is not a date', mutate: (r) => ({ ...r, expiresAt: 'not-a-date' }), verifierNotReached: true },
];

for (const tamper of lifecycleTampers) {
  test(`find refuses and keeps a stored record whose ${tamper.name}; nothing is deleted before the verifier ran`, async () => {
    const home = freshHome();
    const holder = generateHolderKey();
    const nowMs = Date.now();
    const { file, original } = await storedRecord(home, holder, nowMs);
    writeFileSync(file, JSON.stringify(tamper.mutate(original), null, 2) + '\n');
    const before = readFileSync(file);
    const findWith = async (source) => source.find({ requirement, requirementDigest: await digest(), holderDid: holder.bare, now: new Date(nowMs) });

    const seen = [];
    const spy = async (input) => { seen.push({ fileExistedAtCall: existsSync(file) }); await acceptOnly(original)(input); };
    await assert.rejects(findWith(new StoredCredentialSource(home, spy)), { code: 'credential-record-invalid' });
    if (!tamper.verifierNotReached) assert.deepEqual(seen, [{ fileExistedAtCall: true }], 'the verifier runs first, with the file still present');
    await assert.rejects(findWith(new StoredCredentialSource(home)), { code: 'credential-record-invalid' });
    assert.ok(existsSync(file), 'a refused record is kept');
    assert.ok(readFileSync(file).equals(before), 'a refused record is byte-identical');
  });

  test(`courier credential show refuses a stored record whose ${tamper.name}: non-zero exit, empty stdout, file byte-identical`, async () => {
    const home = freshHome();
    const holder = generateHolderKey();
    const nowMs = Date.now();
    const { file, original } = await storedRecord(home, holder, nowMs);
    writeFileSync(join(home, 'key.json'), JSON.stringify(agentKey(holder, nowMs)), { mode: 0o600 });
    writeFileSync(file, JSON.stringify(tamper.mutate(original), null, 2) + '\n');
    const before = readFileSync(file);
    const run = spawnSync(process.execPath, [CLI, 'credential', 'show', '--email', ADDRESS], { env: { PATH: process.env.PATH, HOME: home, COURIER_HOME: home }, encoding: 'utf8' });
    assert.notEqual(run.status, 0, run.stderr);
    assert.match(run.stderr, /\[credential-record-invalid\]/, 'a tampered lifecycle field is refused, not reported as not found');
    assert.doesNotMatch(run.stderr, /NOT_FOUND/);
    assert.equal(run.stdout, '');
    assert.ok(existsSync(file), 'a refused record is kept');
    assert.ok(readFileSync(file).equals(before), 'a refused record is byte-identical');
  });
}

test('a verified record past the expiry margin is deleted only after the verifier accepted it, and reported as absent', async () => {
  const home = freshHome();
  const holder = generateHolderKey();
  const nowMs = Date.now();
  const { file, original } = await storedRecord(home, holder, nowMs);
  const expiresMs = Date.parse(original.expiresAt);
  const seen = [];
  const spy = async (input) => { seen.push(existsSync(file)); await acceptOnly(original)(input); };
  const source = new StoredCredentialSource(home, spy);
  const got = await source.find({ requirement, requirementDigest: await digest(), holderDid: holder.bare, now: new Date(expiresMs - 30_000) });
  assert.equal(got, undefined);
  assert.deepEqual(seen, [true], 'the verifier accepted the record while the file was still present');
  assert.equal(credentialFilesIn(home).length, 0, 'a verified credential inside the margin is dropped');
});

test('find hands the verifier the caller holder and requirement, not the record fields, and the record issuance instant as now', async () => {
  const home = freshHome();
  const holder = generateHolderKey();
  const other = generateHolderKey();
  const nowMs = Date.now();
  const { file, original } = await storedRecord(home, holder, nowMs);
  // A record claiming another holder, planted under this holder's file name.
  writeFileSync(file, JSON.stringify({ ...original, holderDid: other.bare, ownerDid: other.bare }, null, 2) + '\n');
  const seen = [];
  const spy = async (input) => { seen.push(input); };
  const callerNow = new Date(nowMs + 60_000);
  await new StoredCredentialSource(home, spy).find({ requirement, requirementDigest: await digest(), holderDid: holder.bare, now: callerNow });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].holderDid, holder.bare, 'the verifier is asked about the caller, not about the record holderDid');
  assert.notEqual(seen[0].record.holderDid, seen[0].holderDid);
  assert.equal(seen[0].requirement, requirement, 'the caller requirement is passed through');
  assert.equal(seen[0].now.getTime(), Date.parse(original.issuedAt), 'the record is authenticated at its own issuance instant');
  assert.notEqual(seen[0].now.getTime(), callerNow.getTime());
});

test('find refuses a credential file with loose permissions (0644) and leaves it untouched', async () => {
  const home = freshHome();
  const holder = generateHolderKey();
  const { file } = await storedRecord(home, holder, Date.now());
  chmodSync(file, 0o644);
  const before = readFileSync(file);
  let called = 0;
  await assert.rejects(
    new StoredCredentialSource(home, async () => { called += 1; }).find({ requirement, requirementDigest: await digest(), holderDid: holder.bare }),
    (error) => error.code === 'credential-permissions' && /owner-only/.test(error.message),
  );
  assert.equal(called, 0, 'a loose file is refused before any verification');
  assert.equal(statSync(file).mode & 0o777, 0o644, 'the mode is not changed');
  assert.ok(readFileSync(file).equals(before));
});

test('find refuses a credential file with more than one hard link and leaves it in place', async () => {
  const home = freshHome();
  const holder = generateHolderKey();
  const { file } = await storedRecord(home, holder, Date.now());
  linkSync(file, `${file}.link`);
  const before = readFileSync(file);
  let called = 0;
  await assert.rejects(
    new StoredCredentialSource(home, async () => { called += 1; }).find({ requirement, requirementDigest: await digest(), holderDid: holder.bare }),
    (error) => error.code === 'credential-permissions' && /hard links/.test(error.message),
  );
  assert.equal(called, 0);
  assert.ok(existsSync(file) && existsSync(`${file}.link`));
  assert.ok(readFileSync(file).equals(before));
});

/** Runs `cmdCredential` capturing stdout and stderr separately. */
async function runCredential(argv, deps) {
  const out = [];
  const err = [];
  await cmdCredential(parseArgs(argv), { ...deps, out: (text) => out.push(text), err: (text) => err.push(text) });
  return { stdout: out.join(''), stderr: err.join('') };
}

/** stdout is exactly one JSON document: it parses, and it is the document plus its trailing newline and nothing else. */
function assertOneJsonDocument(stdout) {
  const parsed = JSON.parse(stdout);
  assert.equal(stdout, `${JSON.stringify(parsed, null, 2)}\n`, 'nothing but the one JSON document is on stdout');
  return parsed;
}

test('acquire (both steps) and show each write exactly one JSON document to stdout, with hints on stderr', async () => {
  const home = freshHome();
  const holder = generateHolderKey();
  const nowMs = Date.now();
  const loadKey = () => agentKey(holder, nowMs);
  const witness = makeWitness();
  const base = { home, loadKey, fetch: witness.fetch, verifyStored: acceptStandIn };

  const step1 = await runCredential(['acquire', '--email', ADDRESS], base);
  const sent = assertOneJsonDocument(step1.stdout);
  assert.deepEqual(Object.keys(sent), ['ok', 'status', 'address', 'codeExpiresAt']);
  assert.equal(sent.status, 'code-sent');
  assert.match(step1.stderr, /Verification code sent/);

  const step2 = await runCredential(['acquire', '--email', ADDRESS, '--code-stdin'], {
    ...base,
    readStdinLine: async () => '12345678',
    completeProof: async () => resultFor(holder.bare, nowMs),
  });
  const acquired = assertOneJsonDocument(step2.stdout);
  assert.deepEqual(Object.keys(acquired), ['ok', 'status', 'address', 'issuedAt', 'expiresAt']);
  assert.equal(acquired.status, 'acquired');
  assert.match(step2.stderr, /Email credential stored/);

  const shown = await runCredential(['show', '--email', ADDRESS], { ...base, now: () => new Date(nowMs) });
  const record = assertOneJsonDocument(shown.stdout);
  assert.deepEqual(Object.keys(record), ['ok', 'address', 'credentialId', 'issuedAt', 'expiresAt', 'status']);
  assert.equal(shown.stderr, '', 'a successful show has nothing on stderr');
  assert.ok(!shown.stdout.includes('SD-JWT') && !shown.stdout.includes('~'), 'no credential bytes on stdout');
});

test('find refuses a stored date that is not a date even when the verifier accepts the record', async () => {
  for (const field of ['issuedAt', 'expiresAt']) {
    const home = freshHome();
    const holder = generateHolderKey();
    const { file, original } = await storedRecord(home, holder, Date.now());
    writeFileSync(file, JSON.stringify({ ...original, [field]: 'not-a-date' }, null, 2) + '\n');
    const before = readFileSync(file);
    await assert.rejects(
      new StoredCredentialSource(home, acceptStandIn).find({ requirement, requirementDigest: await digest(), holderDid: holder.bare }),
      { code: 'credential-record-invalid' },
      `${field} is not a date`,
    );
    assert.ok(readFileSync(file).equals(before), 'the record is kept byte-identical');
  }
});
