// A synthetic OpenKey + links API for Courier's approval-request flow (TC-2300), modelled on the CLI's
// onboard.e2e.test.ts / approval-request.test.ts fixtures. It is the independent side of the wire contract:
// it verifies every session proof with node:crypto, recomputes the credential hash itself, opens the stored
// request the way OpenKey's /a/ page does (link key from the fragment), signs a real SIWE grant with a throwaway
// wallet through the wasm session manager, and encrypts the result with node:crypto's ECDH/HMAC/AES-GCM.
// `globalThis.fetch` is replaced; any URL it does not know throws, so nothing in a test can reach a real service.
// Not a test file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCipheriv, createECDH, createHash, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from '@tinycloud/node-sdk';
import { checkLinkRecord, openLinkRecord, parseApprovalRequest } from '@tinycloud/share-envelope/links';
import { AGENT_GRANT, COURIER_SPACE } from '../../dist/keys.js';
import { main } from '../../dist/main.js';

export const LINKS_ORIGIN = 'https://links.fixture.test';
export const OPENKEY_API = 'https://api.openkey.fixture.test';
export const DAY = 86_400_000;
const wasm = new NodeWasmBindings();

export class Crash extends Error {
  constructor(where) { super(`CRASH at ${where}`); this.name = 'Crash'; }
}

