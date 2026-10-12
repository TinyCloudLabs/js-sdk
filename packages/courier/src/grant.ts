import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { TinyCloudNode, NodeWasmBindings } from '@tinycloud/node-sdk';
import type { PermissionEntry } from '@tinycloud/node-sdk';
import { cmd } from './program.js';
import { CourierError } from './errors.js';
import { AGENT_GRANT, AGENT_GRANT_EXPIRY, COURIER_SPACE, k } from './keys.js';
import { loadGrant, saveGrant, saveProfile, type AgentKey, type OwnerGrant, type Profile } from './profile.js';
import { nodeOpts } from './node.js';
import { listAll } from './store.js';
import { assertAgentGrant, siweTimes } from './authority.js';

const PRIVATE_JWK_FIELDS = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);

export interface DelegateRequest {
  openkeyHost: string;
  /** Where OpenKey short `XXXX-XXXX` codes are redeemed; see resolveOpenKeyApiHost. */
  openkeyApiHost: string;
  did: string;
  publicJwk: Record<string, unknown>;
  host: string;
  permissions: PermissionEntry[];
  reason: string;
  expiry?: string;
  callback?: string;
}

export interface GrantPayload {
  delegationHeader: { Authorization: string };
  delegationCid: string;
  spaceId: string;
  address: string;
  chainId: number;
  siwe: string;
  signature: string;
  verificationMethod: string;
  jwk?: Record<string, unknown>;
  spaceReady?: boolean | null;
  spacePending?: boolean;
}

export function openKeyDelegateUrl(request: DelegateRequest): string {
  const params = new URLSearchParams({ did: request.did, host: request.host, reason: request.reason, expiry: request.expiry ?? AGENT_GRANT_EXPIRY, protocolVersion: '1' });
  if (request.callback) params.set('callback', request.callback);
  const publicJwk = Object.fromEntries(Object.entries(request.publicJwk).filter(([key]) => !PRIVATE_JWK_FIELDS.has(key)));
  params.set('jwk', Buffer.from(JSON.stringify(publicJwk)).toString('base64url'));
  params.set('permissions', Buffer.from(JSON.stringify({ permissions: request.permissions, reason: request.reason })).toString('base64url'));
  return `${request.openkeyHost.replace(/\/$/, '')}/delegate?${params}`;
}

function decodePayload(raw: string): unknown {
  const value = raw.trim();
  try { return JSON.parse(value); } catch { /* base64url JSON */ }
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { /* base64 JSON */ }
  try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')); } catch {
    throw new CourierError('bad-grant', 'Grant code must be JSON or base64-encoded JSON.');
  }
}

export function parseGrantPayload(raw: unknown, key: Pick<AgentKey, 'did' | 'jwk'>): GrantPayload {
  const value = typeof raw === 'string' ? decodePayload(raw) : raw;
  if (!value || typeof value !== 'object') throw new CourierError('bad-grant', 'Grant payload must be an object.');
  const grant = value as Record<string, unknown>;
  const header = grant.delegationHeader as Record<string, unknown> | undefined;
  const requiredStrings = ['delegationCid', 'spaceId', 'address', 'siwe', 'signature', 'verificationMethod'] as const;
  for (const field of requiredStrings) {
    if (typeof grant[field] !== 'string' || !grant[field]) throw new CourierError('bad-grant', `Grant payload is missing ${field}.`);
  }
  if (typeof header?.Authorization !== 'string' || !header.Authorization) throw new CourierError('bad-grant', 'Grant payload is missing delegationHeader.Authorization.');
  if (typeof grant.chainId !== 'number' || !Number.isInteger(grant.chainId) || grant.chainId <= 0) throw new CourierError('bad-grant', 'Grant payload has an invalid chainId.');
  if (String(grant.verificationMethod).split('#')[0] !== key.did.split('#')[0]) throw new CourierError('bad-grant', 'Grant verification method does not match this agent key.');
  if (grant.jwk && typeof grant.jwk === 'object' && (grant.jwk as Record<string, unknown>).x !== key.jwk.x) throw new CourierError('bad-grant', 'Grant public key does not match this agent key.');
  return grant as unknown as GrantPayload;
}

const DEFAULT_OPENKEY_HOST = 'https://openkey.so';
const DEFAULT_OPENKEY_API_HOST = 'https://api.openkey.so';

/** An OpenKey short delegation code, e.g. `ABCD-EFGH`; same pattern as `tc`. */
export function isShortCode(input: string): boolean {
  return /^[a-z2-7]{4}-[a-z2-7]{4}$/i.test(input.trim());
}

