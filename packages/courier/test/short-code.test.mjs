import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { grantFromInput, isShortCode, resolveOpenKeyApiHost } from '../dist/grant.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const key = {
  did: 'did:key:z6Mkagent#z6Mkagent',
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'public-x', d: 'private-d' },
};

function delegation(overrides = {}) {
  return {
    delegationHeader: { Authorization: 'Bearer session' },
    delegationCid: 'cid',
    spaceId: 'tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:agents',
    address: '0x0000000000000000000000000000000000000001',
    chainId: 1,
    siwe: 'SIWE',
    signature: 'signature',
    verificationMethod: key.did,
    jwk: { kty: 'OKP', crv: 'Ed25519', x: 'public-x' },
    ...overrides,
  };
}

/** Fake OpenKey API on 127.0.0.1:0; `respond(req, res)` handles every request. */
async function fakeApi(respond) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    respond(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

const json = (status, body) => (_req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
};

test('short code pattern matches OpenKey XXXX-XXXX codes only', () => {
  assert.equal(isShortCode('ABCD-EFGH'), true);
  assert.equal(isShortCode('abcd-2345'), true);
  assert.equal(isShortCode(' ABCD-EFGH\n'), true);
  assert.equal(isShortCode('ABCD-EFG1'), false);
  assert.equal(isShortCode('ABCDEFGH'), false);
  assert.equal(isShortCode(JSON.stringify(delegation())), false);
});

test('short code is lowercased and redeemed at the API host', async () => {
  const api = await fakeApi(json(200, { delegation: delegation() }));
  try {
    const grant = await grantFromInput(' ABCD-EFGH\n', key, { apiHost: api.url });
    assert.equal(grant.delegationCid, 'cid');
    assert.deepEqual(api.seen, ['/api/delegation-codes/abcd-efgh']);
  } finally {
    await api.close();
  }
});

test('short code lookup errors are clear', async () => {
  const notFound = await fakeApi(json(404, { error: 'not found' }));
  try {
    await assert.rejects(grantFromInput('ABCD-EFGH', key, { apiHost: notFound.url }), { code: 'code-not-found', message: /not found or expired/ });
  } finally {
    await notFound.close();
  }

  const unavailable = await fakeApi(json(503, { error: 'down' }));
  try {
    await assert.rejects(grantFromInput('ABCD-EFGH', key, { apiHost: unavailable.url }), { code: 'code-lookup-failed', message: /503/ });
  } finally {
    await unavailable.close();
  }

  const target = await fakeApi(json(200, { delegation: delegation() }));
  const redirect = await fakeApi((_req, res) => res.writeHead(302, { Location: `${target.url}/api/delegation-codes/abcd-efgh` }).end());
  try {
    await assert.rejects(grantFromInput('ABCD-EFGH', key, { apiHost: redirect.url }), { code: 'code-lookup-failed' });
    assert.deepEqual(target.seen, []);
  } finally {
    await redirect.close();
    await target.close();
  }
});

test('redeemed delegation must be bound to this agent key', async () => {
  const { jwk: _jwk, ...noJwk } = delegation();
  const { siwe: _siwe, ...noSiwe } = delegation();
  const cases = [
    delegation({ verificationMethod: 'did:key:z6Mkother#z6Mkother' }),
    noJwk,
    delegation({ jwk: { kty: 'OKP', crv: 'Ed25519', x: 'other-x' } }),
    delegation({ jwk: { kty: 'OKP', crv: 'Ed25519', x: 'public-x', d: 'leaked' } }),
    delegation({ jwk: { kty: 'EC', crv: 'Ed25519', x: 'public-x' } }),
    noSiwe,
  ];
  for (const body of cases) {
    const api = await fakeApi(json(200, { delegation: body }));
    try {
      await assert.rejects(grantFromInput('ABCD-EFGH', key, { apiHost: api.url }), { code: 'bad-grant' });
    } finally {
      await api.close();
    }
  }
});

test('OpenKey API host resolution: flag > env > derived', () => {
  assert.equal(resolveOpenKeyApiHost({ openkeyHost: 'https://openkey.so' }), 'https://api.openkey.so');
  assert.equal(resolveOpenKeyApiHost({ openkeyHost: 'https://openkey.so/' }), 'https://api.openkey.so');
  assert.equal(resolveOpenKeyApiHost({ openkeyHost: 'https://ok.example/' }), 'https://ok.example');
  assert.equal(resolveOpenKeyApiHost({ openkeyHost: 'https://openkey.so', env: 'https://env.example/' }), 'https://env.example');
  assert.equal(resolveOpenKeyApiHost({ openkeyHost: 'https://openkey.so', env: 'https://env.example', flag: 'https://flag.example/' }), 'https://flag.example');
});

function runCli(args, { home, stdin }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, COURIER_HOME: home, COURIER_OPENKEY_API_HOST: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

for (const mode of [['--paste'], ['--grant-file', '-']]) {
  test(`init ${mode.join(' ')} redeems a short code and rejects a delegation for another key`, async () => {
    const other = delegation({ verificationMethod: 'did:key:z6Mkother#z6Mkother', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'other-x' } });
    const api = await fakeApi(json(200, { delegation: other }));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-short-code-'));
    try {
      const result = await runCli(['init', ...mode, '--openkey-api-host', api.url], { home, stdin: 'ABCD-EFGH\n' });
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /\[bad-grant\]/);
      assert.deepEqual(api.seen, ['/api/delegation-codes/abcd-efgh']);
      assert.equal(fs.existsSync(path.join(home, 'grant.json')), false);
    } finally {
      await api.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