/** The environment every flow test needs: fixture origins, nothing that can reach production. */
export function useFixtureEnv(t) {
  const previous = { links: process.env.TC_LINKS_API_ORIGIN, api: process.env.COURIER_OPENKEY_API_HOST };
  process.env.TC_LINKS_API_ORIGIN = LINKS_ORIGIN;
  process.env.COURIER_OPENKEY_API_HOST = OPENKEY_API;
  t.after(() => {
    for (const [name, value] of [['TC_LINKS_API_ORIGIN', previous.links], ['COURIER_OPENKEY_API_HOST', previous.api]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

export function homeFile(name) {
  return path.join(process.env.COURIER_HOME, name);
}

export function readHome(name) {
  return JSON.parse(fs.readFileSync(homeFile(name), 'utf8'));
}

/** Run `fn` with process.stdout.write captured (and restored before returning, so the test reporter is unaffected). */
export async function captureStdout(fn) {
  const original = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk, ...rest) => {
    // The test runner streams its own binary events through stdout; only Courier's string output is captured.
    if (typeof chunk !== 'string') return original.call(process.stdout, chunk, ...rest);
    out += chunk;
    return true;
  };
  try { return { result: await fn(), stdout: out }; }
  finally { process.stdout.write = original; }
}

/**
 * A grant exactly as OpenKey signs one for `agent`: the AGENT_GRANT set (plus `extra`) on the owner's agents space.
 * `hooksPath` replaces the path of the hooks permission (a retyped or widened scope).
 */
export async function signedGrant(agent, { extra = [], omit = [], lifetimeMs = 30 * DAY, wallet = randomBytes(32).toString('hex'), hooksPath } = {}) {
  const signer = new PrivateKeySigner(wallet);
  const address = await signer.getAddress();
  const chainId = 1;
  const spaceId = wasm.makeSpaceId(address, chainId, COURIER_SPACE);
  const abilities = {};
  const granted = AGENT_GRANT.filter((entry) => !omit.includes(entry.service))
    .map((entry) => (hooksPath !== undefined && entry.service === 'tinycloud.hooks' ? { ...entry, path: hooksPath } : entry));
  for (const permission of [...granted, ...extra]) {
    const service = permission.service.replace(/^tinycloud\./, '');
    const actions = abilities[service] ??= {};
    (actions[permission.path] ??= []).push(...permission.actions);
  }
  const issuedAt = new Date();
  const prepared = wasm.prepareSession({
    abilities, address, chainId, domain: 'courier.fixture.test', issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + lifetimeMs).toISOString(), spaceId, jwk: agent.jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const { d: _private, ...publicJwk } = agent.jwk;
  return {
    delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, address, chainId,
    siwe: prepared.siwe, signature, verificationMethod: agent.did, jwk: publicJwk,
  };
}

export const grantExtraHost = () => ({ service: 'tinycloud.space', space: 'agents', path: '', actions: ['tinycloud.space/host'] });

function sealRelay(publicJwk, requestId, plaintext) {
  const ephemeral = createECDH('prime256v1');
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x, 'base64url'), Buffer.from(publicJwk.y, 'base64url')]));
  const extracted = createHmac('sha256', Buffer.from(requestId)).update(shared).digest();
  const key = createHmac('sha256', extracted).update('openkey-device-relay-v1').update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(requestId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const point = ephemeral.getPublicKey();
  return {
    version: 1, algorithm: 'ECDH-P256-A256GCM',
    ephemeralPublicJwk: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
    nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'),
  };
}

const json = (value, status = 200) => Response.json(value, { status });

/**
 * Install the fake services. Returns the control surface:
 *   created   - every request stored at the links API: { id, record, link? }
 *   calls     - every OpenKey result call: { action, requestId, resultRef }
 *   acks      - every ack: { ackId, resultRef, saved: { grant, profileStatus, pending } } (disk state at the moment of the ack)
 *   approve(link, options) - the owner approves the request behind `link`
 */
export function installFakeOpenKey(t) {
  const created = [];
  const calls = [];
  const acks = [];
  const approvals = new Map();
  const control = {
    created, calls, acks, approvals,
    pollsBeforeApproval: 0,
    autoApprove: undefined,
    dropNextAck: false,
    linksStatus: 200,
    expiredRequests: new Set(),
    expiredResults: new Set(),
    /** One-shot OpenKey error replies, consumed in order by the next `discover` / `fetch` call: { status, code }. */
    inject: { discover: [], fetch: [] },
  };
  const polls = new Map();

  async function sign(request, link, options) {
    const key = JSON.parse(fs.readFileSync(homeFile('key.json'), 'utf8'));
    // OpenKey signs the lifetime the request asked for unless the owner chose less; tests override it through options.grant.
    const grant = await signedGrant(key, { lifetimeMs: request.grantLifetimeSeconds * 1000, ...(options.grant ?? {}) });
    const bodyCid = new URL(link).hash.match(/c=([^&]+)/)[1];
    const id = new URL(link).pathname.split('/')[2];
    const expiresAt = new Date(Date.parse(grant.siwe.match(/^Expiration Time:\s*(.+)$/m)[1])).toISOString();
    const delegation = { ...grant, ...(options.delegation ?? {}) };
    const plaintext = {
      resultVersion: 1, requestId: id, requestDigest: bodyCid, requesterDid: request.issuer,
      ownerDid: `did:pkh:eip155:${grant.chainId}:${grant.address}`, targetDid: request.targetDid,
      delegationExpiresAt: expiresAt, delegation, ...(options.result ?? {}),
    };
    return { relay: sealRelay(request.resultEncryptionPublicJwk, id, plaintext), grant };
  }

  /** The request the owner would see behind `link`: the stored record opened with the key from the link fragment. */
  control.openRequest = async (link) => {
    const stored = created.find((item) => item.id === new URL(link).pathname.split('/')[2]);
    assert.ok(stored, 'no stored request for that link');
    const key = Buffer.from(new URLSearchParams(new URL(link).hash.slice(1)).get('k'), 'base64url');
    return parseApprovalRequest((await openLinkRecord(stored.record, key)).value);
  };

  /** The owner approves the request behind `link`. `options.grant` changes what is signed; `options.result`/`delegation` tamper the envelope. */
  control.approve = async (link, options = {}) => {
    const id = new URL(link).pathname.split('/')[2];
    const request = await control.openRequest(link);
    const { relay, grant } = await sign(request, link, options);
    // `grant` is what the owner signed (header, signature, CID): tests use it to look for it in output; it is never sent in the clear.
    approvals.set(id, {
      resultRef: `result-ref-${randomBytes(12).toString('hex')}`,
      expiresAt: new Date(Date.now() + (options.retentionMs ?? 600_000)).toISOString(),
      relay, grant, request,
    });
    return request;
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === `${LINKS_ORIGIN}/v1/links`) {
      if (control.linksStatus !== 200) return json({ error: 'unavailable' }, control.linksStatus);
      const record = JSON.parse(init.body);
      const checked = await checkLinkRecord(record, Date.now());
      assert.equal(checked.header.audience, LINKS_ORIGIN, 'the record must be addressed to the configured links API');
      const id = Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join('');
      created.push({ id, record });
      return json({ id, expiresAt: checked.header.expiresAt }, 201);
    }
    if (!url.startsWith(`${OPENKEY_API}/api/approval-`)) throw new Error(`unexpected network call: ${url}`);
    const body = JSON.parse(init.body);
    const [, , kind, ref, action] = new URL(url).pathname.split('/');
    const act = kind === 'approval-requests' ? 'discover' : action;
    const requestId = kind === 'approval-requests' ? ref : body.requestId;
    const stored = created.find((item) => item.id === requestId);
    // Session proof, verified independently of the client.
    const [header, payload, signature] = (init.headers['OpenKey-Session-Proof'] ?? '').split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString() || '{}');
    const agentKey = JSON.parse(fs.readFileSync(homeFile('key.json'), 'utf8'));
    const credential = JSON.stringify([act, requestId, body.bodyCid, act === 'discover' ? '' : ref, act === 'ack' ? body.ackId : '']);
    const valid = verify(null, Buffer.from(`${header}.${payload}`), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: agentKey.jwk.x }, format: 'jwk' }),
      Buffer.from(signature ?? '', 'base64url'))
      && claims.client_id === 'openkey-approval-result-v1' && claims.htm === 'POST' && claims.htu === url
      && claims.cred_hash === createHash('sha256').update(credential).digest('base64url');
    if (!valid || !stored) return json({ code: valid ? 'not_found' : 'invalid_proof' }, valid ? 404 : 401);
    calls.push({ action: act, requestId, resultRef: act === 'discover' ? undefined : ref });
    const injected = (control.inject[act] ?? []).shift();
    if (injected?.network) throw new TypeError('fetch failed');
    if (injected) return json({ code: injected.code, ...(injected.message ? { message: injected.message } : {}) }, injected.status);
    if (control.expiredRequests.has(requestId) && act === 'discover') return json({ code: 'expired_request' }, 410);
    if (act === 'discover') {
      if (!approvals.has(requestId) && control.autoApprove) {
        const count = (polls.get(requestId) ?? 0) + 1;
        polls.set(requestId, count);
        if (count > control.pollsBeforeApproval) {
          await control.approve(readHome('approval-pending.json').approvalUrl, control.autoApprove.options);
        }
      }
      const approval = approvals.get(requestId);
      if (!approval) return new Response(null, { status: 202 });
      return json({ resultRef: approval.resultRef, expiresAt: approval.expiresAt });
    }
    const approval = approvals.get(requestId);
    if (!approval || approval.resultRef !== ref) return json({ code: 'not_found' }, 404);
    if (control.expiredResults.has(requestId)) return json({ code: 'expired_result' }, 410);
    if (act === 'fetch') {
      return json({ requestId, bodyCid: body.bodyCid, resultRef: ref, expiresAt: approval.expiresAt, relay: approval.relay });
    }
    if (control.dropNextAck) { control.dropNextAck = false; throw new TypeError('fetch failed'); }
    const profileFile = homeFile('profile.json');
    const pendingFile = homeFile('approval-pending.json');
    acks.push({
      ackId: body.ackId, resultRef: ref,
      saved: {
        grant: fs.existsSync(homeFile('grant.json')) ? readHome('grant.json') : undefined,
        profileStatus: fs.existsSync(profileFile) ? readHome('profile.json').status : undefined,
        pending: fs.existsSync(pendingFile) ? readHome('approval-pending.json') : undefined,
      },
    });
    const prior = approval.ackId;
    if (prior && prior !== body.ackId) return json({ code: 'ack_conflict' }, 409);
    approval.ackId = body.ackId;
    return json({ ackId: body.ackId, status: 'acknowledged' });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return control;
}