/**
 * The OpenKey API host that redeems short codes: flag > env > derived.
 * Derived is api.openkey.so for openkey.so, otherwise the OpenKey host itself.
 */
export function resolveOpenKeyApiHost(options: { flag?: string; env?: string; openkeyHost: string }): string {
  const strip = (host: string) => host.replace(/\/+$/, '');
  if (options.flag) return strip(options.flag);
  if (options.env) return strip(options.env);
  const openkeyHost = strip(options.openkeyHost);
  return openkeyHost === DEFAULT_OPENKEY_HOST ? DEFAULT_OPENKEY_API_HOST : openkeyHost;
}

async function redeemShortCode(code: string, apiHost: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${apiHost.replace(/\/+$/, '')}/api/delegation-codes/${code.trim().toLowerCase()}`, { redirect: 'error' });
  } catch (error) {
    throw new CourierError('code-lookup-failed', `Could not reach OpenKey at ${apiHost} to redeem the code: ${(error as Error).message}`);
  }
  if (response.status === 404) {
    throw new CourierError('code-not-found', 'Delegation code not found or expired. Paste the full grant code shown in OpenKey instead.');
  }
  if (!response.ok) throw new CourierError('code-lookup-failed', `Could not redeem the delegation code (HTTP ${response.status}).`);
  let body: unknown;
  try { body = await response.json(); } catch {
    throw new CourierError('code-lookup-failed', 'OpenKey returned invalid JSON for the delegation code.');
  }
  return (body as { delegation?: unknown } | null)?.delegation;
}

/** Same binding checks as `tc`'s delegationFromInput: the redeemed delegation must be for this agent key. */
function assertBoundToKey(delegation: unknown, key: Pick<AgentKey, 'did' | 'jwk'>): void {
  const value = delegation as Record<string, unknown> | null | undefined;
  const jwk = value?.jwk as Record<string, unknown> | undefined;
  if (
    typeof value?.verificationMethod !== 'string'
    || value.verificationMethod.split('#')[0] !== key.did.split('#')[0]
    || !jwk || typeof jwk !== 'object' || Array.isArray(jwk)
    || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519'
    || typeof jwk.x !== 'string' || jwk.x !== key.jwk.x
    || [...PRIVATE_JWK_FIELDS].some((field) => field in jwk)
  ) {
    throw new CourierError('bad-grant', 'Delegation is bound to a different Courier agent key.');
  }
}

/**
 * Parse a grant from what the human pasted or OpenKey posted: an OpenKey short
 * `XXXX-XXXX` code (redeemed at `apiHost`), JSON, or base64 JSON.
 */
export async function grantFromInput(input: unknown, key: Pick<AgentKey, 'did' | 'jwk'>, options: { apiHost: string }): Promise<GrantPayload> {
  if (typeof input === 'string' && isShortCode(input)) {
    const delegation = await redeemShortCode(input, options.apiHost);
    assertBoundToKey(delegation, key);
    return parseGrantPayload(delegation, key);
  }
  return parseGrantPayload(input, key);
}

export async function receiveGrant(request: DelegateRequest, options: { paste?: boolean } = {}): Promise<GrantPayload> {
  const timeoutMs = 10 * 60 * 1000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    let readline: ReturnType<typeof createInterface> | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    const finish = (error?: Error, payload?: GrantPayload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server?.close();
      readline?.close();
      if (error) reject(error);
      else resolve(payload!);
    };
    const parse = async (value: unknown): Promise<Error | undefined> => {
      try { finish(undefined, await grantFromInput(value, { jwk: request.publicJwk, did: request.did }, { apiHost: request.openkeyApiHost })); }
      catch (error) { return error as Error; }
      return undefined;
    };

    timer = setTimeout(() => finish(new CourierError('grant-timeout', 'OpenKey authorization timed out after 10 minutes.')), timeoutMs);
    const promptForPaste = (url: string, listenForCodes = true) => {
      console.error(`Open this URL in a browser to approve the Courier agent grant:\n${url}`);
      if (listenForCodes && process.stdin.isTTY) {
        readline = createInterface({ input: process.stdin, output: process.stderr });
        readline.on('line', async (line) => {
          const err = await parse(line);
          if (err) console.error(`Invalid grant code: ${err.message}`);
        });
      }
    };
    if (options.paste) {
      const url = openKeyDelegateUrl(request);
      promptForPaste(url, false);
      readline ??= createInterface({ input: process.stdin, output: process.stderr });
      readline.question('Paste grant code or XXXX-XXXX short code: ', async (line) => {
        const err = await parse(line);
        if (err) finish(err);
      });
      return;
    }

    server = createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        res.end();
        return;
      }
      if (req.method !== 'POST' || req.url !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        body += chunk.toString();
        if (body.length > 1024 * 1024) {
          tooLarge = true;
          res.writeHead(413, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: 'Grant payload too large' }));
          finish(new CourierError('bad-grant', 'OpenKey grant payload exceeds 1 MiB.'));
        }
      });
      req.on('end', async () => {
        if (tooLarge) return;
        let value: unknown;
        try { value = JSON.parse(body); }
        catch {
          res.writeHead(400, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON' }));
          finish(new CourierError('bad-grant', 'OpenKey returned invalid JSON.'));
          return;
        }
        const err = await parse(value);
        if (err) {
          res.writeHead(400, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
          finish(err);
          return;
        }
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      if (!address || typeof address === 'string') {
        finish(new CourierError('grant-callback', 'Could not start the OpenKey callback server.'));
        return;
      }
      const callback = `http://127.0.0.1:${address.port}/callback`;
      promptForPaste(openKeyDelegateUrl({ ...request, callback }));
    });
  });
}

