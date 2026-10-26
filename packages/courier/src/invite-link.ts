import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { CourierError } from './errors.js';
import { isRecord } from './a2a.js';

/**
 * Invitation link codec and short-link store client (TC-712).
 * The invitation (artifact A plus a one-time key and permission) is sealed with AES-256-GCM under a random key that
 * travels only in the invitation string. The store holds opaque bytes; it never sees the key.
 * Sealed layout: nonce (12) | ciphertext | tag (16). Invitation string: `tcinvite1:<id>:<key>:<cid>`.
 */

const pkg: { version: string } = createRequire(import.meta.url)('../package.json');
const pkgVersion = pkg.version;
export const COURIER_USER_AGENT = `tinycloud-courier/${pkgVersion}`;

const DEFAULT_ORIGIN = 'https://share.tinycloud.xyz';
export const MAX_SEALED_BYTES = 131072;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'tcinvite1:';
const ID_RE = /^[a-z2-7]{26}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const CID_RE = /^bafkrei[a-z2-7]{52}$/;
const INVITE_RE = /^tcinvite1:([a-z2-7]{26}):([A-Za-z0-9_-]{43}):(bafkrei[a-z2-7]{52})$/;

export interface InviteParts {
  id: string;
  key: string;
  cid: string;
}

export interface UploadedInvite {
  id: string;
  cid: string;
  deleteToken: string;
}

/** Store origin. `COURIER_INVITE_ORIGIN` overrides the default (tests only). */
export function inviteOrigin(): string {
  return (process.env.COURIER_INVITE_ORIGIN?.trim() || DEFAULT_ORIGIN).replace(/\/+$/, '');
}

function bad(reason: string): CourierError {
  return new CourierError('bad-invite', `Invitation rejected: ${reason}`);
}

/** A key is canonical when it decodes to exactly 32 bytes and re-encodes to the same 43 characters. */
function isCanonicalKey(key: string): boolean {
  return KEY_RE.test(key) && Buffer.from(key, 'base64url').toString('base64url') === key;
}

/** RFC 4648 base32, lowercase, unpadded (multibase `b`). */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** CIDv1, raw codec, sha2-256: the content id of the exact bytes. */
export function cidOf(bytes: Uint8Array): string {
  const digest = createHash('sha256').update(bytes).digest();
  return `b${base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]))}`;
}