/** Stub the space probe (`node.kv.list`) the way trust.test.mjs does. */
export function stubSpaceProbe(t, probe) {
  const descriptor = Object.getOwnPropertyDescriptor(TinyCloudNode.prototype, 'kv');
  Object.defineProperty(TinyCloudNode.prototype, 'kv', { configurable: true, get: () => ({ list: probe }) });
  t.after(() => Object.defineProperty(TinyCloudNode.prototype, 'kv', descriptor));
}

export const readySpace = async () => ({ ok: true, data: { keys: [] } });
export const missingSpace = async () => ({ ok: false, error: { status: 404, message: 'Space not found' } });

/**
 * Fake time for waits: Date.now advances by exactly what is slept and sleeping returns immediately.
 * Returns { elapsed, sleeps }.
 */
export function fakeTime(t) {
  const started = Date.now();
  let elapsed = 0;
  const sleeps = [];
  t.mock.method(Date, 'now', () => started + elapsed);
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    sleeps.push(ms);
    elapsed += ms;
    queueMicrotask(callback);
    return 0;
  });
  return { elapsed: () => elapsed, sleeps };
}

/**
 * Simulate process death at a file write boundary: the Nth write (rename into place) of `file` whose parsed content
 * satisfies `when` either never happens (`before`) or happens and then the process dies (`after`). The thrown Crash
 * is not a CourierError, so no cleanup or error handling that a real kill would skip can run.
 */