function ownerSpaceId(payload: GrantPayload): string {
  return `tinycloud:pkh:eip155:${payload.chainId}:${payload.address}:${COURIER_SPACE}`;
}

async function restoreVerifiedGrant(profile: Profile, key: AgentKey, payload: GrantPayload): Promise<{ node: TinyCloudNode; expiresAt: Date }> {
  const times = siweTimes(payload.siwe);
  const expiresAt = times.expiresAt;
  if (!expiresAt || expiresAt.getTime() <= Date.now()) throw new CourierError('bad-grant', 'OpenKey grant is missing a future SIWE expiry.');
  const node = new TinyCloudNode(nodeOpts(profile.host));
  await node.restoreSession({
    delegationHeader: payload.delegationHeader,
    delegationCid: payload.delegationCid,
    spaceId: payload.spaceId,
    jwk: key.jwk,
    verificationMethod: payload.verificationMethod,
    address: payload.address,
    chainId: payload.chainId,
    siwe: payload.siwe,
    signature: payload.signature,
    expiresAt: expiresAt.toISOString(),
    tinycloudHosts: [profile.host],
  });
  assertAgentGrant(node.getVerifiedSessionCapabilities(), times);
  if (node.credentialHolderDid !== profile.courierDid) {
    throw new CourierError('bad-grant', `Grant holder ${node.credentialHolderDid} does not match courier key ${profile.courierDid}.`);
  }
  return { node, expiresAt };
}

async function verifySpaceReady(node: TinyCloudNode): Promise<boolean> {
  try {
    await listAll(node.kv, k.mePrefix);
    return true;
  } catch (error) {
    if (/space not found/i.test(String((error as Error).message))) return false;
    throw error;
  }
}

