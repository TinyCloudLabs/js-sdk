import { CourierError } from './errors.js';
import { isEd25519DidKey } from './did-key.js';
import { PREFIX } from './keys.js';
import { HANDLE } from './request.js';
import { validateArtifactIdentity, type PairArtifact } from './pairing.js';

/**
 * Invitation documents, TC-712 B2. Pure: no I/O, no SDK calls.
 *   InviteBlob: sealed inside the short-link invitation. Carries artifact A, the meeting folder, and the one-time key.
 *   Hello:      invitee → inviter, written to `in/hello.json` in the meeting folder. Carries artifact B.
 *   Welcome:    inviter → invitee, written under `out/`. Carries artifact C, or a rejection with no artifact.
 * Parsers reject unknown keys, missing keys, wrong types, control characters, duplicate keys, and oversize input.
 * Every failure is CourierError('bad-invite-file', reason). Reasons name fields; they never echo values, so keys never reach logs.
 */

export const INVITE_BLOB_MAX_BYTES = 128 * 1024;
export const CREDENTIAL_MAX_BYTES = 16 * 1024;
export const POSSESSION_MAX_BYTES = 2 * 1024;
// Whole-Hello cap: credential + possession + one artifact B (delegation-sized) allowance.
export const HELLO_MAX_BYTES = CREDENTIAL_MAX_BYTES + POSSESSION_MAX_BYTES + 16 * 1024;
export const WELCOME_MAX_BYTES = 16 * 1024;
export const DELEGATION_MAX_BYTES = 16 * 1024;

const INVITE_ID = /^[a-z2-7]{26}$/;
const CLAIMED_LABEL = /^[A-Za-z0-9 ._@-]{1,64}$/;
const B64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PKH_EIP155 = /^did:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40})$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Welcome tiers. `trusted-requested` records that the box owner was asked for trusted status; it grants nothing. Trust is set only by the owner's peers file.
const TIERS = ['strict', 'trusted-requested', 'rejected'] as const;
const MAX_NESTING = 8;

export type Tier = (typeof TIERS)[number];

export type RequestedTier = 'strict' | 'trusted';

export interface OneTimeKey {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  d: string;
}

export interface Permissions {
  put: string;
  read: string;
  hooks: string;
}

export interface InviteBlob {
  v: 1;
  inviteId: string;
  host: string;
  spaceId: string;
  folder: string;
  helloKey: string;
  outPrefix: string;
  oneTimeKey: OneTimeKey;
  permissions: Permissions;
  artifactA: PairArtifact;
  expiresAt: string;
  /** The did:key that signs the link. The reader refuses the invitation unless it equals the link's own signer. */
  issuer: string;
  /** Hash of the invited address (see `invite-email-hash.ts`), not the address. */
  expectEmailHash: string;
  /** Owner DID the invitee must match, or null for any owner. */
  expectOwner: string | null;
  /** Requested tier only. The paired peer starts strict; the owner confirms trusted by hand. */
  tier: RequestedTier;
}

export interface Hello {
  v: 1;
  inviteId: string;
  artifactB: PairArtifact;
  claimedLabel: string;
  credential?: string;
  possession?: string;
  sentAt: string;
}

export interface Welcome {
  v: 1;
  inviteId: string;
  /** The owner's decision. A self-service invite never makes the peer trusted; only the owner confirms trusted by hand. */
  tier: Tier;
  artifactC?: PairArtifact;
  sentAt: string;
}

/** The meeting folder for an invite, inside the inviter's space: `xyz.tinycloud.courier/to/_invites/<inviteId>/`. */
export function inviteFolder(inviteId: string): string {
  return `${PREFIX}/to/_invites/${inviteId}/`;
}