export function crashAtWrite(t, file, { phase, when = () => true, nth = 1 }) {
  const original = fs.renameSync;
  let seen = 0;
  let fired = false;
  fs.renameSync = (from, to) => {
    if (!fired && path.basename(String(to)) === file) {
      const content = JSON.parse(fs.readFileSync(from, 'utf8'));
      if (when(content) && ++seen === nth) {
        fired = true;
        if (phase === 'after') original(from, to);
        throw new Crash(`${phase} writing ${file}`);
      }
    }
    return original(from, to);
  };
  t.after(() => { fs.renameSync = original; });
  return { fired: () => fired, disarm: () => { fs.renameSync = original; } };
}

function withHome(run) {
  const previous = process.env.COURIER_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-approval-'));
  process.env.COURIER_HOME = path.join(home, 'courier');
  return Promise.resolve().then(() => run(home)).finally(() => {
    if (previous === undefined) delete process.env.COURIER_HOME; else process.env.COURIER_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

/**
 * One test in a fresh COURIER_HOME with the fake services installed. The body gets { t, fx, errors, courier, request }:
 * `courier(...argv)` runs `courier init <argv>` in-process and returns { code, stdout, stderr } (stderr accumulates across
 * calls of the test); `request(...argv)` runs `init --request` and returns its parsed JSON.
 */
export function scenario(name, options, body) {
  const [run, opts] = body === undefined ? [options, {}] : [body, options];
  test(name, opts, (t) => withHome(async () => {
    useFixtureEnv(t);
    const fx = installFakeOpenKey(t);
    const errors = [];
    t.mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
    const courier = async (...argv) => {
      const { result, stdout } = await captureStdout(() => main(['init', ...argv]));
      return { code: result, stdout, stderr: errors.join('\n') };
    };
    const request = async (...argv) => {
      const first = await courier('--request', ...argv);
      assert.equal(first.code, 0, first.stderr);
      return JSON.parse(first.stdout);
    };
    await run({ t, fx, errors, courier, request });
  }));
}