/** Wait for a hosted space using the existing probe's error semantics. */
export async function waitForSpaceReady(
  probe: () => Promise<boolean>,
  options: { timeoutMs?: number; delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void>; now?: () => number; onWait?: (elapsedMs: number) => void } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 150_000;
  const delaysMs = options.delaysMs ?? [2000, 3000, 5000, 8000, 13000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + timeoutMs;
  let attempt = 0;
  for (;;) {
    if (await probe()) return true;
    const current = now();
    if (current >= deadline) return false;
    options.onWait?.(current - started);
    await sleep(Math.min(delaysMs[attempt++] ?? 15000, deadline - current));
  }
}

export function pendingSpaceError(profile: Profile): CourierError {
  return new CourierError(
    'no-space',
    `OpenKey is still setting up your TinyCloud "${COURIER_SPACE}" space on ${profile.host}. This can take a few minutes. Run \`${cmd('init --resume')}\` shortly; no new approval is needed. If it still isn't ready after a few minutes, run \`${cmd('init')}\` to approve again, and OpenKey will retry the setup.`,
  );
}

function noSpaceError(profile: Profile): CourierError {
  return new CourierError(
    'no-space',
    `Your TinyCloud "${COURIER_SPACE}" space is not set up on ${profile.host}, so the approved grant can't be used yet. Courier will not create it. If OpenKey auto-sign didn't host it, sign in once at the Share view (https://share.tinycloud.xyz) or, from a wallet profile, run \`tc space host ${COURIER_SPACE}\`. Then run \`${cmd('init --resume')}\`. No new approval is needed.`,
  );
}

function ownerGrant(payload: GrantPayload, expiresAt: Date): OwnerGrant {
  return {
    v: 1,
    delegationHeader: payload.delegationHeader,
    delegationCid: payload.delegationCid,
    spaceId: payload.spaceId,
    ownerDid: `did:pkh:eip155:${payload.chainId}:${payload.address}`,
    address: payload.address,
    chainId: payload.chainId,
    verificationMethod: payload.verificationMethod,
    siwe: payload.siwe,
    signature: payload.signature,
    expiresAt: expiresAt.toISOString(),
    receivedAt: new Date().toISOString(),
  };
}

function grantPayload(grant: OwnerGrant): GrantPayload {
  return {
    delegationHeader: grant.delegationHeader,
    delegationCid: grant.delegationCid,
    spaceId: grant.spaceId,
    address: grant.address,
    chainId: grant.chainId,
    siwe: grant.siwe,
    signature: grant.signature,
    verificationMethod: grant.verificationMethod,
  };
}

function applyGrantToProfile(profile: Profile, grant: OwnerGrant): void {
  profile.ownerDid = grant.ownerDid;
  profile.spaceId = grant.spaceId;
  profile.grantExpiresAt = grant.expiresAt;
}

export async function installGrant(profile: Profile, key: AgentKey, payload: GrantPayload): Promise<void> {
  const expectedSpace = ownerSpaceId(payload);
  if (payload.spaceId.toLowerCase() !== expectedSpace.toLowerCase()) {
    throw new CourierError('bad-grant', `Grant space ${payload.spaceId} is not ${COURIER_SPACE} for did:pkh:eip155:${payload.chainId}:${payload.address}.`);
  }
  const { node, expiresAt } = await restoreVerifiedGrant(profile, key, payload);
  const grant = ownerGrant(payload, expiresAt);
  saveGrant(grant);
  applyGrantToProfile(profile, grant);
  if (!(await verifySpaceReady(node))) {
    const pending = payload.spacePending === true && payload.spaceReady === null;
    profile.status = 'awaiting-space';
    if (pending) profile.spacePending = true;
    else delete profile.spacePending;
    saveProfile(profile);
    if (!pending) throw noSpaceError(profile);
    console.error(`OpenKey is setting up your TinyCloud "${COURIER_SPACE}" space; waiting up to 2.5 minutes…`);
    if (!(await waitForSpaceReady(() => verifySpaceReady(node)))) throw pendingSpaceError(profile);
  }
  profile.status = 'ready';
  delete profile.spacePending;
  saveProfile(profile);
}

export async function resumeGrant(profile: Profile, key: AgentKey): Promise<void> {
  const grant = loadGrant();
  if (!grant) throw new CourierError('no-grant', `No saved OpenKey grant to resume. Run \`${cmd('init')}\` and approve a grant first.`);
  if (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.now() >= Date.parse(grant.expiresAt)) {
    throw new CourierError('grant-expired', `The saved Courier grant expired; run \`${cmd('init')}\` and approve a new grant in OpenKey.`);
  }
  const payload = grantPayload(grant);
  if (payload.spaceId.toLowerCase() !== ownerSpaceId(payload).toLowerCase()) {
    throw new CourierError('bad-grant', `Saved grant space is not ${COURIER_SPACE}.`);
  }
  const { node } = await restoreVerifiedGrant(profile, key, payload);
  const ready = profile.spacePending
    ? await waitForSpaceReady(() => verifySpaceReady(node), { timeoutMs: 60_000 })
    : await verifySpaceReady(node);
  if (!ready) {
    profile.status = 'awaiting-space';
    saveProfile(profile);
    throw profile.spacePending ? pendingSpaceError(profile) : noSpaceError(profile);
  }
  profile.status = 'ready';
  delete profile.spacePending;
  applyGrantToProfile(profile, grant);
  saveProfile(profile);
}

export function courierGrantRequest(profile: Profile, key: AgentKey, expiry: string, options: { openkeyApiHost?: string } = {}): DelegateRequest {
  return {
    openkeyHost: profile.openkeyHost,
    openkeyApiHost: resolveOpenKeyApiHost({ flag: options.openkeyApiHost, env: process.env.COURIER_OPENKEY_API_HOST, openkeyHost: profile.openkeyHost }),
    did: key.did,
    publicJwk: key.jwk,
    host: profile.host,
    permissions: AGENT_GRANT,
    reason: 'Grant the Courier agent key restricted access to this owner space. It cannot write owner approvals or orders.',
    expiry,
  };
}