export function parseInviteBlob(text: string, now: number = Date.now()): InviteBlob {
  const b = parseStrict(text, INVITE_BLOB_MAX_BYTES);
  exactKeys(b, 'invite', ['v', 'inviteId', 'host', 'spaceId', 'folder', 'helloKey', 'outPrefix', 'oneTimeKey', 'permissions', 'artifactA', 'expiresAt', 'issuer', 'expectEmailHash', 'expectOwner', 'tier']);
  if (b.v !== 1) fail('invite: v must be 1');
  const inviteId = str(b.inviteId, 'inviteId', 26, INVITE_ID);
  const folder = inviteFolder(inviteId);
  if (b.folder !== folder) fail('folder is not the invite meeting folder');
  if (b.helloKey !== `${folder}in/hello.json`) fail('helloKey is not the exact hello key of the invite folder');
  if (b.outPrefix !== `${folder}out/`) fail('outPrefix is not the out/ prefix of the invite folder');
  const artifactA = checkArtifact(b.artifactA, 'A', 'artifactA');
  const spaceId = str(b.spaceId, 'spaceId', 256);
  if (artifactA.spaceId !== spaceId) fail('spaceId does not match artifactA');
  const expiresAt = isoUtc(b.expiresAt, 'expiresAt');
  const issuer = typeof b.issuer === 'string' && isEd25519DidKey(b.issuer) ? b.issuer : fail('issuer must be an Ed25519 did:key');
  const expectEmailHash = emailHash(b.expectEmailHash, 'expectEmailHash');
  const expectOwner = expectOwnerField(b.expectOwner);
  const tier = requestedTierField(b.tier);
  if (Date.parse(expiresAt) <= now) fail('invite is expired');
  return {
    v: 1,
    inviteId,
    host: httpsUrl(b.host, 'host'),
    spaceId,
    folder,
    helloKey: `${folder}in/hello.json`,
    outPrefix: `${folder}out/`,
    oneTimeKey: parseOneTimeKey(b.oneTimeKey),
    permissions: parsePermissions(b.permissions),
    artifactA,
    expiresAt,
    issuer,
    expectEmailHash,
    expectOwner,
    tier,
  };
}

/** Three serialized delegation strings (put, read, hooks), each at most DELEGATION_MAX_BYTES; exact key set. */
function parsePermissions(value: unknown): Permissions {
  const p = asRecord(value, 'permissions');
  exactKeys(p, 'permissions', ['put', 'read', 'hooks']);
  return {
    put: str(p.put, 'permissions.put', DELEGATION_MAX_BYTES),
    read: str(p.read, 'permissions.read', DELEGATION_MAX_BYTES),
    hooks: str(p.hooks, 'permissions.hooks', DELEGATION_MAX_BYTES),
  };
}

export function parseHello(text: string): Hello {
  const h = parseStrict(text, HELLO_MAX_BYTES);
  exactKeys(h, 'hello', ['v', 'inviteId', 'artifactB', 'claimedLabel', 'sentAt'], ['credential', 'possession']);
  if (h.v !== 1) fail('hello: v must be 1');
  return {
    v: 1,
    inviteId: str(h.inviteId, 'inviteId', 26, INVITE_ID),
    artifactB: checkArtifact(h.artifactB, 'B', 'artifactB'),
    claimedLabel: str(h.claimedLabel, 'claimedLabel', 64, CLAIMED_LABEL),
    sentAt: isoUtc(h.sentAt, 'sentAt'),
    ...(Object.hasOwn(h, 'credential') ? { credential: str(h.credential, 'credential', CREDENTIAL_MAX_BYTES) } : {}),
    ...(Object.hasOwn(h, 'possession') ? { possession: str(h.possession, 'possession', POSSESSION_MAX_BYTES) } : {}),
  };
}