/** Seals plaintext under a fresh random key and nonce. The key is returned as unpadded base64url. */
export function sealInvitation(plain: Uint8Array): { key: string; sealed: Uint8Array } {
  const key = randomBytes(KEY_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { key: key.toString('base64url'), sealed: Buffer.concat([nonce, ciphertext, tag]) };
}

/** Opens a sealed invitation. Any tamper or wrong key throws `bad-invite`; no partial output is returned. */
export function openInvitation(sealed: Uint8Array, key: string): Uint8Array {
  if (!isCanonicalKey(key)) throw bad('key is malformed');
  if (sealed.byteLength < NONCE_BYTES + TAG_BYTES) throw bad('sealed data is too short');
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const nonce = buf.subarray(0, NONCE_BYTES);
  const ciphertext = buf.subarray(NONCE_BYTES, buf.byteLength - TAG_BYTES);
  const tag = buf.subarray(buf.byteLength - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return new Uint8Array(plain);
  } catch {
    throw bad('sealed data does not open with this key');
  }
}

/** Store error mapping. Status text is the only detail; response bodies and tokens are never included. */
function statusError(op: 'upload' | 'fetch' | 'delete', status: number): CourierError {
  if (status === 429) return new CourierError('invite-rate-limited', `${op}: invitation store is rate limiting requests (HTTP 429)`);
  if (status === 503) return new CourierError('invite-unavailable', `${op}: invitation store is unavailable (HTTP 503)`);
  if (status === 404 && op !== 'upload') return new CourierError('invite-gone', `${op}: invitation is gone (HTTP 404)`);
  return new CourierError('invite-store-error', `${op}: invitation store returned HTTP ${status}`);
}

async function send(op: 'upload' | 'fetch' | 'delete', url: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('user-agent', COURIER_USER_AGENT);
  try {
    return await fetch(url, { ...init, headers });
  } catch (error) {
    throw new CourierError('invite-unreachable', `${op}: could not reach the invitation store: ${(error as Error).message}`);
  }
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/** Uploads sealed bytes; the store's returned cid must equal the local content id. */
export async function uploadSealed(origin: string, sealed: Uint8Array, expiresAt: Date): Promise<UploadedInvite> {
  if (sealed.byteLength > MAX_SEALED_BYTES) {
    throw new CourierError('invite-too-large', `Sealed invitation is ${sealed.byteLength} bytes; the store accepts at most ${MAX_SEALED_BYTES}.`);
  }
  const cid = cidOf(sealed);
  const res = await send('upload', `${origin}/api/share-links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ciphertext: Buffer.from(sealed).toString('base64url'), expiresAt: expiresAt.toISOString() }),
  });
  if (res.status !== 201) {
    await discard(res);
    throw statusError('upload', res.status);
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!isRecord(body) || typeof body.id !== 'string' || typeof body.cid !== 'string' || typeof body.deleteToken !== 'string') {
    throw new CourierError('invite-store-error', 'upload: invitation store returned an unexpected response');
  }
  if (!ID_RE.test(body.id)) throw new CourierError('invite-store-error', 'upload: invitation store returned a malformed id');
  if (body.cid !== cid) throw new CourierError('invite-store-error', 'upload: invitation store returned a content id that does not match the sealed bytes');
  if (body.deleteToken.length === 0) throw new CourierError('invite-store-error', 'upload: invitation store returned no delete token');
  return { id: body.id, cid, deleteToken: body.deleteToken };
}

/** Fetches sealed bytes and checks their content id before returning them. The store's cid is not a trust root. */
export async function fetchSealed(origin: string, id: string, expectedCid: string): Promise<Uint8Array> {
  if (!ID_RE.test(id)) throw bad('id is malformed');
  const res = await send('fetch', `${origin}/api/share-links/${id}`, { method: 'GET' });
  if (res.status !== 200) {
    await discard(res);
    throw statusError('fetch', res.status);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_SEALED_BYTES) throw bad('stored data is too large');
  if (cidOf(bytes) !== expectedCid) throw bad('content id does not match the invitation string');
  return bytes;
}

/** Deletes a stored invitation with its delete token. The token is never placed in an error message. */
export async function deleteSealed(origin: string, id: string, deleteToken: string): Promise<void> {
  if (!ID_RE.test(id)) throw bad('id is malformed');
  const res = await send('delete', `${origin}/api/share-links/${id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${deleteToken}` },
  });
  if (res.status !== 204) {
    await discard(res);
    throw statusError('delete', res.status);
  }
}

/** Builds `tcinvite1:<id>:<key>:<cid>`. Inputs are validated with the same rules the parser uses. */
export function formatInviteString({ id, key, cid }: InviteParts): string {
  if (!ID_RE.test(id)) throw bad('id is malformed');
  if (!isCanonicalKey(key)) throw bad('key is malformed');
  if (!CID_RE.test(cid)) throw bad('content id is malformed');
  return `${PREFIX}${id}:${key}:${cid}`;
}

/** Parses an invitation string. Surrounding whitespace is trimmed; anything else that does not match throws `bad-invite`. */
export function parseInviteString(input: string): InviteParts {
  if (typeof input !== 'string') throw bad('not a string');
  const match = INVITE_RE.exec(input.trim());
  if (!match) throw bad('not an invitation string (expected tcinvite1:<id>:<key>:<cid>)');
  const [, id, key, cid] = match;
  if (!isCanonicalKey(key)) throw bad('key is malformed');
  return { id, key, cid };
}