export function parseWelcome(text: string): Welcome {
  const w = parseStrict(text, WELCOME_MAX_BYTES);
  if (typeof w.tier !== 'string' || !(TIERS as readonly unknown[]).includes(w.tier)) fail('tier must be strict, trusted-requested or rejected');
  const tier = w.tier as Tier;
  exactKeys(w, 'welcome', tier === 'rejected' ? ['v', 'inviteId', 'tier', 'sentAt'] : ['v', 'inviteId', 'tier', 'artifactC', 'sentAt']);
  if (w.v !== 1) fail('welcome: v must be 1');
  return {
    v: 1,
    inviteId: str(w.inviteId, 'inviteId', 26, INVITE_ID),
    tier,
    ...(tier === 'rejected' ? {} : { artifactC: checkArtifact(w.artifactC, 'C', 'artifactC') }),
    sentAt: isoUtc(w.sentAt, 'sentAt'),
  };
}

/** The 43-character base64url hash of an invited address, in its one canonical spelling. */
export function emailHash(value: unknown, where: string): string {
  const s = str(value, where, 43, B64URL_32_BYTES);
  if (Buffer.from(s, 'base64url').toString('base64url') !== s) fail(`${where} is not canonical base64url`);
  return s;
}

/** Lowercase email address, at most 254 bytes. Format check only: ownership is proven by the credential, not here. */
export function emailAddress(value: unknown, where: string): string {
  const s = str(value, where, 254, /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  if (s !== s.toLowerCase()) fail(`${where} must be lowercase`);
  return s;
}

/** True when the value is a `did:pkh:eip155:<chain>:0x<address>` DID. Shape only; ownership is proven elsewhere. */
export function isOwnerDid(value: string): boolean {
  return PKH_EIP155.test(value);
}

function expectOwnerField(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !isOwnerDid(value)) fail('expectOwner must be null or a did:pkh:eip155 DID');
  return value;
}

function requestedTierField(value: unknown): RequestedTier {
  if (value !== 'strict' && value !== 'trusted') fail('tier must be strict or trusted');
  return value;
}

/** True when both DIDs are `did:pkh:eip155:<chain>:0x<address>`, on the same chain, with the same address (case-insensitive). */
export function ownerMatches(expectedDid: string, helloOwnerDid: string): boolean {
  if (typeof expectedDid !== 'string' || typeof helloOwnerDid !== 'string') return false;
  const expected = PKH_EIP155.exec(expectedDid);
  const actual = PKH_EIP155.exec(helloOwnerDid);
  if (!expected || !actual) return false;
  return expected[1] === actual[1] && expected[2].toLowerCase() === actual[2].toLowerCase();
}

function parseOneTimeKey(value: unknown): OneTimeKey {
  const k = asRecord(value, 'oneTimeKey');
  exactKeys(k, 'oneTimeKey', ['kty', 'crv', 'x', 'd']);
  if (k.kty !== 'OKP' || k.crv !== 'Ed25519') fail('oneTimeKey must be an Ed25519 OKP key');
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: str(k.x, 'oneTimeKey.x', 43, B64URL_32_BYTES),
    d: str(k.d, 'oneTimeKey.d', 43, B64URL_32_BYTES),
  };
}

function checkArtifact(value: unknown, step: 'A' | 'B' | 'C', where: string): PairArtifact {
  const a = asRecord(value, where);
  const base = ['type', 'v', 'step', 'from', 'spaceId', 'peer', 'callMe', 'issuedAt'];
  exactKeys(a, where, step === 'A' ? base : [...base, 'delegation', 'delegationExpiresAt']);
  if (a.type !== 'courier-pair' || a.v !== 0 || a.step !== step) fail(`${where} must be a courier-pair v0 step ${step} artifact`);
  const from = asRecord(a.from, `${where}.from`);
  exactKeys(from, `${where}.from`, ['owner', 'courier'], ['label']);
  const artifact: PairArtifact = {
    type: 'courier-pair',
    v: 0,
    step,
    from: {
      owner: str(from.owner, `${where}.from.owner`, 128),
      courier: str(from.courier, `${where}.from.courier`, 256),
      ...(Object.hasOwn(from, 'label') ? { label: str(from.label, `${where}.from.label`, 200) } : {}),
    },
    spaceId: str(a.spaceId, `${where}.spaceId`, 256),
    peer: str(a.peer, `${where}.peer`, 64, HANDLE),
    callMe: str(a.callMe, `${where}.callMe`, 64, HANDLE),
    issuedAt: isoUtc(a.issuedAt, `${where}.issuedAt`),
    ...(step === 'A'
      ? {}
      : {
          delegation: str(a.delegation, `${where}.delegation`, DELEGATION_MAX_BYTES),
          delegationExpiresAt: isoUtc(a.delegationExpiresAt, `${where}.delegationExpiresAt`),
        }),
  };
  try {
    validateArtifactIdentity(artifact);
  } catch (e) {
    fail(`${where}: ${(e as Error).message}`);
  }
  return artifact;
}

function httpsUrl(value: unknown, where: string): string {
  const s = str(value, where, 2048);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    fail(`${where} is not a URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail(`${where} must be a plain https URL`);
  return s;
}

/** Non-empty string, at most `maxBytes` UTF-8 bytes, optionally matching `pattern`. */
function str(value: unknown, where: string, maxBytes: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${where} must be a non-empty string`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) fail(`${where} is over ${maxBytes} bytes`);
  if (pattern && !pattern.test(value)) fail(`${where} has an invalid format`);
  return value;
}

function isoUtc(value: unknown, where: string): string {
  if (typeof value !== 'string' || !ISO_UTC_MS.test(value)) fail(`${where} must be an ISO UTC time with milliseconds`);
  const t = Date.parse(value);
  if (Number.isNaN(t) || new Date(t).toISOString() !== value) fail(`${where} is not a real date`);
  return value;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(obj: Record<string, unknown>, where: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of Object.keys(obj)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`${where} has unknown key "${key.slice(0, 40)}"`);
  }
  for (const key of required) {
    if (!Object.hasOwn(obj, key)) fail(`${where} is missing "${key}"`);
  }
}

/** Size cap, JSON syntax, duplicate keys, control characters; then the top-level object. */
function parseStrict(text: unknown, maxBytes: number): Record<string, unknown> {
  if (typeof text !== 'string') fail('invite file must be text');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) fail(`invite file is over ${maxBytes} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('invite file is not valid JSON');
  }
  assertNoDuplicateKeys(text);
  assertNoControlChars(value);
  return asRecord(value, 'invite file');
}

/**
 * Scans JSON text that already parsed, rejecting a key that appears twice in one object.
 * `JSON.parse` keeps only the last duplicate, so the scan must run on the raw text.
 */
function assertNoDuplicateKeys(text: string): void {
  type Frame = { object: true; keys: Set<string> } | { object: false };
  const frames: Frame[] = [];
  let expectKey = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = frames.at(-1);
      if (top?.object && expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) fail('invite file has a duplicate key');
        top.keys.add(key);
      }
      expectKey = false;
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '[') {
      if (frames.length >= MAX_NESTING) fail('invite file is nested too deeply');
      frames.push(c === '{' ? { object: true, keys: new Set() } : { object: false });
      expectKey = c === '{';
    } else if (c === '}' || c === ']') {
      frames.pop();
      expectKey = false;
    } else if (c === ',') {
      expectKey = frames.at(-1)?.object === true;
    } else if (c === ':') {
      expectKey = false;
    }
    i++;
  }
}

function assertNoControlChars(value: unknown): void {
  if (typeof value === 'string') {
    if (CONTROL.test(value)) fail('invite file contains a control character');
  } else if (Array.isArray(value)) {
    for (const item of value) assertNoControlChars(item);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (CONTROL.test(key)) fail('invite file contains a control character');
      assertNoControlChars(item);
    }
  }
}

function fail(reason: string): never {
  throw new CourierError('bad-invite-file', reason);
}
